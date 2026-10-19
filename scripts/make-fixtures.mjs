// Generates the representative test PDFs in tests/fixtures.
// Run: node scripts/make-fixtures.mjs   (the scanned fixture needs `pdftoppm`, already committed)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  PDFDocument, StandardFonts, rgb, degrees, PDFString, PDFName, PDFHexString, PDFOperator, PDFNumber,
  pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setFillingRgbColor,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tests/fixtures");
fs.mkdirSync(outDir, { recursive: true });
const font = (f) => fs.readFileSync(path.join(root, "public/fonts", f));
const save = async (name, doc) => fs.writeFileSync(path.join(outDir, name), await doc.save());

// Same fix the app applies: pad glyph records in fontkit's TrueType subsetter.
function patchTtfSubset(subset) {
  const proto = Object.getPrototypeOf(subset);
  if (proto.__pePatched) return;
  const orig = proto._addGlyph;
  proto._addGlyph = function (gid) {
    const r = orig.call(this, gid);
    const i = this.glyf.length - 1;
    const b = this.glyf[i];
    const pad = (4 - (b.length % 4)) % 4;
    if (pad) {
      const nb = new b.constructor(b.length + pad);
      nb.fill(0);
      nb.set(b);
      this.glyf[i] = nb;
      this.offset += pad;
    }
    return r;
  };
  proto.__pePatched = true;
}

// Shaped text drawing (same technique the app uses) for fixtures with Arabic.
function drawShaped(page, pdfFont, text, x, y, size, dir) {
  const fk = pdfFont.embedder.font;
  pdfFont.encodeText(text);
  const run = fk.layout(text, undefined, undefined, undefined, dir);
  const key = page.node.newFontDictionary(pdfFont.name, pdfFont.ref);
  const upm = fk.unitsPerEm;
  page.pushOperators(pushGraphicsState(), setFillingRgbColor(0, 0, 0), beginText(), setFontAndSize(key, size));
  let pen = x;
  run.glyphs.forEach((g, i) => {
    const p = run.positions[i];
    page.pushOperators(
      PDFOperator.of("Tm", [1, 0, 0, 1, pen + (p.xOffset * size) / upm, y + (p.yOffset * size) / upm].map((n) => PDFNumber.of(n))),
      PDFOperator.of("Tj", [PDFHexString.of(g.id.toString(16).padStart(4, "0"))]),
    );
    pen += (p.xAdvance * size) / upm;
  });
  page.pushOperators(endText(), popGraphicsState());
  return pen - x;
}

