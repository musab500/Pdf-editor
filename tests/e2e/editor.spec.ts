import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { unzipSync } from "fflate";
import { PDFDocument, PDFTextField, PDFCheckBox } from "pdf-lib";
import { FIX, clickPagePoint, dragOnPage, exportAndDownload, openPdf, pdfText, waitForRender } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("opens, renders and navigates a multipage PDF", async ({ page }) => {
  await openPdf(page, "simple.pdf");
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(3);
  await expect(page.getByTestId("status-page")).toHaveText("Page 1 of 3");
  await page.getByTestId("thumb-3").click();
  await expect(page.getByTestId("status-page")).toHaveText("Page 3 of 3");
  await waitForRender(page, 3);
  await page.getByTestId("zoom-select").selectOption("1.5");
  await expect(page.getByTestId("status-bar")).toContainText("Zoom 150%");
});

test("rejects empty, corrupt and non-PDF files with clear errors", async ({ page }) => {
  for (const [file, msg] of [
    ["empty.pdf", /empty/i],
    ["not-a-pdf.pdf", /PDF header|not a PDF/i],
    ["corrupt.pdf", /damaged|could not open|not a valid/i],
  ] as const) {
    await page.setInputFiles('[data-testid="file-input"]', FIX(file));
    await expect(page.getByTestId("toast-error").last()).toContainText(msg);
  }
  await expect(page.getByText("Open a PDF to start editing")).toBeVisible();
});

test("password-protected PDF: asks for password and opens view-only", async ({ page }) => {
  await page.setInputFiles('[data-testid="file-input"]', FIX("encrypted.pdf"));
  await expect(page.getByTestId("password-dialog")).toBeVisible();
  await page.getByTestId("password-input").fill("wrong");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("password-dialog")).toContainText("Incorrect password");
  await page.getByTestId("password-input").fill("secret");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thumb-1")).toBeVisible();
  await waitForRender(page, 1);
  await expect(page.getByText("View only – this PDF is encrypted")).toBeVisible();
  await expect(page.getByTestId("download-btn")).toBeDisabled();
  await expect(page.getByTestId("tool-add-text")).toBeDisabled();
});

test("adds English and Arabic text, exports, and the text is in the output", async ({ page }) => {
  await openPdf(page, "simple.pdf");
  await page.getByTestId("tool-add-text").click();
  await clickPagePoint(page, 1, 80, 400);
  await page.keyboard.type("Added English line 42");
  await page.getByTestId("tool-select").click();
  await page.getByTestId("tool-add-text").click();
  await clickPagePoint(page, 1, 80, 480);
  await page.keyboard.insertText("مرحبا بالعالم 2024 و English");
  await page.getByTestId("tool-select").click();
  await expect(page.locator('[data-object-kind="text"]')).toHaveCount(2);
  const { bytes, verified, download } = await exportAndDownload(page);
  expect(verified).toContain("Verified");
  expect(download.suggestedFilename()).toBe("simple-edited.pdf");
  const text = await pdfText(bytes);
  expect(text[0]).toContain("Added English line 42");
  expect(text[0]).toContain("Invoice total: 120 USD"); // unrelated content intact
  expect(text[0]).toContain("English");
  for (const ch of "مرحبا") expect(text[0]).toContain(ch);
  expect(text).toHaveLength(3);
});

test("native edit rewrites original text in place and leaves other text intact", async ({ page }) => {
  await openPdf(page, "simple.pdf");
  await page.getByTestId("tool-edit-text").click();
  await expect(page.locator("[data-line-id]").first()).toBeVisible();
  await page.getByRole("button", { name: "Edit text: Invoice total: 120 USD" }).first().click();
  await expect(page.getByTestId("native-text")).toHaveValue("Invoice total: 120 USD");
  await page.getByTestId("native-text").fill("Invoice total: 980 EUR");
  await expect(page.getByText("This change can be written into the original text.")).toBeVisible();
  await page.getByTestId("native-apply").click();
  await expect(page.getByTestId("toast-success").last()).toContainText("rewritten and verified");
  const { bytes, verified } = await exportAndDownload(page);
  expect(verified).toContain("Verified");
  const text = await pdfText(bytes);
  expect(text[0]).toContain("Invoice total: 980 EUR");
  expect(text[0]).not.toContain("120 USD");
  expect(text[0]).toContain("Unrelated paragraph text on page 1.");
  expect(text[1]).toContain("Invoice total: 120 USD"); // same text on page 2 untouched
  // undo restores the original
  await page.getByTestId("undo").click();
  const again = await exportAndDownload(page);
  expect((await pdfText(again.bytes))[0]).toContain("Invoice total: 120 USD");
});

