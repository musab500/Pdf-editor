"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { pdfjs } from "@/lib/pdf/pdfjs";

export interface PageCanvasHandle {
  canvas: HTMLCanvasElement | null;
  /** device pixels per page point of the current bitmap */
  pixelsPerPoint: number;
}

/**
 * Renders one PDF page (unrotated) into a canvas. Rendering is lazy (only when
 * `visible`) and cancelled when the zoom changes or the page scrolls away.
 */
export const PageCanvas = forwardRef<
  PageCanvasHandle,
  {
    pdf: PDFDocumentProxy | null;
    pageIndex: number;
    widthPt: number;
    heightPt: number;
    scale: number; // css px per point
    visible: boolean;
    version: number;
    hideForms?: boolean;
    maxPixels?: number;
    onRendered?: () => void;
  }
>(function PageCanvas({ pdf, pageIndex, widthPt, heightPt, scale, visible, version, hideForms, maxPixels = 16_000_000, onRendered }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ppp, setPpp] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useImperativeHandle(ref, () => ({ canvas: canvasRef.current, pixelsPerPoint: ppp }), [ppp]);

  useEffect(() => {
    if (!pdf || !visible) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    const timer = setTimeout(async () => {
      try {
        const m = await pdfjs();
        const page = await pdf.getPage(pageIndex + 1);
        if (cancelled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        let s = scale * dpr;
        // cap the bitmap size to keep memory bounded on large zoom levels
        if (widthPt * heightPt * s * s > maxPixels) s = Math.sqrt(maxPixels / (widthPt * heightPt));
        const viewport = page.getViewport({ scale: s, rotation: 0 });
        const off = document.createElement("canvas");
        off.width = Math.ceil(viewport.width);
        off.height = Math.ceil(viewport.height);
        task = page.render({
          canvas: off,
          viewport,
          annotationMode: hideForms ? m.AnnotationMode.ENABLE_FORMS : m.AnnotationMode.ENABLE,
          background: "#ffffff",
        });
        await task.promise;
        if (cancelled) return;
        const c = canvasRef.current;
        if (c) {
          c.width = off.width;
          c.height = off.height;
          c.getContext("2d")!.drawImage(off, 0, 0);
          off.width = 0;
          setPpp(s);
          setError(null);
          onRendered?.();
        }
      } catch (e) {
        const name = (e as Error)?.name;
        if (!cancelled && name !== "RenderingCancelledException") setError((e as Error).message || "Render failed");
      }
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      try {
        task?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, [pdf, pageIndex, scale, visible, version, hideForms, widthPt, heightPt, maxPixels, onRendered]);

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "#fff" }}
        aria-hidden
      />
      {error && (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-danger">Could not render this page: {error}</div>
      )}
    </>
  );
});
