import { test, expect } from "@playwright/test";
import { clickPagePoint, exportAndDownload, openPdf, pdfText } from "./helpers";

test("all network traffic stays on the app origin and never carries document data", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const requests: { url: string; method: string; size: number }[] = [];
  page.on("request", (r) => requests.push({ url: r.url(), method: r.method(), size: r.postDataBuffer()?.length ?? 0 }));
  await page.goto("/");
  await openPdf(page, "scanned.pdf");

  // OCR (loads the Tesseract worker, wasm core and language data)
  await page.getByTestId("tool-replace").click();
  await page.getByTestId("ocr-run").click();
  await expect(page.getByTestId("toast-success").last()).toContainText(/OCR found \d+ line/, { timeout: 180_000 });
  const ocrLine = page.locator('button[title^="OCR"]').filter({ hasText: "" }).first();
  await expect(ocrLine).toBeVisible();
  const title = (await ocrLine.getAttribute("title")) ?? "";
  expect(title.toLowerCase()).toMatch(/page|heading|invoice|paragraph/);

  // add text (loads fonts) and export (worker)
  await page.getByTestId("tool-add-text").click();
  await clickPagePoint(page, 1, 80, 500);
  await page.keyboard.type("Private note");
  await page.getByTestId("tool-select").click();
  const { bytes } = await exportAndDownload(page);
  expect((await pdfText(bytes))[0]).toContain("Private note");

  const origin = new URL(baseURL!).origin;
  const external = requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith("blob:") && !r.url.startsWith("data:"));
  expect(external, `external requests: ${external.map((r) => r.url).join(", ")}`).toEqual([]);
  const withBody = requests.filter((r) => r.method !== "GET" || r.size > 0);
  expect(withBody, `requests with a body: ${withBody.map((r) => `${r.method} ${r.url}`).join(", ")}`).toEqual([]);
  expect(requests.some((r) => r.url.includes("/tesseract/lang/eng.traineddata.gz"))).toBe(true);
});