test("native edit refuses unsafe cases (Arabic) and offers visual replacement", async ({ page }) => {
  await openPdf(page, "arabic.pdf");
  await page.getByTestId("tool-edit-text").click();
  await page.locator("[data-line-id]").nth(1).click();
  await expect(page.getByText("Native editing is not possible here")).toBeVisible();
  await expect(page.getByTestId("native-apply")).toBeDisabled();
  await page.getByTestId("native-to-visual").click();
  await expect(page.locator('[data-object-kind="replace"]')).toHaveCount(1);
  await page.getByTestId("prop-text").fill("نص بديل");
  const { bytes, verified } = await exportAndDownload(page);
  expect(verified).toContain("Verified");
  const text = (await pdfText(bytes))[0];
  for (const ch of "نصبديل") expect(text).toContain(ch);
});

test("subset font missing glyph is refused, not silently broken", async ({ page }) => {
  await openPdf(page, "multi-fonts.pdf");
  await page.getByTestId("tool-edit-text").click();
  await page.getByRole("button", { name: /Edit text: Noto subset/ }).click();
  await page.getByTestId("native-text").fill("Noto subset: Zebra QX");
  await expect(page.getByText(/embedded subset|does not exist/)).toBeVisible();
  await expect(page.getByTestId("native-apply")).toBeDisabled();
  // characters that exist in the subset are allowed
  await page.getByTestId("native-text").fill("Noto subset: world Hello");
  await expect(page.getByText("This change can be written into the original text.")).toBeVisible();
});

test("visual replacement on a region of a scanned page", async ({ page }) => {
  await openPdf(page, "scanned.pdf");
  await page.getByTestId("tool-replace").click();
  await expect(page.getByText(/No editable text was found/)).toBeVisible();
  await dragOnPage(page, 1, [45, 90], [260, 110]);
  await expect(page.locator('[data-object-kind="replace"]')).toHaveCount(1);
  await page.keyboard.type("Replaced on scan");
  await page.getByTestId("tool-select").click();
  const { bytes, verified } = await exportAndDownload(page);
  expect(verified).toContain("Verified");
  expect((await pdfText(bytes))[0]).toContain("Replaced on scan");
});

test("page management: rotate, duplicate, reorder, delete, blank, undo/redo", async ({ page }) => {
  await openPdf(page, "simple.pdf");
  await page.getByTestId("thumb-2").click();
  await page.getByTestId("page-rotate-right").click();
  await page.getByTestId("page-duplicate").click();
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(4);
  await page.getByTestId("thumb-1").click();
  await page.getByTestId("page-move-down").click();
  await page.getByTestId("page-add-blank").click();
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(5);
  await page.getByTestId("thumb-5").click();
  await page.getByTestId("page-delete").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(4);
  await page.getByTestId("undo").click();
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(5);
  await page.getByTestId("redo").click();
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(4);
  const { bytes, verified } = await exportAndDownload(page);
  expect(verified).toContain("Verified");
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(4);
  const text = await pdfText(bytes);
  // order: p2(rotated), p1, blank, p2-dup(rotated)  (p3 was deleted)
  expect(text[0]).toContain("Page 2 heading");
  expect(text[1]).toContain("Page 1 heading");
  expect(text[2].trim()).toBe("");
  expect(text[3]).toContain("Page 2 heading");
  expect(doc.getPage(0).getRotation().angle).toBe(90);
  expect(doc.getPage(1).getRotation().angle).toBe(0);
  expect(doc.getPage(3).getRotation().angle).toBe(90);
  expect(text.join(" ")).not.toContain("Page 3 heading");
});

