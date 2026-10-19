"use client";
import { useEffect, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { pdfjs } from "@/lib/pdf/pdfjs";

/** PDF.js text layer: lets the user select and copy the page's existing text. */
export function TextSelectLayer({ pdf, pageIndex, scale, version }: { pdf: PDFDocumentProxy; pageIndex: number; scale: number; version: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let layer: { cancel(): void } | null = null;
    let cancelled = false;
    (async () => {
      const m = await pdfjs();
      const page = await pdf.getPage(pageIndex + 1);
      if (cancelled) return;
      el.replaceChildren();
      const viewport = page.getViewport({ scale, rotation: 0 });
      const tl = new m.TextLayer({ textContentSource: page.streamTextContent(), container: el, viewport });
      layer = tl;
      await tl.render();
    })().catch(() => {});
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [pdf, pageIndex, scale, version]);
  return (
    <div
      ref={ref}
      className="textLayer"
      style={{ ["--scale-factor" as string]: scale, ["--total-scale-factor" as string]: scale, zIndex: 2 }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
