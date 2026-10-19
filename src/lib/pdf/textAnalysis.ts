import { PDFContext, PDFDict, PDFPage, PDFRef, PDFStream } from "pdf-lib";
import { CSOperation, ContentStreamError, parseContentStream } from "./contentStream";
import { FontCache, FontInfo } from "./fontInfo";
import { asArray, asDict, dictGet, N, numbersOf, pageContentBytes, streamBytes } from "./pdfObjects";
import bidiFactory from "bidi-js";

const bidi = bidiFactory();

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TextShow {
  /** index of the operation in the parsed op list */
  opIndex: number;
  op: string;
  fontKey: string;
  font: FontInfo | undefined;
  fontSize: number;
  /** effective size in user space (font size × matrix scale) */
  userFontSize: number;
  text: string;
  unknownGlyphs: number;
  codes: number[];
  /** baseline start / end points in user space */
  start: [number, number];
  end: [number, number];
  bbox: Rect;
  /** rotation of the baseline in degrees (user space, counter-clockwise) */
  angle: number;
  fill: [number, number, number];
  renderMode: number;
  btIndex: number;
  charSpacing: number;
  wordSpacing: number;
  horizontalScale: number;
  /** text-space matrix (Tm × CTM) at the start of the show, used for grouping */
  lineMatrix: Matrix;
  /** 0 = the page's own content; >0 = a Form XObject drawn by the page */
  stream: number;
  /** like `text`, but multi-character RTL glyphs (e.g. the lam-alef ligature) are stored reversed, for reordering */
  visualText: string;
}

export interface TextLine {
  id: string;
  shows: TextShow[];
  text: string;
  bbox: Rect;
  font: FontInfo | undefined;
  fontKey: string;
  fontSize: number;
  userFontSize: number;
  angle: number;
  fill: [number, number, number];
  rtl: boolean;
  invisible: boolean;
  /** the text lives inside a Form XObject (cannot be rewritten natively) */
  inXObject: boolean;
  /** text in logical (reading) order — differs from `text` for RTL text drawn in visual order */
  displayText: string;
}

export interface PageTextAnalysis {
  ops: CSOperation[];
  source: Uint8Array;
  shows: TextShow[];
  lines: TextLine[];
  hasFormXObjects: boolean;
  parseError?: string;
  fonts: Map<string, FontInfo>;
}

const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

interface GState {
  ctm: Matrix;
  fill: [number, number, number];
  font: FontInfo | undefined;
  fontKey: string;
  size: number;
  Tc: number;
  Tw: number;
  Th: number;
  TL: number;
  Ts: number;
  Tr: number;
}

function num(o: CSOperation["operands"][number] | undefined): number {
  return o && o.t === "num" ? o.v : 0;
}

function toRGB(op: string, vals: number[]): [number, number, number] | undefined {
  if (op === "g") return [vals[0], vals[0], vals[0]];
  if (op === "rg") return [vals[0], vals[1], vals[2]];
  if (op === "k") {
    const [c, m, y, k] = vals;
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  }
  if (op === "sc" || op === "scn") {
    if (vals.length === 1) return [vals[0], vals[0], vals[0]];
    if (vals.length === 3) return [vals[0], vals[1], vals[2]];
    if (vals.length === 4) return toRGB("k", vals);
  }
  return undefined;
}

/**
 * Analyze the text of a page. The page's own content streams are analyzed for
 * native editing; text inside Form XObjects (common in PDFs exported from
 * design tools) is analyzed too, so it can be located and visually replaced,
 * but it is marked as not natively editable.
 */