test("merge PDFs and split into ranges", async ({ page }) => {
  await openPdf(page, "simple.pdf");
  await page.getByTestId("merge-btn").click();
  await page.setInputFiles('[data-testid="merge-input"]', [FIX("multi-fonts.pdf"), FIX("sizes-rotations.pdf")]);
  await page.getByTestId("merge-run").click();
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(8);
  const merged = await exportAndDownload(page);
  const md = await PDFDocument.load(merged.bytes);
  expect(md.getPageCount()).toBe(8);
  const sizes = md.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight()), p.getRotation().angle]);
  expect(sizes[5]).toEqual([792, 612, 0]); // letter landscape preserved
  expect(sizes[6][2]).toBe(90); // rotated page preserved
  const text = await pdfText(merged.bytes);
  expect(text[3]).toContain("Times Bold line");

  await page.getByTestId("page-split").click();
  await page.getByTestId("split-ranges").fill("1-3, 4, 5-8");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("split-run").click()]);
  expect(dl.suggestedFilename()).toBe("simple-split.zip");
  const files = unzipSync(new Uint8Array(fs.readFileSync((await dl.path())!)));
  const names = Object.keys(files).sort();
  expect(names).toEqual(["simple-p1-3.pdf", "simple-p4.pdf", "simple-p5-8.pdf"]);
  expect((await PDFDocument.load(files["simple-p5-8.pdf"])).getPageCount()).toBe(4);
});

test("export selected pages only, with a custom file name", async ({ page }) => {
  await openPdf(page, "simple.pdf");
  await page.getByTestId("thumb-2").click();
  await page.getByTestId("thumb-3").click({ modifiers: ["Shift"] });
  await page.getByTestId("page-extract").click();
  const dlg = page.getByTestId("export-dialog");
  await expect(dlg.getByTestId("export-filename")).toHaveValue("simple-pages.pdf");
  await expect(dlg.getByTestId("verify-result")).toContainText("Verified");
  await dlg.getByTestId("export-filename").fill('my:report?');
  const [dl] = await Promise.all([page.waitForEvent("download"), dlg.getByTestId("export-download").click()]);
  expect(dl.suggestedFilename()).toBe("my_report_.pdf");
  const text = await pdfText(new Uint8Array(fs.readFileSync((await dl.path())!)));
  expect(text).toHaveLength(2);
  expect(text[0]).toContain("Page 2 heading");
});

