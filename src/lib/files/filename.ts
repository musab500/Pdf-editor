/** Output file naming. */

export function baseName(name: string): string {
  return name.replace(/\.pdf$/i, "").trim() || "document";
}

export function sanitizeFileName(name: string): string {
  // remove characters invalid on Windows/macOS, control chars and trailing dots/spaces
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim();
  if (!s) s = "document";
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s.replace(/\.pdf$/i, ""))) s = `_${s}`;
  if (!/\.pdf$/i.test(s)) s += ".pdf";
  return s.length > 200 ? s.slice(0, 196) + ".pdf" : s;
}

export function editedFileName(original: string): string {
  return sanitizeFileName(`${baseName(original)}-edited.pdf`);
}

export function pagesFileName(original: string, label: string): string {
  return sanitizeFileName(`${baseName(original)}-${label}.pdf`);
}

/** Trigger a browser download of in-memory bytes; the object URL is revoked afterwards. */
export function downloadBytes(bytes: Uint8Array, fileName: string, mime = "application/pdf") {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Parse "1-3, 5, 8-" style page ranges (1-based) into groups of 0-based indices. */
export function parseRanges(input: string, pageCount: number): { ranges: number[][] } | { error: string } {
  const parts = input.split(/[,;]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { error: "Enter at least one page range, e.g. 1-3, 5" };
  const ranges: number[][] = [];
  for (const part of parts) {
    const m = /^(\d+)?\s*(?:(-)\s*(\d+)?)?$/.exec(part);
    if (!m || (!m[1] && !m[3])) return { error: `“${part}” is not a valid page or range.` };
    const from = m[1] ? parseInt(m[1], 10) : 1;
    const to = m[2] ? (m[3] ? parseInt(m[3], 10) : pageCount) : from;
    if (from < 1 || to < 1 || from > pageCount || to > pageCount) return { error: `“${part}” is outside 1–${pageCount}.` };
    if (to < from) return { error: `“${part}” ends before it starts.` };
    ranges.push(Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i));
  }
  return { ranges };
}
