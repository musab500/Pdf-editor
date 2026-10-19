"use client";
import { ExportCancelled, exportPdf, type ExportInput, type ExportResult, type ProgressFn } from "../pdf/exporter";
import { browserFaceRegistry } from "./faces";

/**
 * Export in a Web Worker when available, falling back to the main thread.
 * Cancelling terminates the worker immediately.
 */
export function runExport(input: ExportInput, onProgress: ProgressFn, signal: AbortSignal): Promise<ExportResult> {
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL("../../workers/export.worker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = undefined;
  }
  if (!worker) return exportPdf(input, browserFaceRegistry(() => input.assets), onProgress, signal);
  const w = worker;
  return new Promise<ExportResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      w.terminate();
      fn();
    };
    signal.addEventListener("abort", () => finish(() => reject(new ExportCancelled())), { once: true });
    w.onmessage = (ev: MessageEvent) => {
      const d = ev.data;
      if (d.type === "progress") onProgress(d.fraction, d.message);
      else if (d.type === "done") finish(() => resolve({ bytes: d.bytes, report: d.report }));
      else if (d.type === "error") finish(() => reject(new Error(d.message)));
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      // worker could not start (e.g. bundling issue) – fall back to the main thread
      finish(() => exportPdf(input, browserFaceRegistry(() => input.assets), onProgress, signal).then(resolve, reject));
    };
    w.postMessage({ input });
  });
}
