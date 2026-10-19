import type { EditorDoc, EditorObject, FormValue, PageEntry, Rotation } from "./types";

/** Pure document operations. Each returns a new EditorDoc (inputs are never mutated). */

let counter = 0;
export function newId(prefix: string): string {
  counter++;
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rnd}${counter}`;
}

export function addObject(doc: EditorDoc, obj: EditorObject): EditorDoc {
  return { ...doc, objects: [...doc.objects, obj] };
}

export function updateObject(doc: EditorDoc, id: string, patch: Partial<EditorObject>): EditorDoc {
  return { ...doc, objects: doc.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as EditorObject) : o)) };
}

export function deleteObjects(doc: EditorDoc, ids: string[]): EditorDoc {
  const s = new Set(ids);
  return { ...doc, objects: doc.objects.filter((o) => !s.has(o.id)) };
}

export function reorderObject(doc: EditorDoc, id: string, dir: "front" | "back"): EditorDoc {
  const obj = doc.objects.find((o) => o.id === id);
  if (!obj) return doc;
  const rest = doc.objects.filter((o) => o.id !== id);
  return { ...doc, objects: dir === "front" ? [...rest, obj] : [obj, ...rest] };
}

export function insertBlankPage(doc: EditorDoc, at: number, width: number, height: number): { doc: EditorDoc; pageId: string } {
  const page: PageEntry = { id: newId("pg"), origin: { kind: "blank", width, height }, rotation: 0 };
  const pages = [...doc.pages];
  pages.splice(Math.max(0, Math.min(at, pages.length)), 0, page);
  return { doc: { ...doc, pages }, pageId: page.id };
}

export function deletePages(doc: EditorDoc, ids: string[]): EditorDoc {
  const s = new Set(ids);
  return { ...doc, pages: doc.pages.filter((p) => !s.has(p.id)), objects: doc.objects.filter((o) => !s.has(o.pageId)) };
}

export function rotatePages(doc: EditorDoc, ids: string[], delta: 90 | -90 | 180): EditorDoc {
  const s = new Set(ids);
  return {
    ...doc,
    pages: doc.pages.map((p) => (s.has(p.id) ? { ...p, rotation: ((((p.rotation + delta) % 360) + 360) % 360) as Rotation } : p)),
  };
}

/** Move the given pages (kept in their current relative order) so they start at `to` in the remaining list. */
export function movePages(doc: EditorDoc, ids: string[], to: number): EditorDoc {
  const s = new Set(ids);
  const moving = doc.pages.filter((p) => s.has(p.id));
  const before = doc.pages.slice(0, to).filter((p) => !s.has(p.id)).length;
  const rest = doc.pages.filter((p) => !s.has(p.id));
  rest.splice(before, 0, ...moving);
  return { ...doc, pages: rest };
}

/** Duplicate pages (including their added objects) right after each original. */
export function duplicatePages(doc: EditorDoc, ids: string[]): EditorDoc {
  const s = new Set(ids);
  const pages: PageEntry[] = [];
  const objects = [...doc.objects];
  for (const p of doc.pages) {
    pages.push(p);
    if (!s.has(p.id)) continue;
    const copy: PageEntry = { ...p, id: newId("pg") };
    pages.push(copy);
    for (const o of doc.objects) if (o.pageId === p.id) objects.push({ ...o, id: newId("obj"), pageId: copy.id } as EditorObject);
  }
  return { ...doc, pages, objects };
}

export function insertSourcePages(doc: EditorDoc, sourceId: string, indices: number[], at: number): { doc: EditorDoc; pageIds: string[] } {
  const newPages: PageEntry[] = indices.map((index) => ({ id: newId("pg"), origin: { kind: "source", sourceId, index }, rotation: 0 }));
  const pages = [...doc.pages];
  pages.splice(Math.max(0, Math.min(at, pages.length)), 0, ...newPages);
  return { doc: { ...doc, pages }, pageIds: newPages.map((p) => p.id) };
}

export function setNativeEdit(doc: EditorDoc, sourceId: string, pageIndex: number, lineId: string, text: string, original: string): EditorDoc {
  const src = { ...(doc.nativeEdits[sourceId] ?? {}) };
  const page = { ...(src[pageIndex] ?? {}) };
  if (text === original) delete page[lineId];
  else page[lineId] = { text, original };
  if (Object.keys(page).length) src[pageIndex] = page;
  else delete src[pageIndex];
  const nativeEdits = { ...doc.nativeEdits };
  if (Object.keys(src).length) nativeEdits[sourceId] = src;
  else delete nativeEdits[sourceId];
  return { ...doc, nativeEdits };
}

export function setFormValue(doc: EditorDoc, name: string, value: FormValue): EditorDoc {
  return { ...doc, formValues: { ...doc.formValues, [name]: value } };
}