// 1. simple
{
  const doc = await PDFDocument.create();
  doc.setTitle("Simple fixture");
  const f = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Page ${i} heading`, { x: 50, y: 780, size: 22, font: f });
    p.drawText("Invoice total: 120 USD", { x: 50, y: 740, size: 12, font: f });
    p.drawText(`Unrelated paragraph text on page ${i}.`, { x: 50, y: 720, size: 12, font: f });
  }
  await save("simple.pdf", doc);
}

// 2. multiple fonts
{
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const h = await doc.embedFont(StandardFonts.Helvetica);
  const tb = await doc.embedFont(StandardFonts.TimesRomanBold);
  const c = await doc.embedFont(StandardFonts.Courier);
  const noto = await doc.embedFont(font("NotoSans_400Regular.ttf"), { subset: true });
  patchTtfSubset(noto.embedder.subset);
  const p = doc.addPage([595, 842]);
  p.drawText("Helvetica line", { x: 50, y: 780, size: 14, font: h });
  p.drawText("Times Bold line", { x: 50, y: 750, size: 16, font: tb, color: rgb(0.7, 0.1, 0.1) });
  p.drawText("Courier line 12345", { x: 50, y: 720, size: 12, font: c });
  p.drawText("Noto subset: Hello world", { x: 50, y: 690, size: 12, font: noto });
  await save("multi-fonts.pdf", doc);
}

// 3. Arabic + mixed
{
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const ar = await doc.embedFont(font("NotoNaskhArabic_400Regular.ttf")); // full font: glyph ids stay valid
  const h = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText("Arabic fixture", { x: 50, y: 790, size: 14, font: h });
  drawShaped(p, ar, "مرحبا بالعالم", 400, 740, 20, "rtl");
  drawShaped(p, ar, "رقم الفاتورة", 420, 700, 16, "rtl");
  p.drawText("Invoice 2024", { x: 300, y: 700, size: 14, font: h });
  await save("arabic.pdf", doc);
}

// 3b. "design tool" PDF: coloured background, Arabic + Latin text inside a Form XObject (like Canva exports)
{
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const ar = await doc.embedFont(font("NotoNaskhArabic_400Regular.ttf"));
  const h = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.93, 0.96, 0.85) });
  p.drawRectangle({ x: 0, y: 700, width: 595, height: 142, color: rgb(0.85, 0.9, 1) });
  p.drawText("AWTAD TEST COMPANY", { x: 150, y: 780, size: 22, font: h, color: rgb(0.2, 0.3, 0.6) });
  drawShaped(p, ar, "عقد اتفاق للصيانة الدورية", 250, 640, 20, "rtl");
  drawShaped(p, ar, "الطرف الأول: شركة الاختبار", 300, 600, 14, "rtl");
  // move everything into a Form XObject drawn by the page
  const ctx = doc.context;
  const contents = p.node.Contents();
  const parts = [];
  for (let i = 0; i < contents.size(); i++) {
    const st = ctx.lookup(contents.get(i));
    parts.push(Buffer.from(st.getContents ? st.getContents() : st.contents));
  }
  const { inflateSync } = await import("node:zlib");
  const raw = Buffer.concat(parts.map((b) => { try { return inflateSync(b); } catch { return b; } }).flatMap((b) => [b, Buffer.from("\n")]));
  const form = ctx.flateStream(raw, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 595, 842], Resources: p.node.Resources() });
  const formRef = ctx.register(form);
  p.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { Fm0: formRef } }));
  p.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream("q /Fm0 Do Q")));
  await save("design-xobject.pdf", doc);
}

// 4. tables and images
{
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  const rows = [["Item", "Qty", "Price"], ["Apples", "3", "4.50"], ["Pears", "2", "3.10"]];
  rows.forEach((r, i) => {
    r.forEach((cell, j) => {
      p.drawRectangle({ x: 50 + j * 150, y: 700 - i * 30, width: 150, height: 30, borderColor: rgb(0, 0, 0), borderWidth: 1 });
      p.drawText(cell, { x: 58 + j * 150, y: 710 - i * 30, size: 12, font: f });
    });
  });
  // 2x2 red/blue PNG generated inline
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
    "base64",
  );
  const img = await doc.embedPng(png);
  p.drawImage(img, { x: 50, y: 450, width: 120, height: 120 });
  await save("tables-images.pdf", doc);
}

// 6. forms + annotations
{
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  const form = doc.getForm();
  p.drawText("Name:", { x: 50, y: 760, size: 12, font: f });
  const name = form.createTextField("applicant.name");
  name.setText("Jane");
  name.addToPage(p, { x: 120, y: 750, width: 200, height: 22 });
  p.drawText("Subscribe:", { x: 50, y: 720, size: 12, font: f });
  const cb = form.createCheckBox("subscribe");
  cb.addToPage(p, { x: 130, y: 715, width: 16, height: 16 });
  const rg = form.createRadioGroup("plan");
  rg.addOptionToPage("basic", p, { x: 130, y: 680, width: 16, height: 16 });
  rg.addOptionToPage("pro", p, { x: 180, y: 680, width: 16, height: 16 });
  const dd = form.createDropdown("country");
  dd.addOptions(["Malaysia", "Saudi Arabia", "Other"]);
  dd.select("Malaysia");
  dd.addToPage(p, { x: 120, y: 640, width: 150, height: 22 });
  // link annotation
  const link = doc.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [50, 600, 200, 615], Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com") },
  });
  p.drawText("Example link", { x: 50, y: 603, size: 12, font: f, color: rgb(0, 0, 0.8) });
  const linkRef = doc.context.register(link);
  p.node.addAnnot(linkRef);
  await save("form-annots.pdf", doc);
}

// 7. multiple sizes and rotations
{
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const a4 = doc.addPage([595, 842]);
  a4.drawText("A4 portrait", { x: 50, y: 780, size: 18, font: f });
  const letter = doc.addPage([792, 612]);
  letter.drawText("Letter landscape", { x: 50, y: 550, size: 18, font: f });
  const rot = doc.addPage([595, 842]);
  rot.setRotation(degrees(90));
  rot.drawText("Rotated 90 page", { x: 50, y: 780, size: 18, font: f });
  const crop = doc.addPage([600, 600]);
  crop.setCropBox(50, 50, 400, 400);
  crop.drawText("Cropped page", { x: 80, y: 400, size: 18, font: f });
  await save("sizes-rotations.pdf", doc);
}

// 5. scanned (image-only) page: rasterise simple.pdf page 1 and embed as image
try {
  const tmp = path.join(outDir, "_scan");
  execFileSync("pdftoppm", ["-r", "100", "-f", "1", "-l", "1", "-png", "-gray", path.join(outDir, "simple.pdf"), tmp]);
  const pngPath = fs.readdirSync(outDir).find((n) => n.startsWith("_scan") && n.endsWith(".png"));
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(fs.readFileSync(path.join(outDir, pngPath)));
  const p = doc.addPage([595, 842]);
  p.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  await save("scanned.pdf", doc);
  fs.unlinkSync(path.join(outDir, pngPath));
} catch (e) {
  console.warn("scanned.pdf not regenerated (pdftoppm missing?)", e.message);
}

// invalid inputs
fs.writeFileSync(path.join(outDir, "empty.pdf"), new Uint8Array());
fs.writeFileSync(path.join(outDir, "corrupt.pdf"), Buffer.from("%PDF-1.7\nthis is not really a pdf\n%%EOF"));
fs.writeFileSync(path.join(outDir, "not-a-pdf.pdf"), Buffer.from("PK\u0003\u0004 zip data"));
try {
  execFileSync("qpdf", ["--encrypt", "secret", "owner", "256", "--", path.join(outDir, "simple.pdf"), path.join(outDir, "encrypted.pdf")]);
} catch (e) {
  console.warn("encrypted.pdf not regenerated (qpdf missing?)", e.message);
}
console.log("fixtures written to", outDir);