test("images, shapes, drawing and highlight are exported", async ({ page }) => {
  await openPdf(page, "tables-images.pdf");
  await page.getByTestId("zoom-select").selectOption("0.75");
  const z = 0.75 * (96 / 72);
  await page.setInputFiles('[data-testid="image-input"]', FIX("sample.png"));
  await clickPagePoint(page, 1, 400, 300, z);
  await expect(page.locator('[data-object-kind="image"]')).toHaveCount(1);
  await page.getByTestId("tool-rect").click();
  await dragOnPage(page, 1, [300, 450], [400, 520], z);
  await page.getByTestId("tool-highlight").click();
  await dragOnPage(page, 1, [55, 135], [200, 160], z);
  await page.getByTestId("tool-draw").click();
  await dragOnPage(page, 1, [100, 600], [250, 650], z);
  await page.getByTestId("tool-arrow").click();
  await dragOnPage(page, 1, [100, 700], [300, 720], z);
  await expect(page.locator("[data-object-id]")).toHaveCount(5);
  // move the image with the select tool and check the new position is used
  await page.getByTestId("tool-select").click();
  const img = page.locator('[data-object-kind="image"]');
  const b = (await img.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  const b2 = (await img.boundingBox())!;
  expect(Math.round(b2.x - b.x)).toBe(40);
  const { bytes, verified } = await exportAndDownload(page);
  expect(verified).toContain("Verified");
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(1);
  const text = await pdfText(bytes);
  expect(text[0]).toContain("Apples"); // table text intact
});

test("form fields are filled and saved as real form values", async ({ page }) => {
  await openPdf(page, "form-annots.pdf");
  await page.locator('[data-field="applicant.name"]').fill("Mahmoud Test");
  await page.locator('[data-field="subscribe"]').check();
  await page.locator('[data-field="country"]').selectOption("Saudi Arabia");
  await page.locator('[data-field="plan"]').nth(1).check();
  const { bytes } = await exportAndDownload(page);
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();
  expect((form.getField("applicant.name") as PDFTextField).getText()).toBe("Mahmoud Test");
  expect((form.getField("subscribe") as PDFCheckBox).isChecked()).toBe(true);
  expect(form.getDropdown("country").getSelected()).toEqual(["Saudi Arabia"]);
  expect(form.getRadioGroup("plan").getSelected()).toBe("pro");
  // the link annotation is preserved
  const annots = doc.getPage(0).node.Annots();
  expect(annots?.size()).toBeGreaterThanOrEqual(5);
});

test("search finds text and navigates to it", async ({ page }) => {
  await openPdf(page, "simple.pdf");
  await page.getByTestId("tab-search").click();
  await page.getByTestId("search-input").fill("paragraph");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("search-count")).toContainText("3 result(s)");
});

test("unsaved changes are flagged and confirmed before opening another file", async ({ page }) => {
  await openPdf(page, "simple.pdf");
  await page.getByTestId("thumb-1").click();
  await page.getByTestId("page-rotate-right").click();
  await expect(page.getByTestId("doc-status")).toContainText("unsaved changes");
  await page.setInputFiles('[data-testid="file-input"]', FIX("multi-fonts.pdf"));
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("doc-status")).toContainText("multi-fonts.pdf");
});

test("select page text, copy it and highlight it", async ({ page }) => {
  await openPdf(page, "simple.pdf");
  await page.getByTestId("tool-text-select").click();
  const span = page.locator('[data-testid="page-1"] .textLayer span', { hasText: "Invoice total" }).first();
  await expect(span).toBeVisible();
  const b = (await span.boundingBox())!;
  await page.mouse.move(b.x + 1, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("Invoice total");
  await page.getByTestId("selection-highlight").click();
  await expect(page.locator('[data-object-kind="highlight"]')).toHaveCount(1);
  const hl = (await page.locator('[data-object-kind="highlight"]').boundingBox())!;
  expect(Math.abs(hl.x - b.x)).toBeLessThan(3);
  expect(Math.abs(hl.width - b.width)).toBeLessThan(6);
});

test("text added on a rotated page stays upright in the export", async ({ page }) => {
  await openPdf(page, "sizes-rotations.pdf");
  await page.getByTestId("thumb-3").click(); // page with /Rotate 90
  await page.getByTestId("zoom-select").selectOption("0.5");
  await page.getByTestId("page-3").scrollIntoViewIfNeeded();
  await page.waitForTimeout(800); // smooth scrolling
  await page.getByTestId("tool-add-text").click();
  const box = (await page.getByTestId("page-3").boundingBox())!;
  expect(box.width).toBeGreaterThan(box.height); // displayed landscape
  await page.mouse.click(box.x + 60, box.y + 60);
  await page.keyboard.type("Upright note");
  await page.getByTestId("tool-select").click();
  const obj = (await page.locator('[data-object-kind="text"]').boundingBox())!;
  expect(obj.width).toBeGreaterThan(obj.height); // reads horizontally on screen
  const { bytes } = await exportAndDownload(page);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const p3 = await doc.getPage(3);
  const tc = await p3.getTextContent();
  const item = tc.items.find((i) => "str" in i && i.str.includes("Upright")) as { transform: number[] } | undefined;
  expect(item).toBeDefined();
  // page is rotated 90° clockwise for display, so upright text runs along +y in unrotated user space
  const [a, b] = item!.transform;
  expect(Math.abs(a)).toBeLessThan(0.01);
  expect(b).toBeGreaterThan(0);
  await doc.loadingTask.destroy();
});

test("keyboard: delete selected object, undo and redo", async ({ page }) => {
  await openPdf(page, "simple.pdf");
  await page.getByTestId("tool-rect").click();
  await dragOnPage(page, 1, [100, 300], [200, 350]);
  await page.getByTestId("tool-select").click();
  await page.locator('[data-object-kind="rect"]').click();
  await page.keyboard.press("Delete");
  await expect(page.locator('[data-object-kind="rect"]')).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-object-kind="rect"]')).toHaveCount(1);
  await page.keyboard.press("Control+y");
  await expect(page.locator('[data-object-kind="rect"]')).toHaveCount(0);
});

