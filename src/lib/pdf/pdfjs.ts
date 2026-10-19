"use client";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

/**
 * Browser-side PDF.js access. The library and its worker are self-hosted
 * (copied into /public/pdfjs by scripts/copy-assets.mjs). Scripting is never
 * enabled, so JavaScript embedded in PDFs is not executed.
 */

// The legacy build includes polyfills for newer JS APIs used by PDF.js, so the
// editor also works on browsers that are a few versions behind.
type PdfjsModule = typeof import("pdfjs-dist");
let modPromise: Promise<PdfjsModule> | null = null;

export function pdfjs(): Promise<PdfjsModule> {
  if (!modPromise) {
    modPromise = (import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfjsModule>).then((m) => {
      m.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
      return m;
    });
  }
  return modPromise;
}

export class PasswordRequiredError extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? "Incorrect password" : "Password required");
  }
}

export async function openWithPdfjs(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const m = await pdfjs();
  const task = m.getDocument({
    // PDF.js transfers the buffer to its worker; give it a copy so our original stays intact
    data: bytes.slice(),
    password,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
    enableXfa: false,
    stopAtErrors: false,
  });
  try {
    return await task.promise;
  } catch (e) {
    const err = e as { name?: string; code?: number; message?: string };
    if (err?.name === "PasswordException") throw new PasswordRequiredError(err.code === m.PasswordResponses.INCORRECT_PASSWORD);
    if (err?.name === "InvalidPDFException") throw new Error("The file is damaged or is not a valid PDF.");
    throw new Error(err?.message || "PDF.js could not open the file.");
  }
}

export interface TextItemBox {
  str: string;
  /** rectangle in unrotated, top-left page space (points, relative to the view box) */
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  dir: string;
  fontName: string;
}

/** Page text items with geometry, in the editor's unrotated top-left coordinate space. */
export async function pageTextItems(page: PDFPageProxy): Promise<TextItemBox[]> {
  const content = await page.getTextContent();
  const [x0, , , y1] = page.view;
  const items: TextItemBox[] = [];
  for (const it of content.items) {
    if (!("str" in it) || !it.str.trim()) continue;
    const [a, b, , , e, f] = it.transform as number[];
    const fontSize = Math.hypot(a, b) || it.height;
    const w = it.width;
    const h = it.height || fontSize;
    items.push({
      str: it.str,
      x: e - x0,
      y: y1 - f - h * 0.8,
      w,
      h: h * 1.05,
      fontSize,
      dir: it.dir,
      fontName: it.fontName,
    });
  }
  return items;
}

export async function pageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  return content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");
}

export type { PDFDocumentProxy, PDFPageProxy };

/** Release a document and its worker-side resources. */
export function destroyPdf(pdf: PDFDocumentProxy | null | undefined): Promise<void> {
  if (!pdf) return Promise.resolve();
  return pdf.loadingTask.destroy().catch(() => {});
}
