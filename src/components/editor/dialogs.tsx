"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Eraser, Loader2, ShieldCheck, Upload, XCircle, ArrowUp, ArrowDown, X } from "lucide-react";
import { zipSync } from "fflate";
import { useEditor } from "./store";
import { Button, Field, Modal, inputCls } from "./ui";
import { editedFileName, pagesFileName, parseRanges, sanitizeFileName, downloadBytes, baseName } from "@/lib/files/filename";
import { runExport } from "@/lib/export/runExport";
import { ExportCancelled, type ExportReport } from "@/lib/pdf/exporter";
import { destroyPdf, openWithPdfjs, pdfjs, type PDFDocumentProxy } from "@/lib/pdf/pdfjs";
import { buildExpectations, verifyExport, type VerifyResult } from "@/lib/pdf/verify";
import { validateImageFile } from "@/lib/files/validate";

// ---------------------------------------------------------------- confirm / password

export function ConfirmDialog() {
  const { pendingConfirm: p, setPendingConfirm } = useEditor();
  if (!p) return null;
  const close = (ok: boolean) => {
    p.resolve(ok);
    setPendingConfirm(null);
  };
  return (
    <Modal title={p.title} onClose={() => close(false)} testId="confirm-dialog"
      footer={<><Button onClick={() => close(false)}>Cancel</Button><Button variant={p.danger ? "danger" : "primary"} onClick={() => close(true)} testId="confirm-ok">{p.confirmLabel ?? "OK"}</Button></>}>
      <div className="text-sm">{p.message}</div>
    </Modal>
  );
}

export function PasswordDialog() {
  const { pendingPassword: p, setPendingPassword } = useEditor();
  const [pw, setPw] = useState("");
  if (!p) return null;
  const close = (v: string | null) => {
    p.resolve(v);
    setPendingPassword(null);
    setPw("");
  };
  return (
    <Modal title="Password required" onClose={() => close(null)} testId="password-dialog">
      <form onSubmit={(e) => { e.preventDefault(); close(pw); }} className="space-y-3">
        <p>“{p.fileName}” is protected. Enter its password to view it.</p>
        {p.incorrect && <p className="text-danger">Incorrect password, try again.</p>}
        <input type="password" autoComplete="off" aria-label="PDF password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} data-testid="password-input" />
        <p className="text-xs text-muted">The password is only used inside this browser tab to decrypt the file. Encrypted PDFs can be viewed but not edited here.</p>
        <div className="flex justify-end gap-2"><Button onClick={() => close(null)}>Cancel</Button><Button variant="primary" type="submit">Open</Button></div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- export & preview

function PreviewPages({ pdf }: { pdf: PDFDocumentProxy }) {
  const [n, setN] = useState(Math.min(pdf.numPages, 6));
  return (
    <div className="flex flex-wrap gap-3">
      {Array.from({ length: n }, (_, i) => <PreviewPage key={i} pdf={pdf} index={i} />)}
      {n < pdf.numPages && <button className="self-center text-xs text-accent underline" onClick={() => setN(Math.min(pdf.numPages, n + 12))}>Show more pages ({pdf.numPages - n} left)</button>}
    </div>
  );
}

function PreviewPage({ pdf, index }: { pdf: PDFDocumentProxy; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(index + 1);
      if (cancelled) return;
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 240 / Math.max(vp0.width, vp0.height) * 1.5 });
      const c = ref.current!;
      c.width = vp.width;
      c.height = vp.height;
      task = page.render({ canvas: c, viewport: vp, background: "#fff" });
      await task.promise;
    })().catch(() => {});
    return () => {
      cancelled = true;
      try { task?.cancel(); } catch { /* */ }
    };
  }, [pdf, index]);
  return (
    <figure className="text-center text-[11px] text-muted">
      <canvas ref={ref} className="page-shadow max-h-[240px] max-w-[240px] bg-white" data-testid={`preview-page-${index + 1}`} />
      <figcaption>{index + 1}</figcaption>
    </figure>
  );
}

