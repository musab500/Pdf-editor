"use client";
import { useEffect, useRef, useState } from "react";
import { useEditor } from "./store";
import { PageView } from "./PageView";
import { PX_PER_PT } from "./geometry";
import { pageGeometry, totalRotation } from "@/lib/model/types";

/** Continuous vertical page view with lazy rendering (only pages near the viewport render). */
export function Viewer() {
  const ed = useEditor();
  const { doc, zoom, sourceInfos } = ed;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<Set<number>>(new Set([0, 1]));
  const scale = zoom * PX_PER_PT;
  const pagesKey = doc.pages.map((p) => p.id).join(",");

  // visibility tracking
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.slot);
            if (e.isIntersecting) next.add(i);
            else next.delete(i);
          }
          return next;
        });
      },
      { root, rootMargin: "600px 0px" },
    );
    root.querySelectorAll("[data-slot]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pagesKey, zoom]);

  // current page = the slot nearest the top third of the viewport
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const mid = root.getBoundingClientRect().top + root.clientHeight / 3;
        let best = 0;
        let bestD = Infinity;
        root.querySelectorAll<HTMLElement>("[data-slot]").forEach((el) => {
          const r = el.getBoundingClientRect();
          const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
          if (d < bestD) {
            bestD = d;
            best = Number(el.dataset.slot);
          }
        });
        ed.setCurrentPage(best);
      });
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [ed]);

  // programmatic navigation
  useEffect(() => {
    const req = ed.scrollRequest;
    const root = scrollRef.current;
    if (!req || !root) return;
    const el = root.querySelector<HTMLElement>(`[data-slot="${req.index}"]`);
    if (!el) return;
    const top = el.offsetTop - 16 + (req.y !== undefined ? req.y * scale - root.clientHeight / 3 : 0);
    root.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [ed.scrollRequest, scale]);

  // ctrl + wheel zoom
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      ed.setZoom((z: number) => Math.min(5, Math.max(0.25, Math.round(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1) * 100) / 100)));
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [ed]);

  return (
    <div ref={scrollRef} className="relative h-full overflow-auto bg-bg" data-testid="viewer" tabIndex={-1}>
      <div className="flex min-w-fit flex-col items-center gap-3 px-2 py-3 sm:gap-4 sm:px-6 sm:py-5">
        {doc.pages.map((p, i) => {
          const g = pageGeometry(p, sourceInfos);
          const r = totalRotation(p, sourceInfos);
          const h = (r === 90 || r === 270 ? g.width : g.height) * scale;
          return (
            <div key={p.id} data-slot={i} style={{ minHeight: h }} className="relative">
              <PageView page={p} index={i} scale={scale} visible={visible.has(i)} />
              <div className="mt-1 text-center text-[11px] text-muted select-none">
                {i + 1} / {doc.pages.length}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
