import {
  BlendMode,
  LineCapStyle,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFName,
  PDFPage,
  PDFRef,
  PDFTextField,
  PDFDropdown,
  PDFOptionList,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  PDFOperator,
  beginMarkedContent,
  endMarkedContent,
} from "pdf-lib";
import type { Asset, EditorDoc, EditorObject, PageEntry, ReplaceObj, TextObj } from "../model/types";
import { FaceRegistry, fontkit } from "../text/fontFaces";
import { layoutText } from "../text/layout";
import { FontEmbedder, textOperators } from "./drawText";
import { annotationPageIndex, applyFormValues } from "./forms";
import { collectGarbage, detachRemovedPages } from "./gc";
import { NativeEditResult, applyNativeEdits, collectFontUsage } from "./nativeEdit";
import { analyzePageText } from "./textAnalysis";
import { FontCache } from "./fontInfo";
import { N, asArray, asDict, dictGet } from "./pdfObjects";

export const TEXT_PADDING = 2;
export const REPLACE_PADDING = 1;

export interface ExportInput {
  primarySourceId: string;
  sources: Record<string, Uint8Array>;
  doc: EditorDoc;
  assets: Record<string, Asset>;
  /** export only these pages, in this order (default: all pages) */
  pageIds?: string[];
  title?: string;
}

export interface ExportReport {
  warnings: string[];
  nativeResults: (NativeEditResult & { sourceId: string; pageIndex: number })[];
  pageCount: number;
}

export interface ExportResult {
  bytes: Uint8Array;
  report: ExportReport;
}

export class ExportCancelled extends Error {
  constructor() {
    super("Export cancelled");
  }
}

export type ProgressFn = (fraction: number, message: string) => void;

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const color = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return rgb(r, g, b);
};

/** Load a source with pdf-lib; throws a readable error for encrypted files. */
export async function loadForEditing(bytes: Uint8Array): Promise<PDFDocument> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  return doc;
}

async function applyEditsForSource(
  doc: PDFDocument,
  sourceId: string,
  edits: EditorDoc["nativeEdits"][string] | undefined,
  report: ExportReport,
) {
  if (!edits || !Object.keys(edits).length) return;
  const cache = new FontCache(doc.context);
  const pages = doc.getPages();
  // glyph-usage across the whole source (used to decide if a subset font contains a glyph)
  const usage = collectFontUsage(pages.slice(0, 400).map((p) => analyzePageText(doc.context, p, cache)));
  for (const [idxStr, lines] of Object.entries(edits)) {
    const idx = Number(idxStr);
    const page = pages[idx];
    if (!page) continue;
    const reqs = Object.entries(lines).map(([lineId, e]) => ({ lineId, text: e.text }));
    const results = applyNativeEdits(doc, page, reqs, { usage, fontCache: cache });
    for (const r of results) {
      report.nativeResults.push({ ...r, sourceId, pageIndex: idx });
      if (!r.ok) report.warnings.push(`A native text edit on page ${idx + 1} could not be applied: ${r.reasons.join(" ")}`);
    }
  }
}

/** Prepare a page that will be copied into another document (imported/duplicated). */
function sanitizeForCopy(doc: PDFDocument, report: ExportReport) {
  try {
    const form = doc.getForm();
    if (form.getFields().length) {
      form.flatten({ updateFieldAppearances: false });
      report.warnings.push("Form fields on imported or duplicated pages were flattened into the page content.");
    }
  } catch {
    /* no form */
  }
  for (const p of doc.getPages()) {
    const annots = p.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = asDict(doc.context.lookup(annots.get(i)));
      if (!a) continue;
      a.delete(N("P"));
      a.delete(N("Parent"));
      // internal links point at pages of the old document; keep external URI links only
      const action = asDict(dictGet(a, "A"));
      const s = action ? dictGet(action, "S")?.toString() : undefined;
      if (a.has(N("Dest")) || s === "/GoTo") {
        a.delete(N("Dest"));
        if (s === "/GoTo") a.delete(N("A"));
      }
      if (dictGet(a, "Subtype")?.toString() === "/Popup") annots.remove(i);
    }
  }
}