export function analyzePageText(ctx: PDFContext, page: PDFPage, fontCache = new FontCache(ctx)): PageTextAnalysis {
  const source = pageContentBytes(ctx, page.node.get(N("Contents")));
  const pageResources = page.node.Resources();
  const fonts = new Map<string, FontInfo>();

  let ops: CSOperation[];
  try {
    ops = parseContentStream(source);
  } catch (e) {
    return {
      ops: [],
      source,
      shows: [],
      lines: [],
      hasFormXObjects: false,
      fonts,
      parseError: e instanceof ContentStreamError ? e.message : String(e),
    };
  }

  const shows: TextShow[] = [];
  const streamOps: CSOperation[][] = [];
  let hasFormXObjects = false;
  const visiting = new Set<PDFStream>();

  const run = (ops: CSOperation[], resources: PDFDict | undefined, baseCtm: Matrix, depth: number) => {
    const stream = streamOps.length;
    streamOps.push(ops);
    const fontDict = asDict(dictGet(resources, "Font"));
    const xobjDict = asDict(dictGet(resources, "XObject"));
    const localFonts = new Map<string, FontInfo | undefined>();
    const resolveFont = (key: string): FontInfo | undefined => {
      if (localFonts.has(key)) return localFonts.get(key);
      let fi: FontInfo | undefined;
      const raw = fontDict?.get(N(key));
      const d = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
      if (d instanceof PDFDict) fi = fontCache.get(d, raw instanceof PDFRef ? raw : undefined);
      localFonts.set(key, fi);
      if (stream === 0 && fi) fonts.set(key, fi);
      return fi;
    };

    let gs: GState = { ctm: [...baseCtm] as Matrix, fill: [0, 0, 0], font: undefined, fontKey: "", size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0, Tr: 0 };
    const stack: GState[] = [];
    let Tm: Matrix = [...IDENTITY];
    let Tlm: Matrix = [...IDENTITY];
    let btIndex = -1;

    const showString = (opIndex: number, opName: string, items: CSOperation["operands"]) => {
      const font = gs.font;
      const startTm: Matrix = [...Tm];
      const trmBase = (tm: Matrix): Matrix => mul(mul([gs.size * gs.Th, 0, 0, gs.size, 0, gs.Ts], tm), gs.ctm);
      let text = "";
      let vtext = "";
      let unknown = 0;
      const codes: number[] = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const extend = (m: Matrix, x0: number, y0: number, x1: number, y1: number) => {
        for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
          const [ux, uy] = apply(m, x, y);
          minX = Math.min(minX, ux); maxX = Math.max(maxX, ux);
          minY = Math.min(minY, uy); maxY = Math.max(maxY, uy);
        }
      };
      const asc = font?.ascent ?? 0.8;
      const desc = font?.descent ?? -0.2;
      for (const it of items) {
        if (it.t === "num") {
          const tx = (-it.v / 1000) * gs.size * gs.Th;
          Tm = mul([1, 0, 0, 1, tx, 0], Tm);
          // a large positive displacement inside TJ is how many producers write a word gap
          if (it.v <= -200 && text && !text.endsWith(" ")) {
            text += " ";
            vtext += " ";
          }
          continue;
        }
        if (it.t !== "str") continue;
        const glyphs = font ? font.decode(it.bytes) : Array.from(it.bytes).map((c) => ({ code: c, bytes: 1, unicode: undefined, width: 500 }));
        for (const g of glyphs) {
          const trm = trmBase(Tm);
          const w = g.width / 1000;
          extend(trm, 0, desc, w, asc);
          if (g.unicode === undefined) unknown++;
          const u = g.unicode ?? "\uFFFD";
          text += u;
          vtext += u.length > 1 && RTL_RE.test(u) ? Array.from(u).reverse().join("") : u;
          codes.push(g.code);
          const isSpace = g.bytes === 1 && g.code === 32;
          const tx = (w * gs.size + gs.Tc + (isSpace ? gs.Tw : 0)) * gs.Th;
          Tm = mul([1, 0, 0, 1, tx, 0], Tm);
        }
      }
      const startM = trmBase(startTm);
      const endM = trmBase(Tm);
      const start = apply(startM, 0, 0);
      const end = apply(endM, 0, 0);
      const scale = Math.hypot(startM[2], startM[3]) || gs.size;
      const angle = (Math.atan2(startM[1], startM[0]) * 180) / Math.PI;
      if (minX === Infinity) {
        minX = maxX = start[0];
        minY = maxY = start[1];
      }
      shows.push({
        opIndex, op: opName, fontKey: gs.fontKey, font, fontSize: gs.size, userFontSize: scale, text, unknownGlyphs: unknown, codes,
        start, end, bbox: { x0: minX, y0: minY, x1: maxX, y1: maxY }, angle, fill: gs.fill, renderMode: gs.Tr, btIndex,
        charSpacing: gs.Tc, wordSpacing: gs.Tw, horizontalScale: gs.Th, lineMatrix: mul(startTm, gs.ctm), stream, visualText: vtext,
      });
    };

    const nextLine = (tx: number, ty: number) => {
      Tlm = mul([1, 0, 0, 1, tx, ty], Tlm);
      Tm = [...Tlm];
    };

    ops.forEach((o, i) => {
      const a = o.operands;
      switch (o.op) {
        case "q": stack.push({ ...gs, ctm: [...gs.ctm] as Matrix, fill: [...gs.fill] as [number, number, number] }); break;
        case "Q": gs = stack.pop() ?? gs; break;
        case "cm": gs.ctm = mul(a.map(num) as Matrix, gs.ctm); break;
        case "BT": Tm = [...IDENTITY]; Tlm = [...IDENTITY]; btIndex++; break;
        case "ET": break;
        case "Tf": {
          const key = a[0]?.t === "name" ? a[0].v : "";
          gs.fontKey = key;
          gs.font = resolveFont(key);
          gs.size = num(a[1]);
          break;
        }
        case "Tc": gs.Tc = num(a[0]); break;
        case "Tw": gs.Tw = num(a[0]); break;
        case "Tz": gs.Th = num(a[0]) / 100; break;
        case "TL": gs.TL = num(a[0]); break;
        case "Ts": gs.Ts = num(a[0]); break;
        case "Tr": gs.Tr = num(a[0]); break;
        case "Td": nextLine(num(a[0]), num(a[1])); break;
        case "TD": gs.TL = -num(a[1]); nextLine(num(a[0]), num(a[1])); break;
        case "Tm": Tlm = a.map(num) as Matrix; Tm = [...Tlm]; break;
        case "T*": nextLine(0, -gs.TL); break;
        case "Tj": showString(i, "Tj", a.slice(0, 1)); break;
        case "TJ": if (a[0]?.t === "arr") showString(i, "TJ", a[0].items); break;
        case "'": nextLine(0, -gs.TL); showString(i, "'", a.slice(0, 1)); break;
        case '"': gs.Tw = num(a[0]); gs.Tc = num(a[1]); nextLine(0, -gs.TL); showString(i, '"', a.slice(2, 3)); break;
        case "g": case "rg": case "k": case "sc": case "scn": {
          const rgb = toRGB(o.op, a.filter((x) => x.t === "num").map(num));
          if (rgb) gs.fill = rgb;
          break;
        }
        case "Do": {
          const key = a[0]?.t === "name" ? a[0].v : "";
          const xo = xobjDict?.lookup(N(key));
          if (!(xo instanceof PDFStream) || dictGet(xo.dict, "Subtype")?.toString() !== "/Form") break;
          hasFormXObjects = true;
          if (depth >= 8 || visiting.has(xo)) break;
          let xops: CSOperation[];
          try {
            xops = parseContentStream(streamBytes(xo));
          } catch {
            break; // unreadable form: skip, never fail the page
          }
          const fm = numbersOf(ctx, asArray(dictGet(xo.dict, "Matrix")));
          const formMatrix: Matrix = fm.length === 6 ? (fm as Matrix) : [...IDENTITY];
          const formRes = asDict(dictGet(xo.dict, "Resources")) ?? resources;
          visiting.add(xo);
          run(xops, formRes, mul(formMatrix, gs.ctm), depth + 1);
          visiting.delete(xo);
          break;
        }
      }
    });
  };

  run(ops, pageResources, [...IDENTITY], 0);

  const lines: TextLine[] = [];
  for (let st = 0; st < streamOps.length; st++) {
    const own = shows.filter((sh) => sh.stream === st);
    if (!own.length) continue;
    const grouped = groupLines(own, streamOps[st]);
    for (const l of grouped) lines.push({ ...l, id: st === 0 ? l.id : `X${st}:${l.id}`, inXObject: st > 0 });
  }
  // text in forms is often written word by word: merge visually adjacent pieces into lines
  const merged = mergeVisualLines(lines.filter((l) => l.inXObject));
  return { ops, source, shows: shows.filter((sh) => sh.stream === 0), lines: [...lines.filter((l) => !l.inXObject), ...merged], hasFormXObjects, fonts };
}

