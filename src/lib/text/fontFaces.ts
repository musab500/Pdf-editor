import fontkitModule from "@pdf-lib/fontkit";
import { Encodings, Font as StdFont, FontNames } from "@pdf-lib/standard-fonts";
import type { PDFDocument } from "pdf-lib";
type Fontkit = Parameters<PDFDocument["registerFontkit"]>[0];

/**
 * Font faces used for text that THIS editor adds (text boxes, visual
 * replacements, form appearances). Built-in faces are bundled with the app
 * under /public/fonts so nothing is fetched from third-party servers.
 */

export type BuiltinFamily = "helvetica" | "times" | "courier" | "noto-sans" | "noto-naskh-arabic" | "noto-sans-arabic";
/** a family id is a builtin family or "custom:<assetId>" for a user-uploaded font */
export type FontFamilyId = BuiltinFamily | `custom:${string}`;

export interface FamilyInfo {
  id: FontFamilyId;
  label: string;
  css: string;
  kind: "standard" | "ttf";
  /** file names (under /fonts) for regular/bold */
  files?: { regular: string; bold: string };
  std?: { regular: FontNames; bold: FontNames; italic: FontNames; boldItalic: FontNames };
}

export const BUILTIN_FAMILIES: FamilyInfo[] = [
  {
    id: "helvetica", label: "Helvetica / Arial (PDF standard)", css: "Arial, Helvetica, 'Liberation Sans', sans-serif", kind: "standard",
    std: { regular: FontNames.Helvetica, bold: FontNames.HelveticaBold, italic: FontNames.HelveticaOblique, boldItalic: FontNames.HelveticaBoldOblique },
  },
  {
    id: "times", label: "Times (PDF standard)", css: "'Times New Roman', Times, 'Liberation Serif', serif", kind: "standard",
    std: { regular: FontNames.TimesRoman, bold: FontNames.TimesRomanBold, italic: FontNames.TimesRomanItalic, boldItalic: FontNames.TimesRomanBoldItalic },
  },
  {
    id: "courier", label: "Courier (PDF standard)", css: "'Courier New', Courier, 'Liberation Mono', monospace", kind: "standard",
    std: { regular: FontNames.Courier, bold: FontNames.CourierBold, italic: FontNames.CourierOblique, boldItalic: FontNames.CourierBoldOblique },
  },
  { id: "noto-sans", label: "Noto Sans (Unicode)", css: "'PE Noto Sans'", kind: "ttf", files: { regular: "NotoSans_400Regular.ttf", bold: "NotoSans_700Bold.ttf" } },
  { id: "noto-naskh-arabic", label: "Noto Naskh Arabic", css: "'PE Noto Naskh Arabic'", kind: "ttf", files: { regular: "NotoNaskhArabic_400Regular.ttf", bold: "NotoNaskhArabic_700Bold.ttf" } },
  { id: "noto-sans-arabic", label: "Noto Sans Arabic", css: "'PE Noto Sans Arabic'", kind: "ttf", files: { regular: "NotoSansArabic_400Regular.ttf", bold: "NotoSansArabic_700Bold.ttf" } },
];

/** Fallback chain appended after the chosen family, so any Latin/Arabic text renders. */
export const FALLBACK_FAMILIES: BuiltinFamily[] = ["noto-sans", "noto-sans-arabic"];

export const fontkit = fontkitModule as unknown as Fontkit;

// Minimal structural types for the parts of fontkit we use.
export interface FkGlyph {
  id: number;
  advanceWidth: number;
  codePoints: number[];
}
export interface FkPosition {
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}
export interface FkRun {
  glyphs: FkGlyph[];
  positions: FkPosition[];
  advanceWidth: number;
}
export interface FkFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  hasGlyphForCodePoint(cp: number): boolean;
  layout(text: string, features?: unknown, script?: string, language?: string, direction?: string): FkRun;
}

/** A concrete face (family + weight) able to measure text. */
export interface Face {
  key: string; // unique, e.g. "helvetica:bold" or "noto-sans:regular"
  family: FontFamilyId;
  bold: boolean;
  kind: "standard" | "ttf";
  css: string;
  ascent: number; // em units
  descent: number; // em units (negative)
  hasChar(cp: number): boolean;
  /** width in points of `text` laid out as one run */
  measure(text: string, size: number, rtl: boolean): number;
  std?: { name: FontNames; italicName: FontNames };
  ttf?: { font: FkFont; bytes: Uint8Array };
}

const stdCache = new Map<string, StdFont>();
function std(name: FontNames) {
  let f = stdCache.get(name);
  if (!f) stdCache.set(name, (f = StdFont.load(name)));
  return f;
}

