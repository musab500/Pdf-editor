import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from "pdf-lib";
import { Encodings, Font as StdFont, FontNames } from "@pdf-lib/standard-fonts";
import { asArray, asDict, asName, asNumber, dictGet, lookup, numbersOf, streamBytes } from "./pdfObjects";

/**
 * Font analysis for existing PDF fonts. This is intentionally conservative:
 * it records *why* a font cannot be safely re-encoded so the UI can explain
 * the limitation and fall back to visual replacement.
 */

type UnicodeMappings = Record<number, [number, string]>;
const winAnsiMappings = (Encodings.WinAnsi as unknown as { unicodeMappings: UnicodeMappings }).unicodeMappings;
const symbolMappings = (Encodings.Symbol as unknown as { unicodeMappings: UnicodeMappings }).unicodeMappings;

const GLYPH_TO_UNICODE = new Map<string, string>();
const WIN_ANSI_CODE_TO_NAME = new Map<number, string>();
for (const [cp, [code, name]] of Object.entries(winAnsiMappings)) {
  // first mapping wins: e.g. "space" is listed for both U+0020 and U+00A0
  if (!GLYPH_TO_UNICODE.has(name)) GLYPH_TO_UNICODE.set(name, String.fromCodePoint(Number(cp)));
  if (!WIN_ANSI_CODE_TO_NAME.has(code)) WIN_ANSI_CODE_TO_NAME.set(code, name);
}
for (const [cp, [, name]] of Object.entries(symbolMappings)) {
  if (!GLYPH_TO_UNICODE.has(name)) GLYPH_TO_UNICODE.set(name, String.fromCodePoint(Number(cp)));
}
// common names absent from WinAnsi
const EXTRA_GLYPHS: Record<string, string> = {
  fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", Lslash: "Ł", lslash: "ł", dotlessi: "ı",
  fraction: "⁄", hungarumlaut: "˝", ogonek: "˛", dotaccent: "˙", ring: "˚", breve: "˘", caron: "ˇ",
  minus: "−", nbspace: " ", sfthyphen: "­", quotesingle: "'", grave: "`", space: " ",
};
for (const [k, v] of Object.entries(EXTRA_GLYPHS)) if (!GLYPH_TO_UNICODE.has(k)) GLYPH_TO_UNICODE.set(k, v);