export function ExportDialog() {
  const ed = useEditor();
  const req = ed.exportRequest!;
  const full = !req.pageIds;
  const [name, setName] = useState(() => (full ? editedFileName(ed.fileName) : pagesFileName(ed.fileName, req.label ?? "pages")));
  const [phase, setPhase] = useState<"exporting" | "ready" | "error">("exporting");
  const [progress, setProgress] = useState({ f: 0, m: "Starting" });
  const [result, setResult] = useState<{ bytes: Uint8Array; report: ExportReport } | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [preview, setPreview] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const acRef = useRef<AbortController | null>(null);
  const close = useCallback(() => {
    acRef.current?.abort();
    ed.setExportRequest(null);
  }, [ed]);

  useEffect(() => {
    const ac = new AbortController();
    acRef.current = ac;
    let pdfDoc: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const sources: Record<string, Uint8Array> = {};
        for (const [id, s] of Object.entries(ed.sources)) sources[id] = s.bytes;
        const res = await runExport(
          { primarySourceId: ed.primaryId!, sources, doc: ed.doc, assets: ed.assets, pageIds: req.pageIds, title: baseName(ed.fileName) },
          (f, m) => setProgress({ f, m }),
          ac.signal,
        );
        if (ac.signal.aborted) return;
        setProgress({ f: 1, m: "Verifying" });
        pdfDoc = await openWithPdfjs(res.bytes);
        const m = await pdfjs();
        const v = await verifyExport(pdfDoc, buildExpectations(ed.doc, ed.sourceInfos, req.pageIds), [m.OPS.paintImageXObject, m.OPS.paintInlineImageXObject, m.OPS.paintImageXObjectRepeat]);
        if (ac.signal.aborted) return;
        setResult(res);
        setVerify(v);
        setPreview(pdfDoc);
        setPhase("ready");
      } catch (e) {
        if (e instanceof ExportCancelled || ac.signal.aborted) return;
        setError((e as Error).message);
        setPhase("error");
      }
    })();
    return () => {
      ac.abort();
      destroyPdf(pdfDoc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = () => {
    if (!result) return;
    const fn = sanitizeFileName(name);
    downloadBytes(result.bytes, fn);
    if (full) ed.dispatch({ type: "markSaved" });
    ed.toast("success", `Downloaded ${fn}`);
    close();
  };

  return (
    <Modal title={full ? "Download PDF" : "Export selected pages"} onClose={close} wide testId="export-dialog"
      footer={<>
        <Button onClick={close}>{phase === "exporting" ? "Cancel" : "Close"}</Button>
        <Button variant="primary" onClick={download} disabled={phase !== "ready"} testId="export-download"><Download className="h-4 w-4" /> Download</Button>
      </>}>
      <div className="space-y-3">
        <Field label="File name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" data-testid="export-filename" />
        </Field>
        {phase === "exporting" && (
          <div className="space-y-2" data-testid="export-progress">
            <div className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> {progress.m}…</div>
            <div className="h-1.5 overflow-hidden rounded bg-panel-2"><div className="h-full bg-accent transition-all" style={{ width: `${Math.round(progress.f * 100)}%` }} /></div>
          </div>
        )}
        {phase === "error" && <div className="flex gap-2 rounded bg-danger/10 p-3 text-danger"><XCircle className="h-4 w-4 shrink-0" />Export failed: {error}</div>}
        {phase === "ready" && result && verify && (
          <>
            <div className={`flex gap-2 rounded p-3 text-sm ${verify.ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-warn-bg text-warn-text"}`} data-testid="verify-result">
              {verify.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
              <div>
                {verify.ok
                  ? `Verified: the exported file was reopened and ${verify.checks} checks passed (pages, sizes, rotation, text and images).`
                  : "The exported file was reopened, but some checks did not pass:"}
                {!verify.ok && <ul className="mt-1 list-disc pl-4">{verify.issues.map((i, k) => <li key={k}>{i.page ? `Page ${i.page}: ` : ""}{i.message}</li>)}</ul>}
                <div className="mt-1 text-xs opacity-80">{result.report.pageCount} page(s), {(result.bytes.length / 1024).toFixed(0)} KB</div>
              </div>
            </div>
            {result.report.warnings.length > 0 && (
              <div className="rounded bg-warn-bg p-3 text-xs text-warn-text">
                <b>Notes</b>
                <ul className="mt-1 list-disc pl-4">{[...new Set(result.report.warnings)].map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
            {preview && <PreviewPages pdf={preview} />}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- split

export function SplitDialog({ onClose }: { onClose: () => void }) {
  const ed = useEditor();
  const n = ed.doc.pages.length;
  const [ranges, setRanges] = useState(n > 1 ? `1-${Math.ceil(n / 2)}, ${Math.ceil(n / 2) + 1}-${n}` : "1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const acRef = useRef<AbortController | null>(null);
  const parsed = parseRanges(ranges, n);
  const run = async () => {
    if ("error" in parsed) return;
    setBusy(true);
    setErr("");
    const ac = new AbortController();
    acRef.current = ac;
    try {
      const sources: Record<string, Uint8Array> = {};
      for (const [id, s] of Object.entries(ed.sources)) sources[id] = s.bytes;
      const files: Record<string, Uint8Array> = {};
      for (let k = 0; k < parsed.ranges.length; k++) {
        const r = parsed.ranges[k];
        const label = r.length === 1 ? `p${r[0] + 1}` : `p${r[0] + 1}-${r[r.length - 1] + 1}`;
        const pageIds = r.map((i) => ed.doc.pages[i].id);
        const res = await runExport({ primarySourceId: ed.primaryId!, sources, doc: ed.doc, assets: ed.assets, pageIds }, () => {}, ac.signal);
        const check = await openWithPdfjs(res.bytes);
        const ok = check.numPages === r.length;
        await destroyPdf(check);
        if (!ok) throw new Error(`Part ${label} did not verify.`);
        files[pagesFileName(ed.fileName, label)] = res.bytes;
      }
      const names = Object.keys(files);
      if (names.length === 1) downloadBytes(files[names[0]], names[0]);
      else downloadBytes(zipSync(files, { level: 0 }), `${baseName(ed.fileName)}-split.zip`, "application/zip");
      ed.toast("success", names.length === 1 ? "Downloaded 1 file." : `Downloaded ${names.length} PDFs in a ZIP file.`);
      onClose();
    } catch (e) {
      if (!ac.signal.aborted) setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Split into page ranges" onClose={() => { acRef.current?.abort(); onClose(); }} testId="split-dialog"
      footer={<><Button onClick={() => { acRef.current?.abort(); onClose(); }}>Cancel</Button><Button variant="primary" onClick={run} disabled={busy || "error" in parsed} testId="split-run">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Split &amp; download</Button></>}>
      <div className="space-y-3">
        <Field label="Page ranges" hint={`Each comma-separated range becomes its own PDF. Pages 1–${n}. Example: 1-3, 4, 5-`}>
          <input className={inputCls} value={ranges} onChange={(e) => setRanges(e.target.value)} aria-label="Page ranges" data-testid="split-ranges" />
        </Field>
        {"error" in parsed ? <p className="text-xs text-danger">{parsed.error}</p> : <p className="text-xs text-muted">{parsed.ranges.length} file(s) will be created{parsed.ranges.length > 1 ? " and downloaded as one ZIP" : ""}. Added content and edits are included.</p>}
        {err && <p className="text-xs text-danger">{err}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- merge

export function MergeDialog({ onClose }: { onClose: () => void }) {
  const ed = useEditor();
  const [files, setFiles] = useState<File[]>([]);
  const ref = useRef<HTMLInputElement>(null);
  const move = (i: number, d: -1 | 1) => {
    const f = [...files];
    const j = i + d;
    if (j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]];
    setFiles(f);
  };
  return (
    <Modal title="Merge PDFs" onClose={onClose} testId="merge-dialog"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!files.length} onClick={async () => { onClose(); await ed.importPdfs(files, ed.doc.pages.length); }} testId="merge-run">Append {files.length || ""} file(s)</Button></>}>
      <div className="space-y-3">
        <p className="text-muted">The pages of the chosen PDFs are appended after page {ed.doc.pages.length}, in this order.</p>
        <Button onClick={() => ref.current?.click()}><Upload className="h-4 w-4" /> Choose PDF files…</Button>
        <input ref={ref} type="file" accept="application/pdf,.pdf" multiple hidden data-testid="merge-input" onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
        <ol className="space-y-1">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-2 rounded border border-line px-2 py-1">
              <span className="min-w-0 flex-1 truncate">{i + 1}. {f.name}</span>
              <button aria-label="Move up" onClick={() => move(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></button>
              <button aria-label="Move down" onClick={() => move(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></button>
              <button aria-label="Remove" onClick={() => setFiles(files.filter((_, k) => k !== i))}><X className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ol>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- images & signature

/** Decode any browser-supported image and return PNG/JPEG bytes that pdf-lib can embed. */
export async function prepareImage(file: File | Blob, name: string): Promise<{ bytes: Uint8Array; mime: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const type = file.type;
  if (type === "image/png" || type === "image/jpeg") {
    bitmap.close();
    return { bytes: new Uint8Array(await file.arrayBuffer()), mime: type, width, height };
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error(`Could not convert ${name}`))), "image/png"));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png", width, height };
}

export function SignatureDialog({ onClose }: { onClose: () => void }) {
  const ed = useEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState("#0b1f66");
  const [width, setWidth] = useState(3);
  const [empty, setEmpty] = useState(true);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pos = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  const placeSignature = async (blob: Blob, w: number, h: number) => {
    const id = ed.addAsset({ kind: "image", mime: "image/png", name: `signature-${Date.now()}`, bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h });
    ed.setPendingImage(id);
    ed.setTool("place-image");
    ed.toast("info", "Click on the page where the signature should go.");
    onClose();
  };
  const finish = async () => {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++)
        if (d[(y * c.width + x) * 4 + 3] > 8) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
    if (x1 <= x0) return;
    const pad = 6;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width, x1 + pad); y1 = Math.min(c.height, y1 + pad);
    const out = document.createElement("canvas");
    out.width = x1 - x0;
    out.height = y1 - y0;
    out.getContext("2d")!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    const blob = await new Promise<Blob>((res) => out.toBlob((b) => res(b!), "image/png"));
    await placeSignature(blob, out.width / 2, out.height / 2);
  };
  return (
    <Modal title="Signature" onClose={onClose} wide testId="signature-dialog"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={empty} onClick={finish} testId="signature-use">Use signature</Button></>}>
      <div className="space-y-3">
        <p className="text-muted">Draw with the mouse, touchpad or pen. The signature is added as a transparent image you can move and resize.</p>
        <canvas
          ref={canvasRef}
          width={1200}
          height={400}
          className="checker h-[200px] w-full touch-none rounded border border-line bg-white"
          data-testid="signature-pad"
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drawing.current = pos(e); }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const p = pos(e);
            const ctx = canvasRef.current!.getContext("2d")!;
            ctx.strokeStyle = color;
            ctx.lineWidth = width * 2 * (e.pressure && e.pointerType === "pen" ? 0.5 + e.pressure : 1);
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(drawing.current.x, drawing.current.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            drawing.current = p;
            setEmpty(false);
          }}
          onPointerUp={() => (drawing.current = null)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1 text-xs">Color <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Pen color" /></label>
          <label className="flex items-center gap-1 text-xs">Width <input type="range" min={1} max={8} value={width} onChange={(e) => setWidth(Number(e.target.value))} aria-label="Pen width" /></label>
          <Button onClick={() => { const c = canvasRef.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); setEmpty(true); }}><Eraser className="h-4 w-4" /> Clear</Button>
          <Button onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" /> Import image…</Button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            const v = validateImageFile(f.name, f.type, f.size);
            if (!v.ok) return ed.toast("error", v.error);
            try {
              const img = await prepareImage(f, f.name);
              await placeSignature(new Blob([img.bytes as BlobPart], { type: img.mime }), img.width, img.height);
            } catch (err) {
              ed.toast("error", (err as Error).message);
            }
          }} />
        </div>
      </div>
    </Modal>
  );
}

export function PrivacyDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Privacy & how editing works" onClose={onClose} wide testId="privacy-dialog">
      <div className="space-y-3 leading-relaxed">
        <p className="flex gap-2"><ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600" /><span><b>Your files stay on this device.</b> PDFs are opened, rendered, edited and exported inside this browser tab (PDF.js, pdf-lib and Tesseract.js run locally, partly in Web Workers). The app has no upload endpoint, no analytics, no cloud storage and no AI service. The web server only delivers the app’s own code, fonts and OCR data. Documents are kept in memory only and are gone when you close the tab.</span></p>
        <p className="text-muted">This statement describes the app’s design; it was verified by inspecting network traffic in automated tests. Browser extensions or a modified deployment could behave differently.</p>
        <h3 className="font-semibold">Editing existing text — two modes</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li><b>Edit text (native)</b> rewrites the original text operators of the PDF in the original font. It is offered only when it can be done safely: the font must contain every character you type, the text must be a single line in a simple script, and the result is reopened to verify it. Following text is not reflowed.</li>
          <li><b>Replace (visual)</b> covers an area with a background-coloured box and draws new text on top. The original text <b>remains in the file</b> underneath and can still be copied, searched or extracted. It is <b>not redaction</b>; do not use it to hide confidential information.</li>
        </ul>
        <p>Text boxes, images, signatures, drawings, shapes and highlights you add are drawn into the page content when you download; they are not interactive PDF annotations.</p>
      </div>
    </Modal>
  );
}
