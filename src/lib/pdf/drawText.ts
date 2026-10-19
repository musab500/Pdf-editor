import {
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFArray,
  StandardFonts,
  beginText,
  endText,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  setTextRise,
} from "pdf-lib";
import { Encodings } from "@pdf-lib/standard-fonts";
import { safeLayout, type Face, type FkFont, type FkGlyph } from "../text/fontFaces";
import type { TextLayout } from "../text/layout";

/** Embeds faces into a document on demand (one PDFFont per face/style). */
export class FontEmbedder {
  private cache = new Map<string, Promise<PDFFont>>();
  constructor(private doc: PDFDocument) {}

  get(face: Face, italic: boolean): Promise<PDFFont> {
    const useItalicStd = italic && face.kind === "standard";
    const key = face.key + (useItalicStd ? ":italic" : "");
    let p = this.cache.get(key);
    if (!p) {
      if (face.kind === "standard") {
        const name = (useItalicStd ? face.std!.italicName : face.std!.name) as unknown as StandardFonts;
        p = this.doc.embedFont(name);
      } else {
        p = this.doc.embedFont(face.ttf!.bytes, { subset: true }).then((f) => {
          subsetEmbedder(f);
          return f;
        });
      }
      this.cache.set(key, p);
    }
    return p;
  }
}

interface SubsetEmbedderInternals {
  font: FkFont;
  subset: { includeGlyph(g: FkGlyph | number): number };
  glyphs: FkGlyph[];
  glyphIdMap: Map<number, number>;
  glyphCache: { invalidate(): void };
}

function subsetEmbedder(f: PDFFont): SubsetEmbedderInternals {
  const emb = (f as unknown as { embedder: SubsetEmbedderInternals }).embedder;
  if (!emb?.subset || !emb.glyphIdMap) throw new Error("Expected a subsetting custom font embedder");
  patchTtfSubset(emb.subset);
  return emb;
}

type Bytes = Uint8Array & { constructor: new (n: number) => Uint8Array };
interface TtfSubsetProto {
  _addGlyph(gid: number): number;
  __pePatched?: boolean;
}

/**
 * fontkit's TrueType subsetter concatenates glyph records without padding.
 * With a short 'loca' table (offsets stored ÷2) any odd-length glyph shifts
 * every following glyph, so viewers draw the wrong or no outlines. Pad each
 * glyph record to a 4-byte boundary (as the OpenType spec recommends).
 */
export function patchTtfSubset(subset: object) {
  const proto = Object.getPrototypeOf(subset) as TtfSubsetProto & { glyf?: Bytes[]; offset?: number };
  if (!proto || proto.__pePatched || typeof proto._addGlyph !== "function") return;
  const orig = proto._addGlyph;
  proto._addGlyph = function (this: { glyf: Bytes[]; offset: number }, gid: number) {
    const r = orig.call(this, gid);
    const i = this.glyf.length - 1;
    const b = this.glyf[i];
    const pad = (4 - (b.length % 4)) % 4;
    if (pad) {
      const nb = new (b.constructor as new (n: number) => Uint8Array)(b.length + pad);
      nb.fill(0);
      nb.set(b);
      this.glyf[i] = nb as Bytes;
      this.offset += pad;
    }
    return r;
  };
  proto.__pePatched = true;
}

/**
 * Add a shaped glyph to pdf-lib's font subset and return its id inside the
 * subset (pdf-lib renumbers glyphs when subsetting).
 *
 * The ToUnicode map is per glyph id, but one glyph can stand for different
 * characters (e.g. Naskh draws ب and ن with the same dotless body plus a
 * separate dot). So a glyph is added once per distinct character mapping; the
 * duplicate entries share the outline but carry their own Unicode, which keeps
 * copy/paste and search correct.
 */
function includeGlyph(emb: SubsetEmbedderInternals, g: FkGlyph): number {
  const keys = (emb as unknown as { __peKeys?: Map<string, number> }).__peKeys ?? new Map<string, number>();
  (emb as unknown as { __peKeys: Map<string, number> }).__peKeys = keys;
  const key = `${g.id}:${g.codePoints.join(",")}`;
  const known = keys.get(key);
  if (known !== undefined) return known;
  const subset = emb.subset as unknown as { glyphs: number[]; mapping: Record<number, number>; includeGlyph(g: number): number };
  let sid: number;
  if (subset.mapping[g.id] === undefined) sid = subset.includeGlyph(g.id);
  else {
    subset.glyphs.push(g.id); // duplicate outline under a new id
    sid = subset.glyphs.length - 1;
  }
  const synthetic = 1_000_000 + sid;
  emb.glyphs[sid - 1] = { id: synthetic, advanceWidth: g.advanceWidth, codePoints: g.codePoints };
  emb.glyphIdMap.set(synthetic, sid);
  emb.glyphCache.invalidate();
  keys.set(key, sid);
  return sid;
}