export function makeStandardFace(info: FamilyInfo, bold: boolean): Face {
  const s = info.std!;
  const name = bold ? s.bold : s.regular;
  const metrics = std(name);
  const enc = Encodings.WinAnsi;
  return {
    key: `${info.id}:${bold ? "bold" : "regular"}`,
    family: info.id,
    bold,
    kind: "standard",
    css: info.css,
    ascent: (metrics.Ascender ?? 718) / 1000,
    descent: (metrics.Descender ?? -207) / 1000,
    hasChar: (cp) => cp === 10 || enc.canEncodeUnicodeCodePoint(cp),
    measure: (text, size) => {
      let w = 0;
      for (const ch of Array.from(text)) {
        const cp = ch.codePointAt(0)!;
        if (!enc.canEncodeUnicodeCodePoint(cp)) continue;
        w += metrics.getWidthOfGlyph(enc.encodeUnicodeCodePoint(cp).name) ?? 0;
      }
      return (w * size) / 1000;
    },
    std: { name, italicName: bold ? s.boldItalic : s.italic },
  };
}

/**
 * fontkit's layout can throw on some inputs (e.g. an Arabic mark with no base
 * glyph: "Cannot read properties of null (reading 'xCoordinate')"). Never let
 * that break the editor: retry without mark positioning, then without any
 * GPOS features, and finally fall back to unshaped glyphs with plain advances.
 */
export function safeLayout(font: FkFont, text: string, rtl: boolean): FkRun {
  const dir = rtl ? "rtl" : "ltr";
  const attempts: unknown[] = [undefined, { mark: false, mkmk: false }, { mark: false, mkmk: false, kern: false, curs: false, dist: false }];
  for (const features of attempts) {
    try {
      return font.layout(text, features, undefined, undefined, dir);
    } catch {
      /* try the next, simpler configuration */
    }
  }
  const f = font as unknown as { glyphsForString(t: string): FkGlyph[] };
  let glyphs: FkGlyph[] = [];
  try {
    glyphs = f.glyphsForString(text);
  } catch {
    glyphs = [];
  }
  if (rtl) glyphs = [...glyphs].reverse();
  const positions = glyphs.map((g) => ({ xAdvance: g.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 }));
  return { glyphs, positions, advanceWidth: positions.reduce((n, p) => n + p.xAdvance, 0) };
}

export function makeTtfFace(family: FontFamilyId, css: string, bytes: Uint8Array, bold: boolean): Face {
  const font = fontkit.create(bytes) as unknown as FkFont;
  const upm = font.unitsPerEm;
  return {
    key: `${family}:${bold ? "bold" : "regular"}`,
    family,
    bold,
    kind: "ttf",
    css,
    ascent: font.ascent / upm,
    descent: font.descent / upm,
    hasChar: (cp) => cp === 32 || font.hasGlyphForCodePoint(cp),
    measure: (text, size, rtl) => {
      if (!text) return 0;
      const run = safeLayout(font, text, rtl);
      let adv = 0;
      for (const p of run.positions) adv += p.xAdvance;
      return (adv * size) / upm;
    },
    ttf: { font, bytes },
  };
}

export function familyInfo(id: FontFamilyId): FamilyInfo | undefined {
  return BUILTIN_FAMILIES.find((f) => f.id === id);
}

/** Loads bytes for a font file. Provided by the environment (fetch in the browser, fs in tests). */
export type FontFileLoader = (fileName: string) => Promise<Uint8Array>;
/** Loads bytes for a user-uploaded font asset. */
export type CustomFontLoader = (assetId: string) => Promise<{ bytes: Uint8Array; name: string } | undefined>;

/** Async face registry (cache) shared by the UI and the exporter. */
export class FaceRegistry {
  private faces = new Map<string, Promise<Face | undefined>>();
  constructor(
    private loadFile: FontFileLoader,
    private loadCustom: CustomFontLoader = async () => undefined,
  ) {}

  get(family: FontFamilyId, bold: boolean): Promise<Face | undefined> {
    const key = `${family}:${bold ? "bold" : "regular"}`;
    let p = this.faces.get(key);
    if (!p) {
      p = this.create(family, bold).catch((e) => {
        console.warn("Font load failed", key, e);
        return undefined;
      });
      this.faces.set(key, p);
    }
    return p;
  }

  private async create(family: FontFamilyId, bold: boolean): Promise<Face | undefined> {
    if (family.startsWith("custom:")) {
      const asset = await this.loadCustom(family.slice(7));
      if (!asset) return undefined;
      // custom fonts have a single weight; bold is rendered with the same face
      const face = makeTtfFace(family, `'PE custom ${family.slice(7)}'`, asset.bytes, false);
      return { ...face, key: `${family}:${bold ? "bold" : "regular"}`, bold };
    }
    const info = familyInfo(family);
    if (!info) return undefined;
    if (info.kind === "standard") return makeStandardFace(info, bold);
    const bytes = await this.loadFile(bold ? info.files!.bold : info.files!.regular);
    return makeTtfFace(family, info.css, bytes, bold);
  }

  /** chosen face followed by fallbacks */
  async chain(family: FontFamilyId, bold: boolean): Promise<Face[]> {
    const ids: FontFamilyId[] = [family, ...FALLBACK_FAMILIES.filter((f) => f !== family)];
    const faces = await Promise.all(ids.map((id) => this.get(id, bold)));
    return faces.filter((f): f is Face => !!f);
  }
}
