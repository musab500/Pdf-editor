import { describe, expect, it } from "vitest";
import { historyReducer, initialHistory, isDirty } from "@/lib/model/history";
import { addObject, deletePages, duplicatePages, insertBlankPage, movePages, rotatePages, setNativeEdit, updateObject } from "@/lib/model/ops";
import { docWith, pagesOf, textObj } from "./helpers";
import { baseName, editedFileName, pagesFileName, parseRanges, sanitizeFileName } from "@/lib/files/filename";
import { hasPdfHeader, validatePdfFile } from "@/lib/files/validate";
import { textFound } from "@/lib/pdf/verify";
import { resizeBox, rotCW, uprightBox } from "@/components/editor/geometry";

describe("history", () => {
  it("undoes and redoes, coalescing rapid typing into one step", () => {
    let h = historyReducer(initialHistory(), { type: "reset", doc: docWith(pagesOf("s", 2)) });
    const t = textObj("p0", "");
    h = historyReducer(h, { type: "commit", doc: addObject(h.present, t), label: "add" });
    for (const [i, s] of ["H", "He", "Hel"].entries()) h = historyReducer(h, { type: "commit", doc: updateObject(h.present, t.id, { text: s }), label: "type", key: "k", now: 1000 + i * 100 });
    expect(h.past).toHaveLength(2);
    expect(isDirty(h)).toBe(true);
    h = historyReducer(h, { type: "undo" });
    expect(h.present.objects[0]).toMatchObject({ text: "" });
    h = historyReducer(h, { type: "undo" });
    expect(h.present.objects).toHaveLength(0);
    expect(isDirty(h)).toBe(false);
    h = historyReducer(h, { type: "redo" });
    h = historyReducer(h, { type: "redo" });
    expect(h.present.objects[0]).toMatchObject({ text: "Hel" });
    h = historyReducer(h, { type: "markSaved" });
    expect(isDirty(h)).toBe(false);
  });

  it("clears the redo stack on a new change", () => {
    let h = historyReducer(initialHistory(), { type: "reset", doc: docWith(pagesOf("s", 2)) });
    h = historyReducer(h, { type: "commit", doc: rotatePages(h.present, ["p0"], 90), label: "r" });
    h = historyReducer(h, { type: "undo" });
    h = historyReducer(h, { type: "commit", doc: deletePages(h.present, ["p1"]), label: "d" });
    expect(h.future).toHaveLength(0);
  });
});

describe("page operations", () => {
  const base = docWith(pagesOf("s", 5));
  it("moves pages before/after", () => {
    expect(movePages(base, ["p0"], 3).pages.map((p) => p.id)).toEqual(["p1", "p2", "p0", "p3", "p4"]);
    expect(movePages(base, ["p3", "p4"], 0).pages.map((p) => p.id)).toEqual(["p3", "p4", "p0", "p1", "p2"]);
    expect(movePages(base, ["p1"], 5).pages.map((p) => p.id)).toEqual(["p0", "p2", "p3", "p4", "p1"]);
  });
  it("rotates in 90° steps and wraps", () => {
    let d = rotatePages(base, ["p0"], -90);
    expect(d.pages[0].rotation).toBe(270);
    d = rotatePages(d, ["p0"], 180);
    expect(d.pages[0].rotation).toBe(90);
  });
  it("duplicates pages with their objects and deletes objects with their pages", () => {
    let d = addObject(base, textObj("p1", "x"));
    d = duplicatePages(d, ["p1"]);
    expect(d.pages).toHaveLength(6);
    expect(d.objects).toHaveLength(2);
    expect(d.objects[1].pageId).toBe(d.pages[2].id);
    d = deletePages(d, ["p1"]);
    expect(d.objects).toHaveLength(1);
  });
  it("inserts blank pages", () => {
    const r = insertBlankPage(base, 2, 100, 200);
    expect(r.doc.pages[2]).toMatchObject({ id: r.pageId, origin: { kind: "blank", width: 100, height: 200 } });
  });
  it("stores and removes native edits", () => {
    let d = setNativeEdit(base, "s", 0, "L1", "new", "old");
    expect(d.nativeEdits.s[0].L1.text).toBe("new");
    d = setNativeEdit(d, "s", 0, "L1", "old", "old");
    expect(d.nativeEdits).toEqual({});
  });
});

describe("file names, ranges and validation", () => {
  it("derives and sanitizes names", () => {
    expect(editedFileName("Report 2024.PDF")).toBe("Report 2024-edited.pdf");
    expect(pagesFileName("a.pdf", "p1-3")).toBe("a-p1-3.pdf");
    expect(sanitizeFileName('a<b>:c"d|e?*')).toBe("a_b__c_d_e__.pdf");
    expect(sanitizeFileName("CON")).toBe("_CON.pdf");
    expect(sanitizeFileName("  ")).toBe("document.pdf");
    expect(baseName("x.pdf")).toBe("x");
    expect(sanitizeFileName("تقرير.pdf")).toBe("تقرير.pdf");
  });
  it("parses page ranges", () => {
    expect(parseRanges("1-3, 5, 7-", 8)).toEqual({ ranges: [[0, 1, 2], [4], [6, 7]] });
    expect(parseRanges("4-2", 8)).toHaveProperty("error");
    expect(parseRanges("9", 8)).toHaveProperty("error");
    expect(parseRanges("a", 8)).toHaveProperty("error");
    expect(parseRanges("", 8)).toHaveProperty("error");
  });
  it("validates PDF input", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(validatePdfFile("a.pdf", "application/pdf", new Uint8Array())).toMatchObject({ ok: false });
    expect(validatePdfFile("a.pdf", "application/pdf", enc("hello"))).toMatchObject({ ok: false });
    expect(validatePdfFile("a.png", "image/png", enc("\x89PNG"))).toMatchObject({ ok: false });
    expect(validatePdfFile("a.pdf", "", enc("junk%PDF-1.7\n..."))).toMatchObject({ ok: true });
    expect(hasPdfHeader(enc("%PDF-2.0"))).toBe(true);
  });
});

describe("verification text matching", () => {
  it("is whitespace-tolerant and handles RTL extraction order", () => {
    expect(textFound("Hello  world", "xx Hello world yy")).toBe(true);
    expect(textFound("مرحبا", "ابحرم")).toBe(true);
    expect(textFound("missing", "something else")).toBe(false);
  });
});

describe("geometry", () => {
  it("rotates vectors clockwise", () => {
    const [x, y] = rotCW(1, 0, 90);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
  });
  it("resizes from a corner keeping the opposite corner fixed", () => {
    const b = resizeBox({ x: 10, y: 10, w: 100, h: 50, rotation: 0 }, 1, 1, { x: 150, y: 100 });
    expect(b).toMatchObject({ x: 10, y: 10, w: 140, h: 90 });
    const r = resizeBox({ x: 10, y: 10, w: 100, h: 50, rotation: 90 }, 1, 0, { x: 60, y: 200 });
    // rotated 90° clockwise: the local right edge faces down; anchor is the opposite edge at y = 35 - 50
    expect(r.w).toBeCloseTo(215, 3);
    expect(r.h).toBe(50);
  });
  it("creates upright boxes on rotated pages", () => {
    expect(uprightBox({ x: 0, y: 0, w: 100, h: 20 }, 90)).toMatchObject({ w: 20, h: 100, rotation: 270 });
    expect(uprightBox({ x: 0, y: 0, w: 100, h: 20 }, 0)).toMatchObject({ w: 100, h: 20, rotation: 0 });
  });
});
