import type { FontFamilyId } from "../text/fontFaces";
import type { TextAlign, TextDir } from "../text/layout";

/**
 * Editor document model. Everything here is plain, serialisable data so it can
 * be kept in undo history cheaply (structural sharing) and sent to the export
 * worker. Large binary data (PDF sources, images, fonts) lives in append-only
 * stores keyed by id and is never duplicated in history.
 */

export type Rotation = 0 | 90 | 180 | 270;

export interface PageGeometry {
  /** unrotated width/height in points (view box = crop box ∩ media box) */
  width: number;
  height: number;
  /** view box in PDF user space [x0, y0, x1, y1] */
  viewBox: [number, number, number, number];
  /** /Rotate already present in the source page */
  baseRotation: Rotation;
}

export interface SourceInfo {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  pages: PageGeometry[];
  /** pdf-lib could not open it (e.g. encrypted) – view only */
  readOnlyReason?: string;
  hasForm: boolean;
}

export type PageOrigin = { kind: "source"; sourceId: string; index: number } | { kind: "blank"; width: number; height: number };

export interface PageEntry {
  id: string;
  origin: PageOrigin;
  /** rotation added by the user (on top of baseRotation) */
  rotation: Rotation;
}

export interface ObjBase {
  id: string;
  pageId: string;
  /** box in unrotated page space: points, origin at the top-left of the view box */
  x: number;
  y: number;
  w: number;
  h: number;
  /** clockwise rotation in degrees (as displayed), used to keep objects upright on rotated pages */
  rotation: number;
}

export interface TextStyle {
  family: FontFamilyId;
  size: number;
  color: string; // #rrggbb
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  dir: TextDir;
  lineHeight: number;
}

export interface TextObj extends ObjBase, TextStyle {
  kind: "text";
  text: string;
}

/** Mode B: visual replacement – covers the original area and draws new text on top. */
export interface ReplaceObj extends ObjBase, TextStyle {
  kind: "replace";
  text: string;
  cover: string; // #rrggbb background used to cover the original
  originalText?: string;
}

export interface ImageObj extends ObjBase {
  kind: "image";
  assetId: string;
  opacity: number;
  signature?: boolean;
}

export interface InkObj extends ObjBase {
  kind: "ink";
  /** strokes; points normalised to the box (0..1) */
  strokes: [number, number][][];
  color: string;
  width: number;
  opacity: number;
}

export interface ShapeObj extends ObjBase {
  kind: "rect" | "ellipse";
  stroke: string | null;
  fill: string | null;
  strokeWidth: number;
  opacity: number;
}

export interface LineObj extends ObjBase {
  kind: "line";
  /** endpoints normalised to the box */
  p1: [number, number];
  p2: [number, number];
  stroke: string;
  strokeWidth: number;
  arrow: boolean;
  opacity: number;
}

export interface HighlightObj extends ObjBase {
  kind: "highlight";
  color: string;
  opacity: number;
}

export type EditorObject = TextObj | ReplaceObj | ImageObj | InkObj | ShapeObj | LineObj | HighlightObj;

/** Mode A edits: sourceId → page index → line id → new text */
export type NativeEdits = Record<string, Record<number, Record<string, { text: string; original: string }>>>;

export type FormValue = string | boolean | string[];

export interface EditorDoc {
  pages: PageEntry[];
  objects: EditorObject[];
  nativeEdits: NativeEdits;
  /** AcroForm values of the primary source, keyed by fully-qualified field name */
  formValues: Record<string, FormValue>;
}

export interface Asset {
  id: string;
  kind: "image" | "font";
  mime: string;
  name: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
}

export const emptyDoc = (): EditorDoc => ({ pages: [], objects: [], nativeEdits: {}, formValues: {} });

export function pageGeometry(page: PageEntry, sources: Record<string, SourceInfo>): PageGeometry {
  if (page.origin.kind === "blank") {
    const { width, height } = page.origin;
    return { width, height, viewBox: [0, 0, width, height], baseRotation: 0 };
  }
  const src = sources[page.origin.sourceId];
  return src.pages[page.origin.index];
}

export function totalRotation(page: PageEntry, sources: Record<string, SourceInfo>): Rotation {
  return (((pageGeometry(page, sources).baseRotation + page.rotation) % 360) as Rotation);
}
