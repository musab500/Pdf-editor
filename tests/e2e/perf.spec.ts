import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { waitForRender } from "./helpers";

// Performance measurements used to choose the size/page-count warnings.
// Run with:  node scripts/make-large.mjs && PERF=1 npx playwright test perf
test.skip(!process.env.PERF, "set PERF=1 to run performance measurements");

const LARGE = path.join(__dirname, "../fixtures/large");
for (const file of ["text-300.pdf", "text-1000.pdf", "images-24.pdf"]) {
  test(`perf: ${file}`, async ({ page }) => {
    test.setTimeout(600_000);
    const p = path.join(LARGE, file);
    test.skip(!fs.existsSync(p), "run scripts/make-large.mjs first");
    await page.goto("/");
    let t = Date.now();
    await page.setInputFiles('[data-testid="file-input"]', p);
    await expect(page.getByTestId("thumb-1")).toBeVisible({ timeout: 300_000 });
    await waitForRender(page, 1);
    const open = Date.now() - t;
    // a native edit + an added object, then a full export with verification
    await page.getByTestId("tool-add-text").click();
    const box = (await page.getByTestId("page-1").boundingBox())!;
    await page.mouse.click(box.x + 120, box.y + 120);
    await page.keyboard.type("perf");
    await page.getByTestId("tool-select").click();
    t = Date.now();
    await page.getByTestId("download-btn").click();
    await expect(page.getByTestId("verify-result")).toBeVisible({ timeout: 500_000 });
    const exp = Date.now() - t;
    const mem = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
    const line = `${file}: ${(fs.statSync(p).size / 1048576).toFixed(1)} MB, open+first render ${open} ms, export+verify ${exp} ms, JS heap ${(mem / 1048576).toFixed(0)} MB`;
    console.log(line);
    fs.appendFileSync(path.join(LARGE, "results.txt"), line + "\n");
  });
}