/** Merge lines that sit on the same baseline with the same size into one (used for display/replacement only). */
function mergeVisualLines(lines: TextLine[]): TextLine[] {
  const out: TextLine[] = [];
  const sorted = [...lines].sort((a, b) => b.bbox.y1 - a.bbox.y1 || a.bbox.x0 - b.bbox.x0);
  for (const l of sorted) {
    const size = l.userFontSize || 10;
    const target = out.find((o) => {
      if (Math.abs(o.angle) >= 1 || Math.abs(l.angle) >= 1) return false;
      if (Math.abs((o.userFontSize || 10) - size) > size * 0.4) return false;
      // same line: the boxes overlap vertically by at least half of the smaller one
      const overlapY = Math.min(o.bbox.y1, l.bbox.y1) - Math.max(o.bbox.y0, l.bbox.y0);
      const minH = Math.min(o.bbox.y1 - o.bbox.y0, l.bbox.y1 - l.bbox.y0) || size;
      if (overlapY < minH * 0.5) return false;
      // and touch or sit close horizontally
      return l.bbox.x0 < o.bbox.x1 + size * 1.2 && l.bbox.x1 > o.bbox.x0 - size * 1.2;
    });
    if (!target) {
      out.push({ ...l, shows: [...l.shows] });
      continue;
    }
    target.shows.push(...l.shows);
    target.bbox = { x0: Math.min(target.bbox.x0, l.bbox.x0), y0: Math.min(target.bbox.y0, l.bbox.y0), x1: Math.max(target.bbox.x1, l.bbox.x1), y1: Math.max(target.bbox.y1, l.bbox.y1) };
  }
  return out.map((l) => {
    if (l.shows.length < 2) return l;
    // re-assemble text left to right (visual order), then derive reading order
    const shows = [...l.shows].sort((a, b) => Math.min(a.start[0], a.end[0]) - Math.min(b.start[0], b.end[0]));
    const rebuilt = buildLine(shows, 0);
    return { ...l, text: rebuilt.text, displayText: rebuilt.displayText, rtl: rebuilt.rtl };
  });
}

