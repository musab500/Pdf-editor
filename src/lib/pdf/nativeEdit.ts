import { PDFDocument, PDFPage } from "pdf-lib";
import { CSObject, CSOperation, serializeContentStream } from "./contentStream";
import { FontCache, FontInfo } from "./fontInfo";
import { N } from "./pdfObjects";
import { PageTextAnalysis, TextLine, TextShow, analyzePageText } from "./textAnalysis";

/**
 * Mode A — true editing of existing PDF text.
 *
 * Strategy: a "line" is a run of text-showing operators in one BT/ET block that
 * share font, size, color and baseline. Its first operator is rewritten with the
 * new text, re-encoded in the ORIGINAL font; the remaining operators are emptied
 * and replaced with an equivalent horizontal displacement, so every glyph that
 * follows on the page stays exactly where it was. No other byte of the content
 * stream changes.
 *
 * The edit is only allowed when it can be done safely (see checkNativeEdit).
 */

const COMPLEX_SCRIPT_RE = /[֐-ࣿऀ-෿฀-࿿က-႟ក-៿יִ-﷿ﹰ-﻿]/;

export interface NativeEditCheck {
  ok: boolean;
  reasons: string[];
  warnings: string[];
  /** width of new text relative to the original line width (1 = same) */
  widthRatio?: number;
}

export interface FontUsage {
  /** codes already drawn somewhere with this font object */
  get(font: FontInfo): Set<number>;
}

export function collectFontUsage(analyses: PageTextAnalysis[]): FontUsage {
  const m = new Map<FontInfo, Set<number>>();
  for (const a of analyses)
    for (const s of a.shows) {
      if (!s.font) continue;
      let set = m.get(s.font);
      if (!set) m.set(s.font, (set = new Set()));
      for (const c of s.codes) set.add(c);
    }
  return { get: (f) => m.get(f) ?? new Set() };
}

function showAdvance(show: TextShow, op: CSOperation): number {
  // displacement in unscaled text space (before Tm), i.e. the tx accumulated by the show
  const font = show.font;
  const items: CSObject[] =
    op.op === "TJ" ? (op.operands[0]?.t === "arr" ? op.operands[0].items : []) : op.op === '"' ? op.operands.slice(2, 3) : op.operands.slice(0, 1);
  let tx = 0;
  for (const it of items) {
    if (it.t === "num") tx += (-it.v / 1000) * show.fontSize * show.horizontalScale;
    else if (it.t === "str" && font) {
      for (const g of font.decode(it.bytes)) {
        const isSpace = g.bytes === 1 && g.code === 32;
        tx += ((g.width / 1000) * show.fontSize + show.charSpacing + (isSpace ? show.wordSpacing : 0)) * show.horizontalScale;
      }
    }
  }
  return tx;
}

interface Plan {
  items: CSObject[];
  newAdvance: number;
}

function planText(font: FontInfo, show: TextShow, text: string, usage: FontUsage | undefined): Plan | { error: string } {
  const items: CSObject[] = [];
  let pending: number[] = [];
  let newAdvance = 0;
  const used = usage?.get(font);
  const flush = () => {
    if (pending.length) items.push({ t: "str", bytes: font.encodeToBytes(pending), hex: true });
    pending = [];
  };
  const k = show.fontSize * show.horizontalScale;
  for (const ch of Array.from(text)) {
    const r = font.encode(ch);
    if ("error" in r) {
      if (ch === " ") {
        // the font has no space glyph (common in subset fonts): emit a 0.25 em positioning gap instead
        flush();
        items.push({ t: "num", v: -250 });
        newAdvance += 0.25 * k;
        continue;
      }
      return { error: r.error };
    }
    const code = r.codes[0];
    if (!font.hasCompleteGlyphSet) {
      if (!used?.has(code)) {
        if (ch === " ") {
          flush();
          items.push({ t: "num", v: -250 });
          newAdvance += 0.25 * k;
          continue;
        }
        return {
          error: `The original font “${font.family}” is an embedded subset; the glyph for “${ch}” is not used anywhere in this document, so it is probably not included in the font.`,
        };
      }
    }
    if (!font.isCID && !font.standard14 && !font.hasExplicitWidth(code) && ch !== " ") {
      return { error: `The original font has no width information for “${ch}”, so the result could not be positioned reliably.` };
    }
    if (font.hasExplicitWidth(code) && font.widthOf(code) === 0 && ch !== " ") {
      return { error: `The glyph for “${ch}” has zero width in the original font.` };
    }
    pending.push(code);
    const isSpace = font.codeLength() === 1 && code === 32;
    newAdvance += ((font.widthOf(code) / 1000) * show.fontSize + show.charSpacing + (isSpace ? show.wordSpacing : 0)) * show.horizontalScale;
  }
  flush();
  return { items, newAdvance };
}