export function glyphNameToUnicode(name: string): string | undefined {
  const known = GLYPH_TO_UNICODE.get(name);
  if (known) return known;
  let m = /^uni([0-9A-Fa-f]{4})+$/.exec(name);
  if (m) {
    const hex = name.slice(3);
    let s = "";
    for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  const dot = name.indexOf(".");
  if (dot > 0) return glyphNameToUnicode(name.slice(0, dot));
  return undefined;
}

// Adobe StandardEncoding: ASCII range equals WinAnsi except two quotes; upper half differs.
const STANDARD_UPPER: Record<number, string> = {
  0xa1: "exclamdown", 0xa2: "cent", 0xa3: "sterling", 0xa4: "fraction", 0xa5: "yen", 0xa6: "florin",
  0xa7: "section", 0xa8: "currency", 0xa9: "quotesingle", 0xaa: "quotedblleft", 0xab: "guillemotleft",
  0xac: "guilsinglleft", 0xad: "guilsinglright", 0xae: "fi", 0xaf: "fl", 0xb1: "endash", 0xb2: "dagger",
  0xb3: "daggerdbl", 0xb4: "periodcentered", 0xb6: "paragraph", 0xb7: "bullet", 0xb8: "quotesinglbase",
  0xb9: "quotedblbase", 0xba: "quotedblright", 0xbb: "guillemotright", 0xbc: "ellipsis", 0xbd: "perthousand",
  0xbf: "questiondown", 0xc1: "grave", 0xc2: "acute", 0xc3: "circumflex", 0xc4: "tilde", 0xc5: "macron",
  0xc6: "breve", 0xc7: "dotaccent", 0xc8: "dieresis", 0xca: "ring", 0xcb: "cedilla", 0xcd: "hungarumlaut",
  0xce: "ogonek", 0xcf: "caron", 0xd0: "emdash", 0xe1: "AE", 0xe3: "ordfeminine", 0xe8: "Lslash",
  0xe9: "Oslash", 0xea: "OE", 0xeb: "ordmasculine", 0xf1: "ae", 0xf5: "dotlessi", 0xf8: "lslash",
  0xf9: "oslash", 0xfa: "oe", 0xfb: "germandbls",
};

function baseEncodingNames(enc: string): Map<number, string> {
  const m = new Map<number, string>();
  if (enc === "StandardEncoding") {
    for (let c = 0x20; c < 0x7f; c++) {
      const n = WIN_ANSI_CODE_TO_NAME.get(c);
      if (n) m.set(c, n);
    }
    m.set(0x27, "quoteright");
    m.set(0x60, "quoteleft");
    for (const [c, n] of Object.entries(STANDARD_UPPER)) m.set(Number(c), n);
    return m;
  }
  if (enc === "MacRomanEncoding") {
    // ASCII part only; upper half treated as unknown (editing disabled for those codes)
    for (let c = 0x20; c < 0x7f; c++) {
      const n = WIN_ANSI_CODE_TO_NAME.get(c);
      if (n) m.set(c, n);
    }
    return m;
  }
  // WinAnsiEncoding (also used as default for TrueType)
  for (const [c, n] of WIN_ANSI_CODE_TO_NAME) m.set(c, n);
  return m;
}

// ---------------------------------------------------------------- ToUnicode CMap

export interface ToUnicodeMap {
  map: Map<number, string>;
  /** byte lengths that appear in codespace ranges */
  codeLengths: number[];
}

export function parseToUnicode(bytes: Uint8Array): ToUnicodeMap {
  const text = new TextDecoder("latin1").decode(bytes);
  const map = new Map<number, string>();
  const codeLengths = new Set<number>();
  const hexTok = /<([0-9A-Fa-f\s]*)>/g;
  const utf16 = (hex: string) => {
    hex = hex.replace(/\s/g, "");
    let s = "";
    for (let i = 0; i + 3 < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    if (hex.length === 2) s = String.fromCharCode(parseInt(hex, 16));
    return s;
  };
  const sections = (kw: string) => {
    const re = new RegExp(`begin${kw}([\\s\\S]*?)end${kw}`, "g");
    const out: string[] = [];
    let m;
    while ((m = re.exec(text))) out.push(m[1]);
    return out;
  };
  for (const sec of sections("codespacerange")) {
    const toks = [...sec.matchAll(hexTok)].map((t) => t[1].replace(/\s/g, ""));
    for (let i = 0; i + 1 < toks.length; i += 2) codeLengths.add(toks[i].length / 2);
  }
  for (const sec of sections("bfchar")) {
    const toks = [...sec.matchAll(hexTok)].map((t) => t[1].replace(/\s/g, ""));
    for (let i = 0; i + 1 < toks.length; i += 2) {
      map.set(parseInt(toks[i], 16), utf16(toks[i + 1]));
      if (!codeLengths.size) codeLengths.add(toks[i].length / 2);
    }
  }
  for (const sec of sections("bfrange")) {
    // entries: <lo> <hi> <dst>  or  <lo> <hi> [<d1> <d2> ...]
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f\s]*>|\[[^\]]*\])/g;
    let m;
    while ((m = re.exec(sec))) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (hi - lo > 0xffff || hi < lo) continue;
      if (m[3].startsWith("[")) {
        const dsts = [...m[3].matchAll(hexTok)].map((t) => t[1]);
        for (let c = lo; c <= hi && c - lo < dsts.length; c++) map.set(c, utf16(dsts[c - lo]));
      } else {
        const base = m[3].slice(1, -1).replace(/\s/g, "");
        const prefix = base.slice(0, -4);
        const last = parseInt(base.slice(-4) || "0", 16);
        for (let c = lo; c <= hi; c++) {
          map.set(c, utf16(prefix + (last + (c - lo)).toString(16).padStart(4, "0")));
        }
      }
      if (!codeLengths.size) codeLengths.add(m[1].length / 2);
    }
  }
  return { map, codeLengths: [...codeLengths] };
}

// ---------------------------------------------------------------- FontInfo

