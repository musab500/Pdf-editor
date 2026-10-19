import fs from "node:fs";
import path from "node:path";
import { FaceRegistry } from "@/lib/text/fontFaces";
import type { EditorDoc, PageEntry, TextObj } from "@/lib/model/types";

export const FIX = (n: string) => new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "../fixtures", n)));
export const faces = () =>
  new FaceRegistry(async (f) => new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "../../public/fonts", f))));

let n = 0;
export const uid = (p = "id") => `${p}${++n}`;

export function pagesOf(sourceId: string, count: number): PageEntry[] {
  return Array.from({ length: count }, (_, i) => ({ id: `p${i}`, origin: { kind: "source", sourceId, index: i }, rotation: 0 }));
}

export function docWith(pages: PageEntry[], extra: Partial<EditorDoc> = {}): EditorDoc {
  return { pages, objects: [], nativeEdits: {}, formValues: {}, ...extra };
}

export function textObj(pageId: string, text: string, extra: Partial<TextObj> = {}): TextObj {
  return {
    id: uid("t"), kind: "text", pageId, x: 50, y: 100, w: 300, h: 60, rotation: 0, text,
    family: "helvetica", size: 14, color: "#000000", bold: false, italic: false, align: "start", dir: "auto", lineHeight: 1.25,
    ...extra,
  };
}
