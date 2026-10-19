"use client";
import { PDFDocument } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageGeometry, Rotation, SourceInfo, NativeEdits } from "@/lib/model/types";
import { destroyPdf, openWithPdfjs } from "@/lib/pdf/pdfjs";
import { FontCache } from "@/lib/pdf/fontInfo";
import { analyzePageText, type PageTextAnalysis } from "@/lib/pdf/textAnalysis";
import { applyNativeEdits, collectFontUsage, type FontUsage, type NativeEditResult } from "@/lib/pdf/nativeEdit";
import { readFields, type FieldInfo } from "@/lib/pdf/forms";
import { fontkit } from "@/lib/text/fontFaces";

/**
 * Runtime data for each opened PDF ("source"). Bytes are kept exactly as
 * loaded; PDF.js renders either the original or a patched copy that contains
 * the current native text edits.
 */
export class SourceRuntime {
  pdf: PDFDocumentProxy; // what is rendered (patched when native edits exist)
  basePdf: PDFDocumentProxy; // original
  private libDoc?: Promise<PDFDocument>;
  private fontCache?: FontCache;
  private analyses = new Map<number, PageTextAnalysis>();
  private usage?: FontUsage;
  renderedEditsKey = "";
  fields?: FieldInfo[];
  /** bumps whenever `pdf` changes so pages re-render */
  renderVersion = 0;

  constructor(
    public info: SourceInfo,
    public bytes: Uint8Array,
    pdf: PDFDocumentProxy,
  ) {
    this.pdf = pdf;
    this.basePdf = pdf;
  }

  get editable() {
    return !this.info.readOnlyReason;
  }

  /** pristine pdf-lib document (for analysis only – never mutated) */
  lib(): Promise<PDFDocument> {
    if (!this.libDoc) {
      this.libDoc = PDFDocument.load(this.bytes, { updateMetadata: false }).then((d) => {
        d.registerFontkit(fontkit);
        this.fontCache = new FontCache(d.context);
        return d;
      });
    }
    return this.libDoc;
  }

  async analysis(pageIndex: number): Promise<PageTextAnalysis> {
    const cached = this.analyses.get(pageIndex);
    if (cached) return cached;
    const d = await this.lib();
    const a = analyzePageText(d.context, d.getPage(pageIndex), this.fontCache);
    this.analyses.set(pageIndex, a);
    return a;
  }

  /** glyph usage of each font across (up to 400 pages of) the document */
  async fontUsage(): Promise<FontUsage> {
    if (!this.usage) {
      const n = Math.min(this.info.pageCount, 400);
      const list: PageTextAnalysis[] = [];
      for (let i = 0; i < n; i++) list.push(await this.analysis(i));
      this.usage = collectFontUsage(list);
    }
    return this.usage;
  }

  /** Build bytes of this source with the given native edits applied. */
  async buildPatched(edits: NativeEdits[string] | undefined): Promise<{ bytes: Uint8Array; results: (NativeEditResult & { pageIndex: number })[] }> {
    const d = await PDFDocument.load(this.bytes, { updateMetadata: false });
    const cache = new FontCache(d.context);
    const usage = await this.fontUsage();
    const results: (NativeEditResult & { pageIndex: number })[] = [];
    for (const [idx, lines] of Object.entries(edits ?? {})) {
      const page = d.getPage(Number(idx));
      const r = applyNativeEdits(d, page, Object.entries(lines).map(([lineId, e]) => ({ lineId, text: e.text })), { usage, fontCache: cache });
      results.push(...r.map((x) => ({ ...x, pageIndex: Number(idx) })));
    }
    return { bytes: await d.save({ updateFieldAppearances: false }), results };
  }

  async setRenderPdf(pdf: PDFDocumentProxy, key: string) {
    const old = this.pdf;
    this.pdf = pdf;
    this.renderedEditsKey = key;
    this.renderVersion++;
    if (old !== this.basePdf && old !== pdf) await destroyPdf(old);
  }

  async destroy() {
    if (this.pdf !== this.basePdf) await destroyPdf(this.pdf);
    await destroyPdf(this.basePdf);
  }
}

export interface OpenResult {
  runtime?: SourceRuntime;
  needsPassword?: { incorrect: boolean };
  warning?: string;
}

export async function openSource(id: string, name: string, bytes: Uint8Array, password?: string): Promise<SourceRuntime> {
  const pdf = await openWithPdfjs(bytes, password);
  const pages: PageGeometry[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const [x0, y0, x1, y1] = p.view;
    pages.push({ width: x1 - x0, height: y1 - y0, viewBox: [x0, y0, x1, y1], baseRotation: (((p.rotate % 360) + 360) % 360) as Rotation });
  }
  let readOnlyReason: string | undefined;
  let hasForm = false;
  let fields: FieldInfo[] | undefined;
  try {
    const d = await PDFDocument.load(bytes, { updateMetadata: false });
    fields = readFields(d);
    hasForm = fields.length > 0;
  } catch (e) {
    const msg = (e as Error).message || "";
    readOnlyReason = /encrypt/i.test(msg)
      ? "This PDF is encrypted (password or permission protection). It can be viewed, searched and copied, but the editing library used here cannot decrypt it, so editing and export are disabled. Remove the protection with the owner's permission (e.g. “Print to PDF”), then open the copy."
      : `This PDF could not be prepared for editing (${msg}). It can still be viewed.`;
  }
  const info: SourceInfo = { id, name, size: bytes.length, pageCount: pdf.numPages, pages, readOnlyReason, hasForm };
  const rt = new SourceRuntime(info, bytes, pdf);
  rt.fields = fields;
  return rt;
}
