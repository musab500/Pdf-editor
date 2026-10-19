"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, Copy, FilePlus2, FileStack, FileOutput, Files, RotateCcw, RotateCw, Scissors, Search, SquarePlus, Trash2, LayoutGrid, Loader2,
} from "lucide-react";
import { useEditor } from "./store";
import { pageGeometry, totalRotation, type PageEntry } from "@/lib/model/types";
import { deletePages, duplicatePages, insertBlankPage, movePages, rotatePages } from "@/lib/model/ops";
import { pdfjs } from "@/lib/pdf/pdfjs";
import { IconButton } from "./ui";

function Thumb({ page, index, active, selected, onClick, onDragStart, onDrop }: {
  page: PageEntry; index: number; active: boolean; selected: boolean;
  onClick: (e: React.MouseEvent) => void; onDragStart: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent, after: boolean) => void;
}) {
  const ed = useEditor();
  const ref = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [dropHint, setDropHint] = useState<"before" | "after" | null>(null);
  const g = pageGeometry(page, ed.sourceInfos);
  const rot = totalRotation(page, ed.sourceInfos);
  const rt = page.origin.kind === "source" ? ed.sources[page.origin.sourceId] : undefined;
  const W = 116;
  const s = W / Math.max(g.width, g.height);
  const w = g.width * s, h = g.height * s;
  const swap = rot === 90 || rot === 270;
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!seen || !rt || page.origin.kind !== "source") return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    (async () => {
      const m = await pdfjs();
      const p = await rt.pdf.getPage(page.origin.kind === "source" ? page.origin.index + 1 : 1);
      if (cancelled) return;
      const vp = p.getViewport({ scale: s * 2, rotation: 0 });
      const c = ref.current;
      if (!c) return;
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      task = p.render({ canvas: c, viewport: vp, annotationMode: m.AnnotationMode.ENABLE, background: "#fff" });
      await task.promise;
    })().catch(() => {});
    return () => {
      cancelled = true;
      try { task?.cancel(); } catch { /* */ }
    };
  }, [seen, rt, page.origin, s, rt?.renderVersion]);
  const objCount = ed.doc.objects.filter((o) => o.pageId === page.id).length;
  return (
    <div
      ref={boxRef}
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setDropHint(e.clientY < r.top + r.height / 2 ? "before" : "after");
      }}
      onDragLeave={() => setDropHint(null)}
      onDrop={(e) => {
        const hint = dropHint;
        setDropHint(null);
        onDrop(e, hint === "after");
      }}
      className={`relative flex cursor-pointer flex-col items-center rounded-md p-1.5 ${selected ? "bg-accent-soft" : "hover:bg-panel-2"} ${active ? "ring-2 ring-accent" : ""}`}
      onClick={onClick}
      role="option"
      aria-selected={selected}
      aria-label={`Page ${index + 1}`}
      data-testid={`thumb-${index + 1}`}
    >
      {dropHint && <div className={`absolute left-1 right-1 h-0.5 bg-accent ${dropHint === "before" ? "-top-0.5" : "-bottom-0.5"}`} />}
      <div className="relative grid place-items-center" style={{ width: swap ? h : w, height: swap ? w : h }}>
        <div className="page-shadow absolute bg-white" style={{ width: w, height: h, transform: `rotate(${rot}deg)` }}>
          {rt && <canvas ref={ref} style={{ width: "100%", height: "100%" }} />}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1 text-[11px] text-muted">
        <span>{index + 1}</span>
        {objCount > 0 && <span className="rounded bg-accent/15 px-1 text-accent" title="Added objects on this page">+{objCount}</span>}
        {page.origin.kind === "blank" && <span>blank</span>}
      </div>
    </div>
  );
}