/** Shape text so that each glyph object carries the characters of ITS cluster. */
export function shapeRun(fk: FkFont, text: string, rtl: boolean) {
  // fontkit caches one Glyph object per glyph id, with the code points of its
  // first use; while shaping, hand out fresh objects so code points are per cluster.
  const f = fk as unknown as { _glyphs: Record<number, unknown>; getGlyph: (id: number, cps?: number[]) => unknown };
  const orig = f.getGlyph;
  f.getGlyph = function (this: typeof f, id: number, cps?: number[]) {
    const prev = this._glyphs[id];
    delete this._glyphs[id];
    const g = orig.call(this, id, cps);
    if (prev) this._glyphs[id] = prev;
    return g;
  };
  try {
    return safeLayout(fk, text, rtl);
  } finally {
    f.getGlyph = orig;
  }
}

export interface DrawTextParams {
  layout: TextLayout;
  /** PDF coordinates of the box's top-left corner (unrotated page space, y up) */
  left: number;
  top: number;
  padding: number;
  size: number;
  color: [number, number, number];
  italic: boolean;
}

const winAnsiSafe = (t: string) =>
  Array.from(t)
    .map((ch) => (Encodings.WinAnsi.canEncodeUnicodeCodePoint(ch.codePointAt(0)!) ? ch : "?"))
    .join("");

const n = (v: number) => PDFNumber.of(Math.round(v * 10000) / 10000);

/**
 * Produce PDF operators that draw a laid-out text block. `fontKey` must return
 * the resource name under which the given PDFFont is registered.
 */
export async function textOperators(
  params: DrawTextParams,
  embedder: FontEmbedder,
  fontKey: (font: PDFFont) => PDFName,
): Promise<PDFOperator[]> {
  const { layout, left, top, padding, size, color, italic } = params;
  const ops: PDFOperator[] = [setFillingRgbColor(color[0], color[1], color[2]), beginText()];
  for (const line of layout.lines) {
    const baselineY = top - padding - line.baseline;
    for (const run of line.runs) {
      if (!run.text.trim() && run.width === 0) continue;
      const pdfFont = await embedder.get(run.face, italic);
      const key = fontKey(pdfFont);
      ops.push(setFontAndSize(key, size));
      const x = left + padding + line.x + run.x;
      const skew = italic && run.face.kind === "ttf" ? 0.2 : 0;
      ops.push(setTextMatrix(1, 0, skew, 1, x, baselineY));
      if (run.face.kind === "standard") {
        ops.push(PDFOperator.of("Tj" as never, [pdfFont.encodeText(winAnsiSafe(run.text))]));
        continue;
      }
      // TrueType: draw shaped glyphs with explicit positioning (GPOS advances & mark offsets)
      const emb = subsetEmbedder(pdfFont);
      const fk = emb.font;
      const upm = fk.unitsPerEm;
      const glyphRun = shapeRun(fk, run.text, run.rtl);
      let arr = PDFArray.withContext(pdfFont.doc.context);
      const flush = () => {
        if (arr.size()) ops.push(PDFOperator.of("TJ" as never, [arr]));
        arr = PDFArray.withContext(pdfFont.doc.context);
      };
      glyphRun.glyphs.forEach((g, i) => {
        const pos = glyphRun.positions[i];
        const w = (g.advanceWidth * 1000) / upm; // width the viewer will advance by (pdf-lib W array)
        const adv = (pos.xAdvance * 1000) / upm;
        const xOff = (pos.xOffset * 1000) / upm;
        const yOff = pos.yOffset;
        const hex = PDFHexString.of(includeGlyph(emb, g).toString(16).padStart(4, "0"));
        if (yOff !== 0) {
          flush();
          ops.push(setTextRise((yOff * size) / upm));
          if (xOff) arr.push(n(-xOff));
          arr.push(hex);
          const back = w - adv + xOff;
          if (Math.abs(back) > 0.001) arr.push(n(back));
          flush();
          ops.push(setTextRise(0));
        } else {
          if (xOff) arr.push(n(-xOff));
          arr.push(hex);
          const back = w - adv + xOff;
          if (Math.abs(back) > 0.001) arr.push(n(back));
        }
      });
      flush();
    }
  }
  ops.push(endText());
  return ops;
}
