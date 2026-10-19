/// <reference lib="webworker" />
import { exportPdf, type ExportInput } from "../lib/pdf/exporter";
import { browserFaceRegistry } from "../lib/export/faces";

/**
 * Runs the export pipeline off the main thread so large documents do not
 * freeze the interface. Document bytes never leave the browser: the worker only
 * talks to the page that created it.
 */
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (ev: MessageEvent<{ input: ExportInput }>) => {
  const { input } = ev.data;
  try {
    const faces = browserFaceRegistry(() => input.assets);
    const result = await exportPdf(input, faces, (fraction, message) => self.postMessage({ type: "progress", fraction, message }));
    self.postMessage({ type: "done", bytes: result.bytes, report: result.report }, [result.bytes.buffer]);
  } catch (e) {
    self.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