const STANDARD_14: Record<string, FontNames> = {
  Helvetica: FontNames.Helvetica, "Helvetica-Bold": FontNames.HelveticaBold,
  "Helvetica-Oblique": FontNames.HelveticaOblique, "Helvetica-BoldOblique": FontNames.HelveticaBoldOblique,
  Arial: FontNames.Helvetica, "Arial,Bold": FontNames.HelveticaBold, "Arial-BoldMT": FontNames.HelveticaBold, ArialMT: FontNames.Helvetica,
  "Times-Roman": FontNames.TimesRoman, "Times-Bold": FontNames.TimesRomanBold, "Times-Italic": FontNames.TimesRomanItalic,
  "Times-BoldItalic": FontNames.TimesRomanBoldItalic, TimesNewRoman: FontNames.TimesRoman, "TimesNewRoman,Bold": FontNames.TimesRomanBold,
  Courier: FontNames.Courier, "Courier-Bold": FontNames.CourierBold, "Courier-Oblique": FontNames.CourierOblique,
  "Courier-BoldOblique": FontNames.CourierBoldOblique, Symbol: FontNames.Symbol, ZapfDingbats: FontNames.ZapfDingbats,
};

const stdFontCache = new Map<string, StdFont>();
function stdFont(n: FontNames): StdFont {
  let f = stdFontCache.get(n);
  if (!f) {
    f = StdFont.load(n);
    stdFontCache.set(n, f);
  }
  return f;
}

export interface DecodedGlyph {
  code: number;
  bytes: number; // byte length of this code
  unicode: string | undefined;
  width: number; // glyph space units / 1000
}

export class FontInfo {
  subtype = "";
  baseFont = "";
  family = "";
  isSubset = false;
  embedded = false;
  standard14: FontNames | undefined;
  isCID = false;
  identityEncoding = false;
  vertical = false;
  bold = false;
  italic = false;
  ascent = 0.8;
  descent = -0.2;
  /** reasons why re-encoding new text with this font is unsafe */
  editBlockers: string[] = [];
  private toUnicode: ToUnicodeMap | undefined;
  private encodingNames = new Map<number, string>();
  private widths = new Map<number, number>();
  private defaultWidth = 0;
  private stdMetrics: StdFont | undefined;
  /** reverse map unicode -> code (only for unambiguous single-glyph mappings) */
  private reverse = new Map<string, number>();
  private ambiguous = new Set<string>();

  constructor(
    private ctx: PDFContext,
    public readonly dict: PDFDict,
    public readonly ref: PDFRef | undefined,
  ) {
    this.analyze();
  }