function viewBox(page: PDFPage): [number, number, number, number] {
  const c = page.getCropBox();
  const m = page.getMediaBox();
  const x0 = Math.max(c.x, m.x);
  const y0 = Math.max(c.y, m.y);
  const x1 = Math.min(c.x + c.width, m.x + m.width);
  const y1 = Math.min(c.y + c.height, m.y + m.height);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : [m.x, m.y, m.x + m.width, m.y + m.height];
}

class PageDrawer {
  private fontKeys = new Map<PDFFont, PDFName>();
  private wrapped = false;
  constructor(
    private out: PDFDocument,
    private page: PDFPage,
    private embedder: FontEmbedder,
    private faces: FaceRegistry,
    private images: Map<string, Promise<PDFImage>>,
    private assets: Record<string, Asset>,
    private report: ExportReport,
  ) {}

  private vb = () => viewBox(this.page);

  private ensureWrapped() {
    if (this.wrapped) return;
    this.wrapped = true;
    const ctx = this.out.context;
    if (this.page.node.Contents()) {
      // isolate the original content's graphics state from what we add
      this.page.node.wrapContentStreams(ctx.getPushGraphicsStateContentStream(), ctx.getPopGraphicsStateContentStream());
    }
  }

  private fontKey = (f: PDFFont) => {
    let k = this.fontKeys.get(f);
    if (!k) {
      k = this.page.node.newFontDictionary(f.name, f.ref);
      this.fontKeys.set(f, k);
    }
    return k;
  };

  private image(assetId: string): Promise<PDFImage> | undefined {
    const a = this.assets[assetId];
    if (!a) return undefined;
    let p = this.images.get(assetId);
    if (!p) {
      p = a.mime === "image/png" ? this.out.embedPng(a.bytes) : this.out.embedJpg(a.bytes);
      this.images.set(assetId, p);
    }
    return p;
  }