/**
 * Convert text extracted in drawing order to reading order. Many producers
 * draw Arabic/Hebrew glyphs left to right (visual order); for such lines the
 * Unicode Bidirectional Algorithm reorders them back. Presentation forms are
 * normalised to base letters.
 */
export function toReadingOrder(text: string): string {
  const t = text.normalize("NFKC");
  if (!RTL_RE.test(t)) return t;
  const rtlCount = Array.from(t).filter((c) => RTL_RE.test(c)).length;
  const ltrCount = Array.from(t).filter((c) => /[A-Za-z]/.test(c)).length;
  if (rtlCount < ltrCount) return t;
  const levels = bidi.getEmbeddingLevels(t, "rtl");
  return bidi.getReorderedString(t, levels);
}

/** Text-positioning / state operators that may sit between shows of one visual line. */
const LINE_SAFE_OPS = new Set(["Td", "TD", "Tm", "T*", "Tc", "Tw", "Tz", "TL", "Ts", "Tj", "TJ", "'", '"']);

function groupLines(shows: TextShow[], ops: CSOperation[]): TextLine[] {
  const lines: TextLine[] = [];
  let cur: TextShow[] = [];
  const flush = () => {
    if (!cur.length) return;
    lines.push(buildLine(cur, lines.length));
    cur = [];
  };
  for (const s of shows) {
    if (!cur.length) {
      cur.push(s);
      continue;
    }
    const prev = cur[cur.length - 1];
    let ok =
      prev.btIndex === s.btIndex &&
      prev.fontKey === s.fontKey &&
      Math.abs(prev.fontSize - s.fontSize) < 0.01 &&
      Math.abs(prev.angle - s.angle) < 1 &&
      prev.renderMode === s.renderMode &&
      prev.fill.every((v, k) => Math.abs(v - s.fill[k]) < 0.01);
    if (ok) {
      for (let k = prev.opIndex + 1; k < s.opIndex; k++) {
        if (!LINE_SAFE_OPS.has(ops[k].op)) {
          ok = false;
          break;
        }
      }
    }
    if (ok) {
      // same baseline: measure perpendicular distance relative to the baseline direction
      const rad = (prev.angle * Math.PI) / 180;
      const dx = s.start[0] - prev.end[0];
      const dy = s.start[1] - prev.end[1];
      const along = dx * Math.cos(rad) + dy * Math.sin(rad);
      const perp = -dx * Math.sin(rad) + dy * Math.cos(rad);
      const size = prev.userFontSize || 10;
      ok = Math.abs(perp) < size * 0.25 && along > -size * 0.5 && along < size * 1.5;
    }
    if (ok) cur.push(s);
    else {
      flush();
      cur.push(s);
    }
  }
  flush();
  return lines;
}

function buildLine(shows: TextShow[], idx: number): TextLine {
  let text = "";
  let vtext = "";
  shows.forEach((s, i) => {
    if (i > 0) {
      const prev = shows[i - 1];
      const gap = Math.hypot(s.start[0] - prev.end[0], s.start[1] - prev.end[1]);
      if (gap > (prev.userFontSize || 10) * 0.2 && !text.endsWith(" ") && !s.text.startsWith(" ")) {
        text += " ";
        vtext += " ";
      }
    }
    text += s.text;
    vtext += s.visualText;
  });
  const bbox = shows.reduce<Rect>(
    (r, s) => ({ x0: Math.min(r.x0, s.bbox.x0), y0: Math.min(r.y0, s.bbox.y0), x1: Math.max(r.x1, s.bbox.x1), y1: Math.max(r.y1, s.bbox.y1) }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
  const f = shows[0];
  return {
    id: `L${idx}:${f.opIndex}`,
    shows,
    text,
    bbox,
    font: f.font,
    fontKey: f.fontKey,
    fontSize: f.fontSize,
    userFontSize: f.userFontSize,
    angle: f.angle,
    fill: f.fill,
    rtl: RTL_RE.test(text),
    invisible: f.renderMode === 3 || f.renderMode === 7,
    inXObject: f.stream > 0,
    displayText: toReadingOrder(vtext),
  };
}