  private analyze() {
    const ctx = this.ctx;
    const d = this.dict;
    this.subtype = asName(dictGet(d, "Subtype")) ?? "";
    this.baseFont = asName(dictGet(d, "BaseFont")) ?? "";
    this.isSubset = /^[A-Z]{6}\+/.test(this.baseFont);
    this.family = this.baseFont.replace(/^[A-Z]{6}\+/, "");
    const lname = this.family.toLowerCase();
    this.bold = /bold|black|heavy|semibold|demi/.test(lname);
    this.italic = /italic|oblique/.test(lname);

    let descriptor: PDFDict | undefined;
    let widthDict = d;
    if (this.subtype === "Type0") {
      this.isCID = true;
      const enc = dictGet(d, "Encoding");
      const encName = asName(enc);
      this.identityEncoding = encName === "Identity-H" || encName === "Identity-V";
      this.vertical = encName === "Identity-V" || (encName ?? "").endsWith("-V");
      if (!this.identityEncoding) this.editBlockers.push(`CID font uses the '${encName ?? "embedded CMap"}' encoding, which this editor cannot re-encode.`);
      const desc = asArray(dictGet(d, "DescendantFonts"));
      const cidFont = asDict(lookup(ctx, desc?.get(0)));
      if (cidFont) {
        widthDict = cidFont;
        descriptor = asDict(dictGet(cidFont, "FontDescriptor"));
        this.defaultWidth = asNumber(dictGet(cidFont, "DW")) ?? 1000;
        const w = asArray(dictGet(cidFont, "W"));
        if (w) this.parseCIDWidths(w);
      }
    } else {
      descriptor = asDict(dictGet(d, "FontDescriptor"));
      const first = asNumber(dictGet(d, "FirstChar")) ?? 0;
      const ws = numbersOf(ctx, asArray(dictGet(d, "Widths")));
      ws.forEach((w, i) => this.widths.set(first + i, w));
      if (descriptor) this.defaultWidth = asNumber(dictGet(descriptor, "MissingWidth")) ?? 0;
      this.parseSimpleEncoding();
    }
    void widthDict;

    if (this.subtype === "Type3") this.editBlockers.push("Type 3 fonts are drawn with custom glyph procedures and cannot be re-encoded safely.");

    if (descriptor) {
      this.embedded = ["FontFile", "FontFile2", "FontFile3"].some((k) => descriptor!.has(PDFName.of(k)));
      const asc = asNumber(dictGet(descriptor, "Ascent"));
      const desc = asNumber(dictGet(descriptor, "Descent"));
      if (asc && asc > 0) this.ascent = asc / 1000;
      if (desc && desc < 0) this.descent = desc / 1000;
      const flags = asNumber(dictGet(descriptor, "Flags")) ?? 0;
      const weight = asNumber(dictGet(descriptor, "FontWeight")) ?? 0;
      const italicAngle = asNumber(dictGet(descriptor, "ItalicAngle")) ?? 0;
      if (weight >= 600 || flags & (1 << 18)) this.bold = true;
      if (italicAngle !== 0 || flags & (1 << 6)) this.italic = true;
    }
    if (!this.embedded && this.subtype !== "Type0" && this.subtype !== "Type3") {
      const std = STANDARD_14[this.family] ?? STANDARD_14[this.family.replace(/[-,]?(MT|PS)$/, "")];
      if (std) {
        this.standard14 = std;
        this.stdMetrics = stdFont(std);
      }
    }

    const tu = dictGet(d, "ToUnicode");
    if (tu instanceof PDFStream) {
      try {
        this.toUnicode = parseToUnicode(streamBytes(tu));
      } catch {
        this.toUnicode = undefined;
      }
    }
    if (this.isCID && !this.toUnicode) this.editBlockers.push("The CID font has no ToUnicode map, so its characters cannot be identified.");
    this.buildReverse();
  }

  private parseCIDWidths(w: PDFArray) {
    const ctx = this.ctx;
    let i = 0;
    while (i < w.size()) {
      const first = asNumber(lookup(ctx, w.get(i)));
      const second = lookup(ctx, w.get(i + 1));
      if (first === undefined) break;
      if (second instanceof PDFArray) {
        numbersOf(ctx, second).forEach((v, k) => this.widths.set(first + k, v));
        i += 2;
      } else if (second instanceof PDFNumber) {
        const last = second.asNumber();
        const v = asNumber(lookup(ctx, w.get(i + 2))) ?? this.defaultWidth;
        for (let c = first; c <= last && c - first < 65536; c++) this.widths.set(c, v);
        i += 3;
      } else break;
    }
  }

  private parseSimpleEncoding() {
    const enc = lookup(this.ctx, this.dict.get(PDFName.of("Encoding")));
    let base = this.subtype === "Type1" && !this.isSymbolicStd() ? "StandardEncoding" : "WinAnsiEncoding";
    let differences: PDFArray | undefined;
    if (enc instanceof PDFName) base = enc.decodeText();
    else if (enc instanceof PDFDict) {
      base = asName(dictGet(enc, "BaseEncoding")) ?? base;
      differences = asArray(dictGet(enc, "Differences"));
    }
    if (this.isSymbolicStd()) {
      const mappings = this.family === "Symbol" ? symbolMappings : (Encodings.ZapfDingbats as unknown as { unicodeMappings: UnicodeMappings }).unicodeMappings;
      for (const [, [code, name]] of Object.entries(mappings)) this.encodingNames.set(code, name);
    } else {
      this.encodingNames = baseEncodingNames(base);
    }
    if (differences) {
      let code = 0;
      for (let i = 0; i < differences.size(); i++) {
        const o = lookup(this.ctx, differences.get(i));
        if (o instanceof PDFNumber) code = o.asNumber();
        else if (o instanceof PDFName) this.encodingNames.set(code++, o.decodeText());
      }
    }
  }

