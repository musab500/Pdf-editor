import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, StandardFonts, PDFDict, PDFRef } from "pdf-lib";
import { analyzePageText } from "@/lib/pdf/textAnalysis";
import { applyNativeEdits, checkNativeEdit, collectFontUsage } from "@/lib/pdf/nativeEdit";
import { FIX } from "./helpers";
import { extractText } from "./pdfText";

/** Build a one-page PDF whose content stream is given verbatim. */
async function rawPdf(content: string, fonts: Record<string, StandardFonts> = { F1: StandardFonts.Helvetica, F2: StandardFonts.TimesRoman }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const fontDict = doc.context.obj({});
  for (const [k, f] of Object.entries(fonts)) {
    const font = await doc.embedFont(f);
    fontDict.set(PDFName.of(k), font.ref);
  }
  page.node.set(PDFName.of("Resources"), doc.context.obj({ Font: fontDict }));
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(content)));
  const bytes = await doc.save();
  return PDFDocument.load(bytes);
}

describe("native text editing (Mode A)", () => {
  it("rewrites a simple line and leaves everything else untouched", async () => {
    const doc = await PDFDocument.load(FIX("simple.pdf"));
    const a = analyzePageText(doc.context, doc.getPage(0));
    const line = a.lines.find((l) => l.text === "Invoice total: 120 USD")!;
    expect(line).toBeDefined();
    expect(line.font?.family).toBe("Helvetica");
    expect(line.userFontSize).toBeCloseTo(12);
    const res = applyNativeEdits(doc, doc.getPage(0), [{ lineId: line.id, text: "Invoice total: 7 EUR" }]);
    expect(res[0].ok).toBe(true);
    const text = await extractText(await doc.save());
    expect(text[0]).toContain("Invoice total: 7 EUR");
    expect(text[0]).not.toContain("120 USD");
    expect(text[0]).toContain("Page 1 heading");
    expect(text[0]).toContain("Unrelated paragraph text on page 1.");
    expect(text[1]).toContain("Invoice total: 120 USD");
  });

  it("merges kerned TJ runs into one line and keeps following text exactly in place", async () => {
    const doc = await rawPdf("BT /F1 12 Tf 50 300 Td [(H) 20 (ello) -250 (World)] TJ ( again) Tj /F2 12 Tf (TAIL) Tj ET");
    const before = analyzePageText(doc.context, doc.getPage(0));
    expect(before.lines[0].text).toBe("Hello World again");
    const tailBefore = before.shows.find((s) => s.text === "TAIL")!.start;
    const r = applyNativeEdits(doc, doc.getPage(0), [{ lineId: before.lines[0].id, text: "Goodbye World" }]);
    expect(r[0]).toMatchObject({ ok: true });
    const saved = await PDFDocument.load(await doc.save());
    const after = analyzePageText(saved.context, saved.getPage(0));
    expect(after.lines.map((l) => l.text.trim()).filter(Boolean)).toEqual(["Goodbye World", "TAIL"]);
    const tailAfter = after.shows.find((s) => s.text === "TAIL")!.start;
    expect(tailAfter[0]).toBeCloseTo(tailBefore[0], 3);
    expect(tailAfter[1]).toBeCloseTo(tailBefore[1], 3);
  });

  it("does not touch other text that happens to contain the same words", async () => {
    const doc = await rawPdf("BT /F1 12 Tf 50 300 Td (Total 10) Tj ET BT /F1 12 Tf 50 200 Td (Total 10) Tj ET");
    const a = analyzePageText(doc.context, doc.getPage(0));
    expect(a.lines).toHaveLength(2);
    applyNativeEdits(doc, doc.getPage(0), [{ lineId: a.lines[1].id, text: "Total 99" }]);
    const t = (await extractText(await doc.save()))[0];
    expect(t).toContain("Total 10");
    expect(t).toContain("Total 99");
  });

  it("works with Identity-H (Type0) fonts when the subset contains the glyphs", async () => {
    const doc = await PDFDocument.load(FIX("multi-fonts.pdf"));
    const a = analyzePageText(doc.context, doc.getPage(0));
    const line = a.lines.find((l) => l.text.startsWith("Noto subset"))!;
    expect(line.font?.isCID).toBe(true);
    const usage = collectFontUsage([a]);
    expect(checkNativeEdit(a, line, "Noto subset: world Hello", usage).ok).toBe(true);
    const r = applyNativeEdits(doc, doc.getPage(0), [{ lineId: line.id, text: "Noto subset: world Hello" }], { usage });
    expect(r[0].ok).toBe(true);
    expect((await extractText(await doc.save()))[0]).toContain("Noto subset: world Hello");
  });

  it("LIMITATION: refuses characters missing from an embedded subset font", async () => {
    const doc = await PDFDocument.load(FIX("multi-fonts.pdf"));
    const a = analyzePageText(doc.context, doc.getPage(0));
    const line = a.lines.find((l) => l.text.startsWith("Noto subset"))!;
    const c = checkNativeEdit(a, line, "Noto subset: Zebra", collectFontUsage([a]));
    expect(c.ok).toBe(false);
    expect(c.reasons.join(" ")).toMatch(/subset|does not exist/);
    // and applying anyway reports failure without changing the page
    const before = await doc.save();
    const r = applyNativeEdits(doc, doc.getPage(0), [{ lineId: line.id, text: "Noto subset: Zebra" }]);
    expect(r[0].ok).toBe(false);
    expect((await extractText(await doc.save()))[0]).toBe((await extractText(before))[0]);
  });

  it("LIMITATION: refuses Arabic (shaped, visual-order glyphs)", async () => {
    const doc = await PDFDocument.load(FIX("arabic.pdf"));
    const a = analyzePageText(doc.context, doc.getPage(0));
    const arabic = a.lines.filter((l) => l.font?.family.includes("Naskh"));
    expect(arabic.length).toBeGreaterThan(0);
    for (const l of arabic) {
      const c = checkNativeEdit(a, l, "نص جديد");
      expect(c.ok).toBe(false);
      expect(c.reasons.join(" ")).toMatch(/Arabic|right-to-left|identified/);
    }
    const r = applyNativeEdits(doc, doc.getPage(0), [{ lineId: arabic[0].id, text: "abc" }]);
    expect(r[0].ok).toBe(false);
  });

  it("LIMITATION: a scanned page has no editable text", async () => {
    const doc = await PDFDocument.load(FIX("scanned.pdf"));
    const a = analyzePageText(doc.context, doc.getPage(0));
    expect(a.lines).toHaveLength(0);
  });

  it("LIMITATION: refuses invisible text, multi-line input and Type 3 fonts", async () => {
    const doc = await rawPdf("BT /F1 12 Tf 3 Tr 50 300 Td (hidden ocr) Tj ET BT /F1 12 Tf 50 200 Td (visible) Tj ET");
    const a = analyzePageText(doc.context, doc.getPage(0));
    expect(checkNativeEdit(a, a.lines[0], "x").reasons.join()).toMatch(/invisible/);
    expect(checkNativeEdit(a, a.lines[1], "two\nlines").ok).toBe(false);

    const t3 = await rawPdf("BT /F1 12 Tf 50 300 Td (abc) Tj ET");
    const fontRef = (t3.getPage(0).node.Resources()!.lookup(PDFName.of("Font"), PDFDict)).get(PDFName.of("F1")) as PDFRef;
    const fd = t3.context.lookup(fontRef, PDFDict);
    fd.set(PDFName.of("Subtype"), PDFName.of("Type3"));
    const a3 = analyzePageText(t3.context, t3.getPage(0));
    const c = checkNativeEdit(a3, a3.lines[0], "abd");
    expect(c.ok).toBe(false);
    expect(c.reasons.join()).toMatch(/Type 3/);
  });

  it("LIMITATION: CID fonts without a ToUnicode map cannot be identified", async () => {
    const doc = await PDFDocument.load(FIX("multi-fonts.pdf"));
    const a0 = analyzePageText(doc.context, doc.getPage(0));
    const cid = a0.lines.find((l) => l.font?.isCID)!;
    cid.font!.dict.delete(PDFName.of("ToUnicode"));
    const a = analyzePageText(doc.context, doc.getPage(0));
    const line = a.lines.find((l) => l.font?.isCID)!;
    const c = checkNativeEdit(a, line, "anything");
    expect(c.ok).toBe(false);
    expect(c.reasons.join(" ")).toMatch(/ToUnicode|identified/);
  });

  it("warns when the new text is much wider (no reflow)", async () => {
    const doc = await PDFDocument.load(FIX("simple.pdf"));
    const a = analyzePageText(doc.context, doc.getPage(0));
    const line = a.lines.find((l) => l.text === "Invoice total: 120 USD")!;
    const c = checkNativeEdit(a, line, "Invoice total: 120 USD plus a very long addition");
    expect(c.ok).toBe(true);
    expect(c.warnings.join()).toMatch(/wider/);
  });
});

