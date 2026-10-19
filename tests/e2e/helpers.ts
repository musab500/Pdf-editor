import { expect, type Download, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";

export const FIX = (n: string) => path.join(__dirname, "../fixtures", n);

const require = createRequire(__filename);

/** Extract text per page from PDF bytes with PDF.js (legacy build, Node). */
export async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const dir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  pdfjs.GlobalWorkerOptions.workerSrc = path.join(dir, "legacy/build/pdf.worker.mjs");
  const doc = await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: path.join(dir, "standard_fonts/") }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    out.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  await doc.loadingTask.destroy();
  return out;
}

export async function openPdf(page: Page, file: string) {
  await page.setInputFiles('[data-testid="file-input"]', FIX(file));
  await expect(page.getByTestId("thumb-1")).toBeVisible();
  await waitForRender(page, 1);
}

/** Wait until the page canvas has painted non-white pixels. */
export async function waitForRender(page: Page, n: number) {
  await expect
    .poll(
      async () =>
        page.evaluate((idx) => {
          const c = document.querySelector<HTMLCanvasElement>(`[data-testid="page-${idx}"] canvas`);
          if (!c || !c.width) return false;
          const ctx = c.getContext("2d");
          if (!ctx) return false;
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < d.length; i += 4 * 97) if (d[i] < 200) return true;
          return false;
        }, n),
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** Open the export dialog, wait for verification, download and return the bytes. */
export async function exportAndDownload(page: Page, fileName?: string): Promise<{ bytes: Uint8Array; download: Download; verified: string }> {
  await page.getByTestId("download-btn").click();
  const dlg = page.getByTestId("export-dialog");
  await expect(dlg.getByTestId("verify-result")).toBeVisible({ timeout: 60_000 });
  const verified = (await dlg.getByTestId("verify-result").innerText()).trim();
  if (fileName) await dlg.getByTestId("export-filename").fill(fileName);
  const [download] = await Promise.all([page.waitForEvent("download"), dlg.getByTestId("export-download").click()]);
  const p = await download.path();
  return { bytes: new Uint8Array(fs.readFileSync(p!)), download, verified };
}

export async function loadPdf(bytes: Uint8Array) {
  return PDFDocument.load(bytes);
}

/** Click at a point given in PDF points (unrotated page space) on page n. */
export async function clickPagePoint(page: Page, n: number, x: number, y: number, zoomScale = 96 / 72) {
  const box = await page.getByTestId(`page-${n}`).boundingBox();
  await page.mouse.click(box!.x + x * zoomScale, box!.y + y * zoomScale);
}

export async function dragOnPage(page: Page, n: number, from: [number, number], to: [number, number], zoomScale = 96 / 72) {
  const box = await page.getByTestId(`page-${n}`).boundingBox();
  await page.mouse.move(box!.x + from[0] * zoomScale, box!.y + from[1] * zoomScale);
  await page.mouse.down();
  await page.mouse.move(box!.x + ((from[0] + to[0]) / 2) * zoomScale, box!.y + ((from[1] + to[1]) / 2) * zoomScale, { steps: 4 });
  await page.mouse.move(box!.x + to[0] * zoomScale, box!.y + to[1] * zoomScale, { steps: 4 });
  await page.mouse.up();
}