  private isSymbolicStd() {
    return this.family === "Symbol" || this.family === "ZapfDingbats";
  }

  private buildReverse() {
    const add = (u: string | undefined, code: number) => {
      if (!u) return;
      if (this.reverse.has(u) && this.reverse.get(u) !== code) {
        // prefer the lowest code (usually the canonical one), but remember duplicates
        this.ambiguous.add(u);
        if (code < (this.reverse.get(u) ?? Infinity)) this.reverse.set(u, code);
        return;
      }
      this.reverse.set(u, code);
    };
    if (this.toUnicode) for (const [code, u] of this.toUnicode.map) add(u, code);
    else if (!this.isCID) for (const [code] of this.encodingNames) add(this.unicodeOf(code), code);
  }

  codeLength(): number {
    if (this.isCID) return 2;
    return 1;
  }

  unicodeOf(code: number): string | undefined {
    const tu = this.toUnicode?.map.get(code);
    if (tu !== undefined) return tu;
    if (this.isCID) return undefined;
    const name = this.encodingNames.get(code);
    return name ? glyphNameToUnicode(name) : undefined;
  }

  /** advance width in glyph space (1/1000 em) */
  widthOf(code: number): number {
    const w = this.widths.get(code);
    if (w !== undefined) return w;
    if (this.stdMetrics) {
      const name = this.encodingNames.get(code);
      if (name) {
        const gw = this.stdMetrics.getWidthOfGlyph(name);
        if (gw !== undefined) return gw;
      }
    }
    return this.defaultWidth || (this.isCID ? 1000 : 500);
  }

  hasExplicitWidth(code: number): boolean {
    return this.widths.has(code);
  }

  decode(bytes: Uint8Array): DecodedGlyph[] {
    const out: DecodedGlyph[] = [];
    const len = this.codeLength();
    for (let i = 0; i + len - 1 < bytes.length; i += len) {
      const code = len === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
      out.push({ code, bytes: len, unicode: this.unicodeOf(code), width: this.widthOf(code) });
    }
    return out;
  }

  /** Map a unicode string to font codes. Returns undefined + reason when impossible. */
  encode(text: string): { codes: number[] } | { error: string } {
    const codes: number[] = [];
    for (const ch of Array.from(text)) {
      if (this.ambiguous.has(ch)) {
        // still usable – the reverse map holds one of the equivalent codes
      }
      let code = this.reverse.get(ch);
      if (code === undefined && this.standard14 && !this.isSymbolicStd() && !this.toUnicode) {
        const cp = ch.codePointAt(0)!;
        if (Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) {
          const name = Encodings.WinAnsi.encodeUnicodeCodePoint(cp).name;
          for (const [c, n] of this.encodingNames) if (n === name) code = c;
        }
      }
      if (code === undefined) return { error: `The character “${ch}” does not exist in the original font (${this.family || "unnamed"}).` };
      codes.push(code);
    }
    return { codes };
  }

  encodeToBytes(codes: number[]): Uint8Array {
    const len = this.codeLength();
    const out = new Uint8Array(codes.length * len);
    codes.forEach((c, i) => {
      if (len === 2) {
        out[i * 2] = (c >> 8) & 0xff;
        out[i * 2 + 1] = c & 0xff;
      } else out[i] = c & 0xff;
    });
    return out;
  }

  /**
   * Whether every character of the font's encoding can be drawn: standard-14
   * and non-embedded fonts are supplied by the viewer, full (non-subset)
   * embedded fonts contain all glyphs. Subsets only contain the glyphs used.
   */
  get hasCompleteGlyphSet(): boolean {
    return !!this.standard14 || !this.embedded || !this.isSubset;
  }

  get hasToUnicode(): boolean {
    return !!this.toUnicode;
  }
}

/** Font cache per pdf-lib document context. */
export class FontCache {
  private cache = new Map<PDFDict, FontInfo>();
  constructor(private ctx: PDFContext) {}
  get(dict: PDFDict, ref?: PDFRef): FontInfo {
    let f = this.cache.get(dict);
    if (!f) {
      f = new FontInfo(this.ctx, dict, ref);
      this.cache.set(dict, f);
    }
    return f;
  }
}
