"use client";
import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * Optional OCR with Tesseract.js. The engine, its WebAssembly core and the
 * English/Arabic language data are served from this app (/public/tesseract),
 * and recognition runs entirely in a browser Web Worker.
 */

export interface OcrResultLine {
  text: string;
  x: number; // page points (unrotated, top-left origin)
  y: number;
  w: number;
  h: number;
  confidence: number;
}

type TesseractWorker = {
  recognize: (img: HTMLCanvasElement, opts?: object, output?: object) => Promise<{ data: OcrData }>;
  terminate: () => Promise<unknown>;
};
interface OcrBBox { x0: number; y0: number; x1: number; y1: number }
interface OcrData {
  blocks?: { paragraphs: { lines: { text: string; bbox: OcrBBox; confidence: number }[] }[] }[] | null;
}

export async function recognizePage(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  langs: string[],
  onProgress: (p: number, status: string) => void,
  signal: AbortSignal,
): Promise<OcrResultLine[]> {
  const T = await import("tesseract.js");
  const page = await pdf.getPage(pageIndex + 1);
  const scale = 2.5; // ~180 dpi
  const vp = page.getViewport({ scale, rotation: 0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.render({ canvas, viewport: vp, background: "#ffffff" }).promise;
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

  const worker = (await T.createWorker(langs, T.OEM.LSTM_ONLY, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract/core",
    langPath: "/tesseract/lang",
    gzip: true,
    workerBlobURL: false,
    cacheMethod: "none",
    logger: (m: { status: string; progress: number }) => onProgress(m.progress ?? 0, m.status),
  })) as unknown as TesseractWorker;
  const abort = () => void worker.terminate();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
    const lines: OcrResultLine[] = [];
    for (const b of data.blocks ?? [])
      for (const p of b.paragraphs)
        for (const l of p.lines) {
          const text = l.text.replace(/\s+/g, " ").trim();
          if (!text) continue;
          lines.push({
            text,
            x: l.bbox.x0 / scale,
            y: l.bbox.y0 / scale,
            w: (l.bbox.x1 - l.bbox.x0) / scale,
            h: (l.bbox.y1 - l.bbox.y0) / scale,
            confidence: l.confidence,
          });
        }
    return lines;
  } finally {
    signal.removeEventListener("abort", abort);
    await worker.terminate().catch(() => {});
    canvas.width = 0;
  }
}
