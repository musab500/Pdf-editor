/** Input validation for files chosen by the user (before any parsing). */

export const MAX_FILE_BYTES = 200 * 1024 * 1024; // hard limit: browsers struggle beyond this
// soft limits, chosen from measurements (see README "Performance"): a 63 MB / 24-page scan and a
// 1000-page text PDF opened and exported in a few seconds; beyond these, memory use grows quickly.
export const WARN_FILE_BYTES = 100 * 1024 * 1024;
export const WARN_PAGE_COUNT = 1000;

export type ValidationResult = { ok: true; warning?: string } | { ok: false; error: string };

export function hasPdfHeader(bytes: Uint8Array): boolean {
  // the header may be preceded by junk; PDF readers search the first 1 KB
  const head = bytes.subarray(0, Math.min(bytes.length, 1024));
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

export function validatePdfFile(name: string, type: string, bytes: Uint8Array): ValidationResult {
  if (bytes.length === 0) return { ok: false, error: `“${name}” is empty (0 bytes).` };
  if (bytes.length > MAX_FILE_BYTES)
    return { ok: false, error: `“${name}” is ${(bytes.length / 1048576).toFixed(0)} MB. Files above ${MAX_FILE_BYTES / 1048576} MB are not supported in the browser.` };
  const looksPdf = /\.pdf$/i.test(name) || type === "application/pdf";
  if (!hasPdfHeader(bytes))
    return { ok: false, error: looksPdf ? `“${name}” does not contain a PDF header; it is damaged or not really a PDF.` : `“${name}” is not a PDF file.` };
  if (bytes.length > WARN_FILE_BYTES) return { ok: true, warning: `This is a large file (${(bytes.length / 1048576).toFixed(0)} MB). Rendering and export may be slow.` };
  return { ok: true };
}

export function validateImageFile(name: string, type: string, size: number): ValidationResult {
  if (!/^image\/(png|jpeg|webp|gif|bmp|svg\+xml)$/.test(type)) return { ok: false, error: `“${name}” is not a supported image (PNG, JPEG, WebP, GIF, BMP, SVG).` };
  if (size > 30 * 1024 * 1024) return { ok: false, error: `“${name}” is larger than 30 MB.` };
  return { ok: true };
}