test("responsive: phone layout uses drawers and still edits and exports", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setInputFiles('[data-testid="file-input"]', FIX("simple.pdf"));
  await waitForRender(page, 1);
  // panels are hidden by default and the page fits the screen width
  await expect(page.getByTestId("thumb-1")).toBeHidden();
  const pageBox = (await page.getByTestId("page-1").boundingBox())!;
  expect(pageBox.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // pages drawer: pick page 2, drawer closes
  await page.getByTestId("toggle-pages").click();
  await page.getByTestId("thumb-2").click();
  await expect(page.getByTestId("thumb-2")).toBeHidden();
  await expect(page.getByTestId("status-page")).toHaveText("Page 2 of 3");
  // native edit opens the properties sheet automatically
  await page.getByTestId("tool-edit-text").click();
  await page.getByRole("button", { name: "Edit text: Invoice total: 120 USD" }).first().click();
  await expect(page.getByTestId("native-text")).toBeVisible();
  await page.getByRole("button", { name: "Close properties" }).last().click();
  await expect(page.getByTestId("native-text")).toBeHidden();
  const { bytes, verified } = await exportAndDownload(page);
  expect(verified).toContain("Verified");
  expect(bytes.length).toBeGreaterThan(500);
});

test("design-tool PDF (text inside form objects): replace works, native edit explains why not", async ({ page }) => {
  await openPdf(page, "design-xobject.pdf");
  await page.getByTestId("tool-edit-text").click();
  await page.getByRole("button", { name: "Edit text: AWTAD TEST COMPANY" }).click();
  await expect(page.getByText(/embedded form object/)).toBeVisible();
  await page.getByTestId("tool-replace").click();
  await page.getByRole("button", { name: "Replace text: AWTAD TEST COMPANY" }).click();
  const obj = page.locator('[data-object-kind="replace"]');
  await expect(obj).toHaveCount(1);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("NEW COMPANY NAME");
  await page.getByTestId("tool-select").click();
  const { bytes, verified } = await exportAndDownload(page);
  expect(verified).toContain("Verified");
  expect((await pdfText(bytes))[0]).toContain("NEW COMPANY NAME");
});

test("a clicked text box is immediately typeable and selectable", async ({ page }) => {
  await openPdf(page, "simple.pdf");
  await page.getByTestId("tool-add-text").click();
  await clickPagePoint(page, 1, 80, 400);
  await expect(page.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("Typed right away");
  // click into the box again and keep typing
  await page.locator('[data-object-kind="text"] textarea').click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.mouse.click(10, 500);
  await expect(page.locator('[data-object-kind="text"]')).toHaveCount(1);
  await page.getByTestId("tool-add-text").click();
  await clickPagePoint(page, 1, 80, 600);
  await page.getByTestId("tool-add-text").click();
  await clickPagePoint(page, 1, 80, 650); // the previous empty box is removed
  await page.getByTestId("tool-select").click();
  await page.mouse.click(10, 500);
  await expect(page.locator('[data-object-kind="text"]')).toHaveCount(1);
  const { bytes } = await exportAndDownload(page);
  expect((await pdfText(bytes))[0]).toContain("Typed right away!");
});
