import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, PDFRawStream, PDFStream, decodePDFRawStream, PDFTextField } from "pdf-lib";
import { exportPdf } from "@/lib/pdf/exporter";
import type { Asset, EditorDoc, PageEntry } from "@/lib/model/types";
import { FIX, docWith, faces, pagesOf, textObj } from "./helpers";
import { extractText, openPdfjs } from "./pdfText";
import { buildExpectations, verifyExport } from "@/lib/pdf/verify";

const run = (doc: EditorDoc, sources: Record<string, Uint8Array>, extra: Partial<Parameters<typeof exportPdf>[0]> = {}) =>
  exportPdf({ primarySourceId: "s", sources, doc, assets: {}, ...extra }, faces());

/** All decoded stream contents of a PDF, concatenated (to look for leftovers). */
async function allStreamText(bytes: Uint8Array): Promise<string> {
  const d = await PDFDocument.load(bytes);
  let s = "";
  for (const [, obj] of d.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      try {
        s += Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1");
      } catch {
        /* images etc */
      }
    } else if (obj instanceof PDFStream) s += Buffer.from(obj.getContents()).toString("latin1");
  }
  return s;
}
const hex = (t: string) => Buffer.from(t, "latin1").toString("hex").toUpperCase();

describe("export pipeline", () => {
  it("exports an unmodified document with identical text and page geometry", async () => {
    const src = FIX("sizes-rotations.pdf");
    const r = await run(docWith(pagesOf("s", 4)), { s: src });
    const a = await PDFDocument.load(src);
    const b = await PDFDocument.load(r.bytes);
    expect(b.getPageCount()).toBe(4);
    b.getPages().forEach((p, i) => {
      const q = a.getPage(i);
      expect(p.getRotation().angle).toBe(q.getRotation().angle);
      expect(p.getCropBox()).toEqual(q.getCropBox());
      expect(p.getMediaBox()).toEqual(q.getMediaBox());
    });
    expect(await extractText(r.bytes)).toEqual(await extractText(src));
  });

  it("deletes, reorders, rotates, duplicates and inserts blank pages", async () => {
    const pages = pagesOf("s", 3);
    const order: PageEntry[] = [
      { ...pages[2], rotation: 90 },
      pages[0],
      { id: "blank", origin: { kind: "blank", width: 300, height: 200 }, rotation: 0 },
      { ...pages[2], id: "dup" },
    ];
    const r = await run(docWith(order), { s: FIX("simple.pdf") });
    const d = await PDFDocument.load(r.bytes);
    expect(d.getPageCount()).toBe(4);
    expect(d.getPage(0).getRotation().angle).toBe(90);
    expect(d.getPage(3).getRotation().angle).toBe(0);
    expect([d.getPage(2).getWidth(), d.getPage(2).getHeight()]).toEqual([300, 200]);
    const t = await extractText(r.bytes);
    expect(t[0]).toContain("Page 3 heading");
    expect(t[1]).toContain("Page 1 heading");
    expect(t[2].trim()).toBe("");
    expect(t[3]).toContain("Page 3 heading");
    // page 2 was deleted: its content must not remain anywhere in the file
    const streams = await allStreamText(r.bytes);
    expect(streams).not.toContain(hex("Page 2 heading"));
    expect(streams).not.toContain("Page 2 heading");
    expect(streams).toContain(hex("Page 1 heading"));
  });

  it("merges pages from other documents and keeps their sizes", async () => {
    const pages: PageEntry[] = [
      ...pagesOf("s", 1),
      { id: "m1", origin: { kind: "source", sourceId: "o", index: 1 }, rotation: 0 },
      { id: "m2", origin: { kind: "source", sourceId: "o", index: 2 }, rotation: 0 },
      { id: "f1", origin: { kind: "source", sourceId: "f", index: 0 }, rotation: 0 },
    ];
    const r = await run(docWith(pages), { s: FIX("simple.pdf"), o: FIX("sizes-rotations.pdf"), f: FIX("form-annots.pdf") });
    const d = await PDFDocument.load(r.bytes);
    expect(d.getPageCount()).toBe(4);
    expect([d.getPage(1).getWidth(), d.getPage(1).getHeight()]).toEqual([792, 612]);
    expect(d.getPage(2).getRotation().angle).toBe(90);
    // forms on imported pages are flattened (the value stays visible as page content)
    expect(d.getForm().getFields()).toHaveLength(0);
    expect(r.report.warnings.join()).toMatch(/flattened/);
    const t = await extractText(r.bytes);
    expect(t[3]).toContain("Name:");
  });

  it("draws added text (Latin, Arabic, mixed) into the page", async () => {
    const doc = docWith(pagesOf("s", 1), {
      objects: [
        textObj("p0", "Plain Helvetica"),
        textObj("p0", "مرحبا بالعالم", { y: 200, family: "noto-naskh-arabic", size: 18, dir: "auto" }),
        textObj("p0", "Total: 50 ريال (SAR)", { y: 300, family: "noto-sans-arabic" }),
        textObj("p0", "Ünïcödé €", { y: 400, family: "noto-sans", bold: true, italic: true }),
      ],
    });
    const r = await run(doc, { s: FIX("simple.pdf") });
    const t = (await extractText(r.bytes))[0];
    expect(t).toContain("Plain Helvetica");
    expect(t).toContain("Ünïcödé €");
    expect(t).toContain("Invoice total: 120 USD");
    for (const ch of "مرحبابالعالمريال") expect(t).toContain(ch);
    expect(t).toContain("SAR");
    expect(r.report.warnings).toEqual([]);
  });

  it("covers original text with a visual replacement (and the original still exists)", async () => {
    const doc = docWith(pagesOf("s", 1), {
      objects: [{ ...textObj("p0", "NEW TEXT"), kind: "replace", cover: "#ffffff", x: 49, y: 92, w: 200, h: 16 } as EditorDoc["objects"][number]],
    });
    const r = await run(doc, { s: FIX("simple.pdf") });
    const t = (await extractText(r.bytes))[0];
    expect(t).toContain("NEW TEXT");
    expect(t).toContain("Invoice total: 120 USD"); // covered, NOT removed – documented behaviour
  });

  it("embeds images and vector objects", async () => {
    const png = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "../fixtures/sample.png")));
    const assets: Record<string, Asset> = { a1: { id: "a1", kind: "image", mime: "image/png", name: "s.png", bytes: png, width: 200, height: 120 } };
    const base = { pageId: "p0", rotation: 0 };
    const doc = docWith(pagesOf("s", 1), {
      objects: [
        { ...base, id: "i", kind: "image", assetId: "a1", x: 50, y: 50, w: 100, h: 60, opacity: 1 },
        { ...base, id: "k", kind: "ink", x: 10, y: 300, w: 100, h: 50, strokes: [[[0, 0], [0.5, 1], [1, 0]]], color: "#ff0000", width: 2, opacity: 1 },
        { ...base, id: "r", kind: "rect", x: 200, y: 300, w: 80, h: 40, stroke: "#0000ff", fill: null, strokeWidth: 2, opacity: 1 },
        { ...base, id: "e", kind: "ellipse", x: 300, y: 300, w: 80, h: 40, stroke: null, fill: "#00ff00", strokeWidth: 1, opacity: 0.5 },
        { ...base, id: "l", kind: "line", x: 50, y: 400, w: 100, h: 1, p1: [0, 0], p2: [1, 1], stroke: "#000000", strokeWidth: 1, arrow: true, opacity: 1 },
        { ...base, id: "h", kind: "highlight", x: 49, y: 92, w: 150, h: 16, color: "#ffff00", opacity: 0.4 },
        { ...base, id: "rot", kind: "image", assetId: "a1", x: 300, y: 50, w: 100, h: 60, opacity: 1, rotation: 270 },
      ],
    });
    const r = await run(doc, { s: FIX("simple.pdf") }, { assets });
    const { pdfjs, doc: pdf } = await openPdfjs(r.bytes);
    const ops = await (await pdf.getPage(1)).getOperatorList();
    const imgs = ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject).length;
    expect(imgs).toBe(2);
    await pdf.loadingTask.destroy();
    const content = await allStreamText(r.bytes);
    expect(content).toMatch(/\/GS\d*-?\d* gs|gs\n/); // opacity / blend graphics states
    expect(content).toMatch(/ cm\n/); // rotated object
  });

  it("writes form values, including a Unicode (Arabic) value with its own appearance", async () => {
    const doc = docWith(pagesOf("s", 1), { formValues: { "applicant.name": "محمد Ali", subscribe: true, plan: "pro", country: "Other" } });
    const r = await run(doc, { s: FIX("form-annots.pdf") });
    const d = await PDFDocument.load(r.bytes);
    const f = d.getForm();
    expect((f.getField("applicant.name") as PDFTextField).getText()).toBe("محمد Ali");
    expect(f.getCheckBox("subscribe").isChecked()).toBe(true);
    expect(f.getRadioGroup("plan").getSelected()).toBe("pro");
    expect(f.getDropdown("country").getSelected()).toEqual(["Other"]);
    const w = (f.getField("applicant.name") as PDFTextField).acroField.getWidgets()[0];
    expect(w.getNormalAppearance()).toBeDefined();
    expect(r.report.warnings).toEqual([]);
  });

  it("applies native edits stored in the editor state", async () => {
    const src = FIX("simple.pdf");
    const d0 = await PDFDocument.load(src);
    const { analyzePageText } = await import("@/lib/pdf/textAnalysis");
    const line = analyzePageText(d0.context, d0.getPage(1)).lines.find((l) => l.text.startsWith("Invoice"))!;
    const doc = docWith(pagesOf("s", 3), { nativeEdits: { s: { 1: { [line.id]: { text: "Invoice total: 0 USD", original: line.text } } } } });
    const r = await run(doc, { s: src });
    const t = await extractText(r.bytes);
    expect(t[1]).toContain("Invoice total: 0 USD");
    expect(t[0]).toContain("Invoice total: 120 USD");
    expect(r.report.nativeResults).toEqual([expect.objectContaining({ ok: true, pageIndex: 1 })]);
    // the old content stream of page 2 is no longer in the file (only pages 1 and 3 still show 120 USD)
    const occurrences = (await allStreamText(r.bytes)).split(hex("Invoice total: 120 USD")).length - 1;
    expect(occurrences).toBe(2);
  });

  it("exports only selected pages", async () => {
    const pages = pagesOf("s", 3);
    const r = await run(docWith(pages), { s: FIX("simple.pdf") }, { pageIds: [pages[2].id, pages[0].id] });
    const t = await extractText(r.bytes);
    expect(t).toHaveLength(2);
    expect(t[0]).toContain("Page 3 heading");
    expect(t[1]).toContain("Page 1 heading");
  });

  it("verification detects missing text and wrong page counts", async () => {
    const pages = pagesOf("s", 3);
    const doc = docWith(pages, { objects: [textObj("p0", "Hello verify")] });
    const r = await run(doc, { s: FIX("simple.pdf") });
    const sources = { s: { id: "s", name: "s", size: 0, pageCount: 3, hasForm: false, pages: Array(3).fill({ width: 595, height: 842, viewBox: [0, 0, 595, 842], baseRotation: 0 }) } };
    const { pdfjs, doc: pdf } = await openPdfjs(r.bytes);
    const ok = await verifyExport(pdf, buildExpectations(doc, sources), [pdfjs.OPS.paintImageXObject]);
    expect(ok.ok).toBe(true);
    const bad = await verifyExport(pdf, buildExpectations({ ...doc, objects: [textObj("p0", "Not there")], pages: [...pages, pages[0]] }, sources), []);
    expect(bad.ok).toBe(false);
    expect(bad.issues.map((i) => i.message).join(" ")).toMatch(/Expected 4 pages/);
    expect(bad.issues.map((i) => i.message).join(" ")).toMatch(/Not there/);
    await pdf.loadingTask.destroy();
  });

  it("refuses encrypted documents instead of producing a broken file", async () => {
    await expect(run(docWith(pagesOf("s", 1)), { s: FIX("encrypted.pdf") })).rejects.toThrow(/encrypt/i);
  });
});
