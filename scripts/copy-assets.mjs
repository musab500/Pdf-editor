// Copies browser runtime assets from node_modules into /public so the app is
// fully self-hosted (no CDN requests): PDF.js worker + data, Tesseract OCR core,
// worker and language data. Runs automatically before dev/build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = (...p) => path.join(root, "public", ...p);
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(dest, f));
  } else fs.copyFileSync(src, dest);
}

const pdfjs = pkgDir("pdfjs-dist");
// legacy build: works on a wider range of browsers (incl. older Chromium/Edge versions)
copy(path.join(pdfjs, "legacy/build/pdf.worker.min.mjs"), pub("pdfjs/pdf.worker.min.mjs"));
for (const d of ["cmaps", "standard_fonts", "wasm", "iccs"]) copy(path.join(pdfjs, d), pub("pdfjs", d));

const tess = pkgDir("tesseract.js");
copy(path.join(tess, "dist/worker.min.js"), pub("tesseract/worker.min.js"));
const core = pkgDir("tesseract.js-core");
for (const f of fs.readdirSync(core)) if (/-lstm\.wasm\.js$/.test(f)) copy(path.join(core, f), pub("tesseract/core", f));
for (const lang of ["eng", "ara"]) {
  const dir = path.join(pkgDir(`@tesseract.js-data/${lang}`), "4.0.0_best_int");
  copy(path.join(dir, `${lang}.traineddata.gz`), pub("tesseract/lang", `${lang}.traineddata.gz`));
}
console.log("Runtime assets copied to public/pdfjs and public/tesseract");