export function checkNativeEdit(analysis: PageTextAnalysis, line: TextLine, newText: string, usage?: FontUsage): NativeEditCheck {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (analysis.parseError) reasons.push(`The page content could not be parsed safely (${analysis.parseError}).`);
  const font = line.font;
  if (!font) reasons.push("The font used by this text could not be found in the page resources.");
  if (line.inXObject)
    reasons.push("This text is stored inside an embedded form object (XObject), as PDFs from design tools such as Canva often do; it cannot be rewritten in place. Use visual replacement instead.");
  if (line.invisible) reasons.push("This is invisible text (for example an OCR layer); editing it would not change what you see.");
  if (font) reasons.push(...font.editBlockers);
  if (font?.vertical) reasons.push("Vertical text is not supported.");
  if (line.text.includes("�")) reasons.push("Some characters of the original text could not be identified (no Unicode mapping).");
  if (COMPLEX_SCRIPT_RE.test(line.text) || COMPLEX_SCRIPT_RE.test(newText))
    reasons.push("Arabic and other right-to-left or complex scripts are stored as shaped glyphs in visual order; they cannot be safely re-encoded in place. Use visual replacement instead.");
  if (/[\r\n]/.test(newText)) reasons.push("Native editing replaces a single line; multi-line text needs visual replacement.");
  if (newText.length === 0) warnings.push("The text will be removed from the page content.");
  let widthRatio: number | undefined;
  if (!reasons.length && font) {
    const first = line.shows[0];
    const plan = planText(font, first, newText, usage);
    if ("error" in plan) reasons.push(plan.error);
    else {
      const oldAdvance = line.shows.reduce((n, s) => n + showAdvance(s, analysis.ops[s.opIndex]), 0);
      widthRatio = oldAdvance > 0 ? plan.newAdvance / oldAdvance : 1;
      if (widthRatio > 1.02)
        warnings.push(`The new text is ${Math.round((widthRatio - 1) * 100)}% wider than the original. Following text is not reflowed, so it may overlap.`);
    }
  }
  if (font && !font.embedded && !font.standard14 && !reasons.length)
    warnings.push(`The font “${font.family}” is not embedded; viewers substitute a similar font, as they already did for the original text.`);
  return { ok: reasons.length === 0, reasons, warnings, widthRatio };
}

export interface NativeEditRequest {
  lineId: string;
  text: string;
}

export interface NativeEditResult {
  lineId: string;
  ok: boolean;
  reasons: string[];
}


function rewriteShow(op: CSOperation, arr: CSObject[]) {
  const tj = { op: "TJ", operands: [{ t: "arr", items: arr } as CSObject] };
  if (op.op === "Tj" || op.op === "TJ") op.replacement = [tj];
  else if (op.op === "'") op.replacement = [{ op: "T*", operands: [] }, tj];
  else if (op.op === '"')
    op.replacement = [{ op: "Tw", operands: [op.operands[0]] }, { op: "Tc", operands: [op.operands[1]] }, { op: "T*", operands: [] }, tj];
}

/**
 * Apply native edits to one page of `doc` (mutates the document). Every edit is
 * re-validated; failing edits are skipped and reported, never half-applied.
 */
export function applyNativeEdits(
  doc: PDFDocument,
  page: PDFPage,
  edits: NativeEditRequest[],
  options: { usage?: FontUsage; fontCache?: FontCache } = {},
): NativeEditResult[] {
  const ctx = doc.context;
  const fontCache = options.fontCache ?? new FontCache(ctx);
  const analysis = analyzePageText(ctx, page, fontCache);
  const usage = options.usage ?? collectFontUsage([analysis]);
  const results: NativeEditResult[] = [];
  let changed = false;
  for (const e of edits) {
    const line = analysis.lines.find((l) => l.id === e.lineId);
    if (!line) {
      results.push({ lineId: e.lineId, ok: false, reasons: ["The original text could not be located again in the page content."] });
      continue;
    }
    if (line.text === e.text) {
      results.push({ lineId: e.lineId, ok: true, reasons: [] });
      continue;
    }
    const check = checkNativeEdit(analysis, line, e.text, usage);
    if (!check.ok) {
      results.push({ lineId: e.lineId, ok: false, reasons: check.reasons });
      continue;
    }
    const font = line.font!;
    const first = line.shows[0];
    const plan = planText(font, first, e.text, usage);
    if ("error" in plan) {
      results.push({ lineId: e.lineId, ok: false, reasons: [plan.error] });
      continue;
    }
    const k = first.fontSize * first.horizontalScale;
    const firstOp = analysis.ops[first.opIndex];
    const oldFirst = showAdvance(first, firstOp);
    const items = [...plan.items];
    const comp = oldFirst - plan.newAdvance;
    if (Math.abs(comp) > 1e-6 && k !== 0) items.push({ t: "num", v: (-comp * 1000) / k });
    rewriteShow(firstOp, items);
    for (const s of line.shows.slice(1)) {
      const op = analysis.ops[s.opIndex];
      const adv = showAdvance(s, op);
      const kk = s.fontSize * s.horizontalScale;
      const arr: CSObject[] = Math.abs(adv) > 1e-6 && kk !== 0 ? [{ t: "num", v: (-adv * 1000) / kk }] : [];
      rewriteShow(op, arr);
    }
    changed = true;
    results.push({ lineId: e.lineId, ok: true, reasons: [] });
  }
  if (changed) {
    const bytes = serializeContentStream(analysis.source, analysis.ops);
    const stream = ctx.flateStream(bytes);
    const ref = ctx.register(stream);
    page.node.set(N("Contents"), ref);
  }
  return results;
}