function SearchPanel() {
  const ed = useEditor();
  const [q, setQ] = useState("");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const run = async () => {
    if (!q.trim()) return;
    setRunning(true);
    setDone(false);
    const hits: typeof ed.searchHits = [];
    const needle = caseSensitive ? q : q.toLocaleLowerCase();
    try {
      for (let i = 0; i < ed.doc.pages.length; i++) {
        const p = ed.doc.pages[i];
        const g = pageGeometry(p, ed.sourceInfos);
        const items: { str: string; x: number; y: number; w: number; h: number }[] = [];
        if (p.origin.kind === "source") {
          const rt = ed.sources[p.origin.sourceId];
          const page = await rt.pdf.getPage(p.origin.index + 1);
          const tc = await page.getTextContent();
          for (const it of tc.items) {
            if (!("str" in it) || !it.str) continue;
            const t = it.transform as number[];
            const fh = Math.hypot(t[2], t[3]) || it.height;
            items.push({ str: it.str, x: t[4] - g.viewBox[0], y: g.viewBox[3] - t[5] - fh * 0.85, w: it.width, h: fh * 1.1 });
          }
        }
        for (const l of ed.ocr[p.id] ?? []) items.push({ str: l.text, x: l.x, y: l.y, w: l.w, h: l.h });
        for (const o of ed.doc.objects) if (o.pageId === p.id && (o.kind === "text" || o.kind === "replace")) items.push({ str: o.text.replace(/\n/g, " "), x: o.x, y: o.y, w: o.w, h: o.h });
        for (const it of items) {
          const hay = caseSensitive ? it.str : it.str.toLocaleLowerCase();
          let from = 0;
          for (;;) {
            const k = hay.indexOf(needle, from);
            if (k < 0) break;
            const n = it.str.length || 1;
            hits.push({
              pageId: p.id,
              pageNumber: i + 1,
              rect: { x: it.x + (it.w * k) / n, y: it.y, w: Math.max((it.w * needle.length) / n, 2), h: it.h },
              snippet: it.str.length > 80 ? it.str.slice(Math.max(0, k - 30), k + needle.length + 30) : it.str,
            });
            from = k + Math.max(1, needle.length);
          }
        }
      }
    } finally {
      ed.setSearchHits(hits);
      ed.setActiveHit(hits.length ? 0 : -1);
      if (hits.length) ed.scrollToPage(hits[0].pageNumber - 1, hits[0].rect.y);
      setRunning(false);
      setDone(true);
    }
  };
  const go = (i: number) => {
    const h = ed.searchHits[i];
    if (!h) return;
    ed.setActiveHit(i);
    ed.scrollToPage(h.pageNumber - 1, h.rect.y);
  };
  return (
    <div className="flex h-full flex-col gap-2 p-2 text-sm">
      <form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex gap-1">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search text…"
          dir="auto"
          aria-label="Search text"
          className="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1"
          data-testid="search-input"
        />
        <button type="submit" className="rounded bg-accent px-2 text-white" aria-label="Run search" disabled={running}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </button>
      </form>
      <label className="flex items-center gap-1 text-xs text-muted">
        <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Match case
      </label>
      {done && (
        <div className="flex items-center justify-between text-xs text-muted" data-testid="search-count">
          <span>{ed.searchHits.length} result(s)</span>
          {ed.searchHits.length > 0 && (
            <span className="flex gap-1">
              <IconButton label="Previous result" onClick={() => go((ed.activeHit - 1 + ed.searchHits.length) % ed.searchHits.length)}><ArrowUp className="h-3.5 w-3.5" /></IconButton>
              <IconButton label="Next result" onClick={() => go((ed.activeHit + 1) % ed.searchHits.length)}><ArrowDown className="h-3.5 w-3.5" /></IconButton>
            </span>
          )}
        </div>
      )}
      <ul className="min-h-0 flex-1 overflow-auto">
        {ed.searchHits.map((h, i) => (
          <li key={i}>
            <button className={`w-full rounded px-2 py-1 text-left text-xs ${i === ed.activeHit ? "bg-accent-soft" : "hover:bg-panel-2"}`} onClick={() => go(i)} dir="auto">
              <span className="text-muted">p.{h.pageNumber} </span>
              {h.snippet}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[11px] leading-snug text-muted">
        Searches the document’s text layer, OCR results and added text. Scanned pages need OCR first. Arabic text extracted from some PDFs may be stored in visual order and not match.
      </p>
    </div>
  );
}

export function Sidebar({
  onImport,
  onSplit,
  onMerge,
  onPick,
  className = "",
}: {
  onImport: (at: number) => void;
  onSplit: () => void;
  onMerge: () => void;
  /** called after the user picks a page (used to close the drawer on small screens) */
  onPick?: () => void;
  className?: string;
}) {
  const ed = useEditor();
  const { doc, commit, selectedPages, setSelectedPages, currentPage, readOnly } = ed;
  const [tab, setTab] = useState<"pages" | "search">("pages");
  const dragIds = useRef<string[]>([]);
  const anchor = useRef<number>(0);
  const targetIds = selectedPages.length ? selectedPages : doc.pages[currentPage] ? [doc.pages[currentPage].id] : [];

  const click = (e: React.MouseEvent, i: number) => {
    const id = doc.pages[i].id;
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      setSelectedPages(doc.pages.slice(a, b + 1).map((p) => p.id));
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedPages(selectedPages.includes(id) ? selectedPages.filter((x) => x !== id) : [...selectedPages, id]);
      anchor.current = i;
    } else {
      setSelectedPages([id]);
      anchor.current = i;
    }
    ed.scrollToPage(i);
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) onPick?.();
  };

  const del = async () => {
    if (!targetIds.length) return;
    if (targetIds.length >= doc.pages.length) {
      ed.toast("error", "A PDF needs at least one page. Add a blank page first if you want to replace everything.");
      return;
    }
    const n = targetIds.length;
    const objs = doc.objects.filter((o) => targetIds.includes(o.pageId)).length;
    if (!(await ed.confirm({ title: `Delete ${n} page${n > 1 ? "s" : ""}?`, message: `${n} page(s)${objs ? ` and ${objs} added object(s)` : ""} will be removed. You can undo this.`, confirmLabel: "Delete", danger: true }))) return;
    commit(deletePages(doc, targetIds), `Delete ${n} page(s)`);
    setSelectedPages([]);
  };

  const move = (dir: -1 | 1) => {
    const idx = doc.pages.map((p, i) => (targetIds.includes(p.id) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    const to = dir < 0 ? Math.max(0, idx[0] - 1) : Math.min(doc.pages.length, idx[idx.length - 1] + 2);
    commit(movePages(doc, targetIds, to), "Move pages");
    ed.scrollToPage(Math.max(0, Math.min(doc.pages.length - 1, idx[0] + dir)));
  };

  // new pages go after the last selected page (or the current page)
  const anchorIndex = (() => {
    const idx = doc.pages.map((p, i) => (targetIds.includes(p.id) ? i : -1)).filter((i) => i >= 0);
    return idx.length ? idx[idx.length - 1] : currentPage;
  })();

  const addBlank = () => {
    const ref = doc.pages[anchorIndex];
    const g = ref ? pageGeometry(ref, ed.sourceInfos) : { width: 595.28, height: 841.89 };
    const r = insertBlankPage(doc, anchorIndex + 1, g.width, g.height);
    commit(r.doc, "Insert blank page");
    setSelectedPages([r.pageId]);
    ed.scrollToPage(anchorIndex + 1);
  };

  const dis = readOnly || !doc.pages.length;

  return (
    <aside className={`flex h-full w-[168px] shrink-0 flex-col border-r border-line bg-panel ${className}`} aria-label="Pages and search">
      <div className="flex border-b border-line text-xs" role="tablist">
        <button role="tab" aria-selected={tab === "pages"} className={`flex flex-1 items-center justify-center gap-1 py-2 ${tab === "pages" ? "border-b-2 border-accent font-semibold" : "text-muted"}`} onClick={() => setTab("pages")}>
          <LayoutGrid className="h-3.5 w-3.5" /> Pages
        </button>
        <button role="tab" aria-selected={tab === "search"} className={`flex flex-1 items-center justify-center gap-1 py-2 ${tab === "search" ? "border-b-2 border-accent font-semibold" : "text-muted"}`} onClick={() => setTab("search")} data-testid="tab-search">
          <Search className="h-3.5 w-3.5" /> Search
        </button>
      </div>
      {tab === "search" ? (
        <SearchPanel />
      ) : (
        <>
          <div className="grid grid-cols-5 gap-0.5 border-b border-line p-1" role="toolbar" aria-label="Page tools">
            <IconButton label="Insert blank page after the selected page" onClick={addBlank} disabled={dis} testId="page-add-blank"><SquarePlus className="h-4 w-4" /></IconButton>
            <IconButton label="Insert pages from PDF after the selected page" onClick={() => onImport(anchorIndex + 1)} disabled={dis} testId="page-import"><FilePlus2 className="h-4 w-4" /></IconButton>
            <IconButton label="Rotate left" onClick={() => commit(rotatePages(doc, targetIds, -90), "Rotate pages")} disabled={dis} testId="page-rotate-left"><RotateCcw className="h-4 w-4" /></IconButton>
            <IconButton label="Rotate right" onClick={() => commit(rotatePages(doc, targetIds, 90), "Rotate pages")} disabled={dis} testId="page-rotate-right"><RotateCw className="h-4 w-4" /></IconButton>
            <IconButton label="Duplicate page(s)" onClick={() => commit(duplicatePages(doc, targetIds), "Duplicate pages")} disabled={dis} testId="page-duplicate"><Copy className="h-4 w-4" /></IconButton>
            <IconButton label="Move up" onClick={() => move(-1)} disabled={dis} testId="page-move-up"><ArrowUp className="h-4 w-4" /></IconButton>
            <IconButton label="Move down" onClick={() => move(1)} disabled={dis} testId="page-move-down"><ArrowDown className="h-4 w-4" /></IconButton>
            <IconButton label="Delete page(s)" onClick={del} disabled={dis} testId="page-delete"><Trash2 className="h-4 w-4 text-danger" /></IconButton>
            <IconButton label="Export selected pages as PDF" onClick={() => ed.setExportRequest({ pageIds: doc.pages.filter((p) => targetIds.includes(p.id)).map((p) => p.id), label: "pages" })} disabled={dis} testId="page-extract"><FileOutput className="h-4 w-4" /></IconButton>
            <IconButton label="Split into page ranges" onClick={onSplit} disabled={dis} testId="page-split"><Scissors className="h-4 w-4" /></IconButton>
          </div>
          <div className="flex items-center justify-between px-2 py-1 text-[11px] text-muted">
            <span>{selectedPages.length ? `${selectedPages.length} selected` : `${doc.pages.length} pages`}</span>
            <button className="flex items-center gap-1 hover:text-fg disabled:opacity-40" onClick={onMerge} disabled={dis} title="Append other PDFs at the end" data-testid="merge-btn">
              <FileStack className="h-3.5 w-3.5" /> Merge
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-4" role="listbox" aria-multiselectable aria-label="Page thumbnails">
            {doc.pages.map((p, i) => (
              <Thumb
                key={p.id}
                page={p}
                index={i}
                active={i === currentPage}
                selected={selectedPages.includes(p.id)}
                onClick={(e) => click(e, i)}
                onDragStart={(e) => {
                  dragIds.current = selectedPages.includes(p.id) ? selectedPages : [p.id];
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", "pages");
                }}
                onDrop={(e, after) => {
                  e.preventDefault();
                  if (!dragIds.current.length || readOnly) return;
                  commit(movePages(doc, dragIds.current, after ? i + 1 : i), "Reorder pages");
                  dragIds.current = [];
                }}
              />
            ))}
            {!doc.pages.length && <div className="p-4 text-center text-xs text-muted"><Files className="mx-auto mb-2 h-6 w-6" />No document</div>}
          </div>
        </>
      )}
    </aside>
  );
}
