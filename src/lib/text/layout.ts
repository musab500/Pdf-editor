import bidiFactory from "bidi-js";
import type { Face } from "./fontFaces";

/**
 * Shared text layout for added text. The SAME layout is used to render the
 * on-screen preview and to write the PDF, so line breaks and positions match.
 *
 * Handles: explicit newlines, greedy word wrap, per-character font fallback,
 * and the Unicode Bidirectional Algorithm (Arabic/Hebrew + Latin + digits).
 */

const bidi = bidiFactory();

export type TextAlign = "start" | "left" | "center" | "right" | "end";
export type TextDir = "auto" | "ltr" | "rtl";

export interface LayoutOptions {
  width: number; // available width in points (box width minus padding)
  size: number;
  lineHeight: number; // multiple of size
  align: TextAlign;
  dir: TextDir;
  wrap?: boolean;
}

export interface LayoutRun {
  text: string; // logical-order text of the run
  face: Face;
  rtl: boolean;
  x: number; // offset from the line's left edge
  width: number;
}

export interface LayoutLine {
  runs: LayoutRun[];
  width: number;
  x: number; // left offset inside the box (after alignment)
  baseline: number; // offset from box top to the baseline
  text: string;
}

export interface TextLayout {
  lines: LayoutLine[];
  height: number;
  rtlBase: boolean;
  missingChars: string[];
}

const RTL_STRONG = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_STRONG = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

export function detectBaseRtl(text: string, dir: TextDir): boolean {
  if (dir === "rtl") return true;
  if (dir === "ltr") return false;
  for (const ch of text) {
    if (RTL_STRONG.test(ch)) return true;
    if (LTR_STRONG.test(ch)) return false;
  }
  return false;
}

function pickFace(cp: number, faces: Face[]): Face | undefined {
  for (const f of faces) if (f.hasChar(cp)) return f;
  return undefined;
}

/** Width of a logical string as it will be drawn (fallback-aware, bidi-aware). */
function measureLogical(text: string, faces: Face[], size: number, rtlBase: boolean): number {
  return visualRuns(text, faces, rtlBase).reduce((n, r) => n + r.face.measure(r.text, size, r.rtl), 0);
}

interface VRun {
  text: string;
  face: Face;
  rtl: boolean;
}

/** Split one line into visual-order runs, each drawable with a single face and direction. */
export function visualRuns(line: string, faces: Face[], rtlBase: boolean, missing?: Set<string>): VRun[] {
  if (!line) return [];
  const chars = Array.from(line);
  // map code-unit indices → char indices
  const levels = bidi.getEmbeddingLevels(line, rtlBase ? "rtl" : "ltr");
  const mirrors = bidi.getMirroredCharactersMap(line, levels.levels);
  const order = bidi.getReorderedIndices(line, levels); // visual order of code-unit indices
  const unitToChar: number[] = [];
  const charFace: (Face | undefined)[] = [];
  let ci = 0;
  for (const ch of chars) {
    for (let k = 0; k < ch.length; k++) unitToChar.push(ci);
    ci++;
  }
  // assign faces in logical order; spaces/marks inherit the previous face to avoid needless switches
  let prevFace: Face | undefined;
  chars.forEach((ch, i) => {
    const cp = ch.codePointAt(0)!;
    // spaces and combining marks stay with the previous character's face (a mark must never start a run)
    const isNeutral = /[\s\p{M}]/u.test(ch);
    let f = isNeutral && prevFace && prevFace.hasChar(cp) ? prevFace : pickFace(cp, faces);
    if (!f) {
      missing?.add(ch);
      f = faces[0];
    }
    charFace[i] = f;
    prevFace = f;
  });
  const runs: VRun[] = [];
  let cur: { idx: number[]; face: Face; rtl: boolean } | undefined;
  const seen = new Set<number>();
  const flush = () => {
    if (!cur) return;
    // logical order inside the run
    const idx = [...cur.idx].sort((a, b) => a - b);
    let text = "";
    for (const i of idx) {
      const unitIdx = unitToChar.indexOf(i);
      const m = cur.rtl ? mirrors.get(unitIdx) : undefined;
      text += m ?? chars[i];
    }
    runs.push({ text, face: cur.face, rtl: cur.rtl });
    cur = undefined;
  };
  for (const u of order) {
    const i = unitToChar[u];
    if (seen.has(i)) continue; // surrogate pair second unit
    seen.add(i);
    const rtl = (levels.levels[u] & 1) === 1;
    const face = charFace[i]!;
    const last = cur?.idx[cur.idx.length - 1];
    const contiguous = cur && cur.face === face && cur.rtl === rtl && last !== undefined && (rtl ? i === last - 1 : i === last + 1);
    if (contiguous) cur!.idx.push(i);
    else {
      flush();
      cur = { idx: [i], face, rtl };
    }
  }
  flush();
  return runs;
}

function wrapParagraph(par: string, faces: Face[], size: number, width: number, rtlBase: boolean): string[] {
  if (!par) return [""];
  const tokens = par.match(/\s+|[^\s]+/g) ?? [par];
  const lines: string[] = [];
  let cur = "";
  const fits = (s: string) => measureLogical(s.trimEnd(), faces, size, rtlBase) <= width + 0.01;
  for (const tok of tokens) {
    const cand = cur + tok;
    if (fits(cand) || !cur.trim()) {
      if (!fits(cand) && !/^\s+$/.test(tok)) {
        // a single word longer than the line: break by characters
        let piece = cur;
        for (const ch of Array.from(tok)) {
          if (fits(piece + ch) || !piece) piece += ch;
          else {
            lines.push(piece);
            piece = ch;
          }
        }
        cur = piece;
      } else cur = cand;
    } else {
      lines.push(cur.trimEnd());
      cur = /^\s+$/.test(tok) ? "" : tok;
    }
  }
  lines.push(cur.trimEnd());
  return lines;
}

export function layoutText(text: string, faces: Face[], opts: LayoutOptions): TextLayout {
  const rtlBase = detectBaseRtl(text, opts.dir);
  const primary = faces[0];
  const asc = primary?.ascent ?? 0.8;
  const lineGap = opts.size * opts.lineHeight;
  const missing = new Set<string>();
  const lines: LayoutLine[] = [];
  const paragraphs = text.replace(/\r\n?/g, "\n").split("\n");
  for (const par of paragraphs) {
    const wrapped = opts.wrap === false ? [par] : wrapParagraph(par, faces, opts.size, opts.width, rtlBase);
    for (const l of wrapped) {
      const runs = visualRuns(l, faces, rtlBase, missing);
      let x = 0;
      const lruns: LayoutRun[] = runs.map((r) => {
        const w = r.face.measure(r.text, opts.size, r.rtl);
        const run = { ...r, x, width: w };
        x += w;
        return run;
      });
      const width = x;
      let align = opts.align;
      if (align === "start") align = rtlBase ? "right" : "left";
      if (align === "end") align = rtlBase ? "left" : "right";
      const off = align === "center" ? (opts.width - width) / 2 : align === "right" ? opts.width - width : 0;
      lines.push({
        runs: lruns,
        width,
        x: off,
        baseline: lines.length * lineGap + asc * opts.size + (lineGap - opts.size) / 2,
        text: l,
      });
    }
  }
  return { lines, height: lines.length * lineGap, rtlBase, missingChars: [...missing] };
}