describe("text inside Form XObjects (design-tool PDFs)", () => {
  it("is found for replacement but refused for native editing", async () => {
    const doc = await PDFDocument.load(FIX("design-xobject.pdf"));
    const a = analyzePageText(doc.context, doc.getPage(0));
    expect(a.hasFormXObjects).toBe(true);
    expect(a.lines.length).toBeGreaterThanOrEqual(3);
    expect(a.lines.every((l) => l.inXObject)).toBe(true);
    const latin = a.lines.find((l) => l.displayText === "AWTAD TEST COMPANY")!;
    expect(latin).toBeDefined();
    // bbox is in page space (form matrix applied): text drawn at x=150, y=780, 22pt
    expect(latin.bbox.x0).toBeCloseTo(150, 0);
    expect(latin.bbox.y1).toBeGreaterThan(780);
    expect(a.lines.some((l) => l.rtl)).toBe(true);
    const c = checkNativeEdit(a, latin, "OTHER");
    expect(c.ok).toBe(false);
    expect(c.reasons.join()).toMatch(/form object/);
  });

  it("converts visually ordered Arabic to reading order", async () => {
    const { toReadingOrder } = await import("@/lib/pdf/textAnalysis");
    expect(toReadingOrder("ابحرم")).toBe("مرحبا");
    expect(toReadingOrder("2024 ةروتافلا")).toBe("الفاتورة 2024");
    expect(toReadingOrder("Hello")).toBe("Hello");
  });
});