  async draw(obj: EditorObject) {
    this.ensureWrapped();
    const [x0, , , y1] = this.vb();
    const left = x0 + obj.x;
    const top = y1 - obj.y;
    const bottom = top - obj.h;
    const page = this.page;
    page.pushOperators(pushGraphicsState());
    if (obj.rotation) {
      const t = (-obj.rotation * Math.PI) / 180;
      const cx = left + obj.w / 2;
      const cy = top - obj.h / 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      page.pushOperators(concatTransformationMatrix(c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy));
    }
    switch (obj.kind) {
      case "text":
      case "replace":
        await this.drawText(obj, left, top, bottom);
        break;
      case "image": {
        const img = this.image(obj.assetId);
        if (!img) this.report.warnings.push("An image could not be found and was skipped.");
        else page.drawImage(await img, { x: left, y: bottom, width: obj.w, height: obj.h, opacity: obj.opacity });
        break;
      }
      case "ink": {
        for (const stroke of obj.strokes) {
          if (stroke.length < 2) continue;
          const path = stroke.map(([px, py], i) => `${i ? "L" : "M"}${(obj.x + px * obj.w).toFixed(2)} ${(obj.y + py * obj.h).toFixed(2)}`).join(" ");
          page.drawSvgPath(path, {
            x: x0,
            y: y1,
            borderColor: color(obj.color),
            borderWidth: obj.width,
            borderOpacity: obj.opacity,
            borderLineCap: LineCapStyle.Round,
          });
        }
        break;
      }
      case "rect":
        page.drawRectangle({
          x: left, y: bottom, width: obj.w, height: obj.h,
          color: obj.fill ? color(obj.fill) : undefined,
          borderColor: obj.stroke ? color(obj.stroke) : undefined,
          borderWidth: obj.stroke ? obj.strokeWidth : 0,
          opacity: obj.opacity, borderOpacity: obj.opacity,
        });
        break;
      case "ellipse":
        page.drawEllipse({
          x: left + obj.w / 2, y: bottom + obj.h / 2, xScale: obj.w / 2, yScale: obj.h / 2,
          color: obj.fill ? color(obj.fill) : undefined,
          borderColor: obj.stroke ? color(obj.stroke) : undefined,
          borderWidth: obj.stroke ? obj.strokeWidth : 0,
          opacity: obj.opacity, borderOpacity: obj.opacity,
        });
        break;
      case "line": {
        const ax = left + obj.p1[0] * obj.w, ay = top - obj.p1[1] * obj.h;
        const bx = left + obj.p2[0] * obj.w, by = top - obj.p2[1] * obj.h;
        page.drawLine({ start: { x: ax, y: ay }, end: { x: bx, y: by }, thickness: obj.strokeWidth, color: color(obj.stroke), opacity: obj.opacity, lineCap: LineCapStyle.Round });
        if (obj.arrow) {
          const ang = Math.atan2(by - ay, bx - ax);
          const len = Math.max(6, obj.strokeWidth * 4);
          for (const d of [Math.PI * 0.85, -Math.PI * 0.85]) {
            page.drawLine({
              start: { x: bx, y: by },
              end: { x: bx + len * Math.cos(ang + d), y: by + len * Math.sin(ang + d) },
              thickness: obj.strokeWidth, color: color(obj.stroke), opacity: obj.opacity, lineCap: LineCapStyle.Round,
            });
          }
        }
        break;
      }
      case "highlight":
        page.drawRectangle({ x: left, y: bottom, width: obj.w, height: obj.h, color: color(obj.color), opacity: obj.opacity, blendMode: BlendMode.Multiply });
        break;
    }
    page.pushOperators(popGraphicsState());
  }

  private async drawText(obj: TextObj | ReplaceObj, left: number, top: number, bottom: number) {
    const page = this.page;
    const pad = obj.kind === "replace" ? REPLACE_PADDING : TEXT_PADDING;
    if (obj.kind === "replace") {
      page.drawRectangle({ x: left, y: bottom, width: obj.w, height: obj.h, color: color(obj.cover), borderWidth: 0 });
    }
    if (!obj.text) return;
    const faces = await this.faces.chain(obj.family, obj.bold);
    if (!faces.length) throw new Error(`Font “${obj.family}” could not be loaded.`);
    const layout = layoutText(obj.text, faces, { width: obj.w - pad * 2, size: obj.size, lineHeight: obj.lineHeight, align: obj.align, dir: obj.dir });
    if (layout.missingChars.length)
      this.report.warnings.push(`Some characters have no glyph in the available fonts and may not display: ${layout.missingChars.join(" ")}`);
    const ops = await textOperators(
      { layout, left, top, padding: pad, size: obj.size, color: hexToRgb(obj.color), italic: obj.italic },
      this.embedder,
      this.fontKey,
    );
    // mark the text so assistive tech / extractors see it in logical order
    page.pushOperators(beginMarkedContent("Span"), ...ops, endMarkedContent());
  }
}

