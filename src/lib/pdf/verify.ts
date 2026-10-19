import type { PDFDocumentProxy } from "pdfjs-dist";
import type { EditorDoc, PageEntry, Rotation, SourceInfo } from "../model/types";
import { pageGeometry, totalRotation } from "../model/types";

/**
 * Re-open an exported file with PDF.js and check that it reflects the editing
 * state: page count, page sizes/rotation, added and natively edited text, and
 * added images. Text checks are tolerant to whitespace; right-to-left text is
 * checked character-wise because extraction order differs between viewers.
 */

export interface PageExpectation {
  width: number;
  height: number;
  rotation: Rotation;
  texts: string[];
  minImages: number;
}

export interface VerifyIssue {
  page?: number;
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
  checks: number;
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

export function textFound(expected: string, pageText: string): boolean {
  const e = norm(expected);
  if (!e) return true;
  const p = norm(pageText);
  if (p.includes(e)) return true;
  if (RTL.test(expected)) {
    // extraction of shaped RTL text varies (visual order, presentation forms): require each base letter
    const pChars = new Set(Array.from(p));
    return Array.from(e).filter((c) => !/[ً-ٰٟ]/.test(c)).every((c) => pChars.has(c));
  }
  return false;
}

export function buildExpectations(doc: EditorDoc, sources: Record<string, SourceInfo>, pageIds?: string[]): PageExpectation[] {
  const pages: PageEntry[] = pageIds ? pageIds.map((id) => doc.pages.find((p) => p.id === id)!).filter(Boolean) : doc.pages;
  return pages.map((p) => {
    const g = pageGeometry(p, sources);
    const objs = doc.objects.filter((o) => o.pageId === p.id);
    const texts: string[] = [];
    for (const o of objs) if ((o.kind === "text" || o.kind === "replace") && o.text.trim()) texts.push(...o.text.split(/\n+/).filter((t) => t.trim()));
    if (p.origin.kind === "source") {
      const edits = doc.nativeEdits[p.origin.sourceId]?.[p.origin.index];
      if (edits) for (const e of Object.values(edits)) if (e.text.trim()) texts.push(e.text);
    }
    return {
      width: g.width,
      height: g.height,
      rotation: totalRotation(p, sources),
      texts,
      minImages: objs.filter((o) => o.kind === "image").length,
    };
  });
}

export async function verifyExport(pdf: PDFDocumentProxy, expected: PageExpectation[], imageOps: number[]): Promise<VerifyResult> {
  const issues: VerifyIssue[] = [];
  let checks = 1;
  if (pdf.numPages !== expected.length) issues.push({ message: `Expected ${expected.length} pages but the file has ${pdf.numPages}.` });
  const n = Math.min(pdf.numPages, expected.length);
  for (let i = 0; i < n; i++) {
    const exp = expected[i];
    const page = await pdf.getPage(i + 1);
    const [x0, y0, x1, y1] = page.view;
    checks++;
    if (Math.abs(x1 - x0 - exp.width) > 1 || Math.abs(y1 - y0 - exp.height) > 1)
      issues.push({ page: i + 1, message: `Page size is ${Math.round(x1 - x0)}×${Math.round(y1 - y0)} pt, expected ${Math.round(exp.width)}×${Math.round(exp.height)} pt.` });
    checks++;
    if (page.rotate % 360 !== exp.rotation) issues.push({ page: i + 1, message: `Page rotation is ${page.rotate}°, expected ${exp.rotation}°.` });
    if (exp.texts.length) {
      const content = await page.getTextContent();
      const text = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
      for (const t of exp.texts) {
        checks++;
        if (!textFound(t, text)) issues.push({ page: i + 1, message: `Text “${t.length > 40 ? t.slice(0, 40) + "…" : t}” was not found in the exported page.` });
      }
    }
    if (exp.minImages) {
      checks++;
      const ops = await page.getOperatorList();
      const count = ops.fnArray.filter((f) => imageOps.includes(f)).length;
      if (count < exp.minImages) issues.push({ page: i + 1, message: `Expected at least ${exp.minImages} image(s), found ${count}.` });
    }
    page.cleanup();
  }
  return { ok: issues.length === 0, issues, checks };
}
