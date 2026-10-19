import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dir = path.dirname(require.resolve("pdfjs-dist/package.json"));

/** Text of each page extracted by PDF.js (legacy build for Node). */
export async function extractText(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: path.join(dir, "standard_fonts/"), verbosity: 0 }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  await doc.loadingTask.destroy();
  return out;
}

export async function openPdfjs(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return { pdfjs, doc: await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: path.join(dir, "standard_fonts/"), verbosity: 0 }).promise };
}