/** Build an appearance stream for a text field whose value needs Unicode/RTL shaping. */
async function unicodeFieldAppearance(out: PDFDocument, field: PDFTextField | PDFDropdown | PDFOptionList, faces: FaceRegistry, embedder: FontEmbedder) {
  const value = field instanceof PDFTextField ? (field.getText() ?? "") : field.getSelected().join(", ");
  const chain = await faces.chain("noto-sans", false);
  for (const widget of field.acroField.getWidgets()) {
    const r = widget.getRectangle();
    const multiline = field instanceof PDFTextField && field.isMultiline();
    const size = Math.max(6, Math.min(12, multiline ? 11 : r.height * 0.65));
    const layout = layoutText(value, chain, { width: r.width - 4, size, lineHeight: 1.15, align: "start", dir: "auto", wrap: multiline });
    const fontsDict = out.context.obj({});
    let i = 0;
    const keys = new Map<PDFFont, PDFName>();
    const top = multiline ? r.height : r.height / 2 + layout.height / 2;
    const ops = await textOperators({ layout, left: 0, top, padding: 2, size, color: [0, 0, 0], italic: false }, embedder, (f) => {
      let k = keys.get(f);
      if (!k) {
        k = PDFName.of(`F${i++}`);
        keys.set(f, k);
        fontsDict.set(k, f.ref);
      }
      return k;
    });
    const stream = out.context.formXObject(
      [PDFOperator.of("/Tx BMC" as never), pushGraphicsState(), ...ops, popGraphicsState(), PDFOperator.of("EMC" as never)],
      { BBox: [0, 0, r.width, r.height], Resources: { Font: fontsDict } },
    );
    widget.setNormalAppearance(out.context.register(stream));
  }
}

export async function exportPdf(
  input: ExportInput,
  faces: FaceRegistry,
  onProgress: ProgressFn = () => {},
  signal?: AbortSignal,
): Promise<ExportResult> {
  const check = () => {
    if (signal?.aborted) throw new ExportCancelled();
  };
  const report: ExportReport = { warnings: [], nativeResults: [], pageCount: 0 };
  const { doc } = input;
  const entries: PageEntry[] = input.pageIds
    ? input.pageIds.map((id) => doc.pages.find((p) => p.id === id)).filter((p): p is PageEntry => !!p)
    : doc.pages;
  if (!entries.length) throw new Error("There are no pages to export.");

  onProgress(0.05, "Loading document");
  const primaryBytes = input.sources[input.primarySourceId];
  if (!primaryBytes) throw new Error("The original document is missing.");
  const out = await loadForEditing(primaryBytes);
  check();
  onProgress(0.15, "Applying text edits");
  await applyEditsForSource(out, input.primarySourceId, doc.nativeEdits[input.primarySourceId], report);
  check();

  const originalPages = out.getPages();
  const originalRefs = originalPages.map((p) => p.ref.toString());

  // ---------------------------------------------------------------- form values (primary only)
  const keptPrimary = new Set<number>();
  for (const e of entries) if (e.origin.kind === "source" && e.origin.sourceId === input.primarySourceId) keptPrimary.add(e.origin.index);
  let unicodeFields: string[] = [];
  try {
    const form = out.getForm();
    if (Object.keys(doc.formValues).length) unicodeFields = applyFormValues(out, doc.formValues, (m) => report.warnings.push(m));
    // drop fields whose widgets all live on pages that are not exported
    const annotPages = annotationPageIndex(out);
    for (const f of form.getFields()) {
      const pagesOf = f.acroField
        .getWidgets()
        .map((w) => out.context.getObjectRef(w.dict))
        .map((r) => (r ? annotPages.get(r.toString()) : undefined));
      if (pagesOf.length && pagesOf.every((p) => p === undefined || !keptPrimary.has(p))) {
        try {
          form.removeField(f);
        } catch {
          report.warnings.push(`Form field “${f.getName()}” could not be removed cleanly.`);
        }
      }
    }
  } catch {
    /* documents without a form */
  }
  check();

  // ---------------------------------------------------------------- build page list
  onProgress(0.3, "Arranging pages");
  const usedPrimary = new Set<number>();
  const copyRequests = new Map<string, number[]>(); // sourceId → indices to copy (incl. primary duplicates)
  const plan: ({ kind: "orig"; index: number } | { kind: "copy"; sourceId: string; slot: number } | { kind: "blank"; w: number; h: number })[] = [];
  for (const e of entries) {
    if (e.origin.kind === "blank") plan.push({ kind: "blank", w: e.origin.width, h: e.origin.height });
    else if (e.origin.sourceId === input.primarySourceId && !usedPrimary.has(e.origin.index)) {
      usedPrimary.add(e.origin.index);
      plan.push({ kind: "orig", index: e.origin.index });
    } else {
      const list = copyRequests.get(e.origin.sourceId) ?? [];
      list.push(e.origin.index);
      copyRequests.set(e.origin.sourceId, list);
      plan.push({ kind: "copy", sourceId: e.origin.sourceId, slot: list.length - 1 });
    }
  }
  const copied = new Map<string, PDFPage[]>();
  for (const [sourceId, indices] of copyRequests) {
    check();
    const bytes = input.sources[sourceId];
    if (!bytes) throw new Error("An imported document is missing.");
    const scratch = await loadForEditing(bytes);
    await applyEditsForSource(scratch, sourceId, doc.nativeEdits[sourceId], report);
    sanitizeForCopy(scratch, report);
    copied.set(sourceId, await out.copyPages(scratch, indices));
  }

  const finalPages: PDFPage[] = plan.map((p) => {
    if (p.kind === "orig") return originalPages[p.index];
    if (p.kind === "copy") return copied.get(p.sourceId)![p.slot];
    const page = PDFPage.create(out);
    page.setSize(p.w, p.h);
    return page;
  });

  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i);
  finalPages.forEach((p) => out.addPage(p));

  const keptRefs = new Set(finalPages.map((p) => p.ref.toString()));
  const removed = new Set(originalRefs.filter((r) => !keptRefs.has(r)));

  // rotation
  entries.forEach((e, i) => {
    if (!e.rotation) return;
    const page = finalPages[i];
    page.setRotation(degrees((((page.getRotation().angle + e.rotation) % 360) + 360) % 360));
  });

  // ---------------------------------------------------------------- overlays
  const embedder = new FontEmbedder(out);
  const images = new Map<string, Promise<PDFImage>>();
  const byPage = new Map<string, EditorObject[]>();
  for (const o of doc.objects) {
    const l = byPage.get(o.pageId) ?? [];
    l.push(o);
    byPage.set(o.pageId, l);
  }
  for (let i = 0; i < entries.length; i++) {
    check();
    const objs = byPage.get(entries[i].id);
    if (!objs?.length) continue;
    onProgress(0.35 + (0.45 * i) / entries.length, `Drawing added content (page ${i + 1})`);
    const drawer = new PageDrawer(out, finalPages[i], embedder, faces, images, input.assets, report);
    for (const o of objs) await drawer.draw(o);
  }

  // Unicode field appearances (Arabic etc.)
  if (unicodeFields.length) {
    const form = out.getForm();
    for (const name of unicodeFields) {
      try {
        const f = form.getField(name);
        if (f instanceof PDFTextField || f instanceof PDFDropdown || f instanceof PDFOptionList) await unicodeFieldAppearance(out, f, faces, embedder);
      } catch (e) {
        report.warnings.push(`The appearance of form field “${name}” could not be generated: ${(e as Error).message}`);
      }
    }
  }

  // ---------------------------------------------------------------- cleanup
  onProgress(0.85, "Cleaning up");
  if (removed.size) {
    detachRemovedPages(out.context, removed);
    const outlines = out.catalog.lookup(N("Outlines"));
    if (outlines) report.warnings.push("Bookmarks that pointed to removed pages no longer have a destination.");
  }
  if (input.title) {
    try {
      if (!out.getTitle()) out.setTitle(input.title);
    } catch {
      /* ignore */
    }
  }
  out.setModificationDate(new Date());
  collectGarbage(out.context);
  check();
  onProgress(0.9, "Writing file");
  const bytes = await out.save({ updateFieldAppearances: false, useObjectStreams: true });
  report.pageCount = finalPages.length;
  onProgress(1, "Done");
  void asArray;
  void PDFDict;
  void PDFRef;
  return { bytes, report };
}
