"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight, Circle, MoveHorizontal, PanelLeft, PanelRight, Download, FileText, FolderOpen, Highlighter, ImagePlus, Loader2, Minus, Moon, MousePointer2, PenLine, PenTool, Plus,
  Redo2, Replace, ShieldCheck, Signature, Square, Sun, TextCursor, TextSelect, Type, Undo2, X,
} from "lucide-react";
import { EditorProvider, useEditor, type Tool } from "./store";
import { Viewer } from "./Viewer";
import { Sidebar } from "./Sidebar";
import { PropertiesPanel } from "./PropertiesPanel";
import { ConfirmDialog, ExportDialog, MergeDialog, PasswordDialog, PrivacyDialog, SignatureDialog, SplitDialog, prepareImage } from "./dialogs";
import { IconButton } from "./ui";
import { addObject, deleteObjects, newId, updateObject } from "@/lib/model/ops";
import { pageGeometry, totalRotation, type EditorObject } from "@/lib/model/types";
import { validateImageFile } from "@/lib/files/validate";
import { revokeAssetUrls } from "./ObjectView";
import { ErrorBoundary } from "./ErrorBoundary";

const TOOLS: { id: Tool; label: string; icon: React.ReactNode; key?: string }[] = [
  { id: "select", label: "Select / move added objects (V)", icon: <MousePointer2 className="h-4 w-4" />, key: "v" },
  { id: "text-select", label: "Select & copy page text (S)", icon: <TextSelect className="h-4 w-4" />, key: "s" },
  { id: "edit-text", label: "Edit original text – native (E)", icon: <TextCursor className="h-4 w-4" />, key: "e" },
  { id: "replace", label: "Replace text visually (R)", icon: <Replace className="h-4 w-4" />, key: "r" },
  { id: "add-text", label: "Add text box (T)", icon: <Type className="h-4 w-4" />, key: "t" },
  { id: "draw", label: "Freehand drawing (D)", icon: <PenTool className="h-4 w-4" />, key: "d" },
  { id: "highlight", label: "Highlight area (H)", icon: <Highlighter className="h-4 w-4" />, key: "h" },
  { id: "rect", label: "Rectangle", icon: <Square className="h-4 w-4" /> },
  { id: "ellipse", label: "Ellipse", icon: <Circle className="h-4 w-4" /> },
  { id: "line", label: "Line", icon: <Minus className="h-4 w-4" /> },
  { id: "arrow", label: "Arrow", icon: <ArrowRight className="h-4 w-4" /> },
];

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** true when the media query matches (client-only component, so window exists) */
function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

function useTheme() {
  // the editor is client-only (no SSR), so browser APIs are available here
  const [dark, setDark] = useState(() => {
    try {
      const s = localStorage.getItem("pe-theme");
      return s ? s === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const toggle = () => {
    setDark((d) => {
      try {
        localStorage.setItem("pe-theme", d ? "light" : "dark");
      } catch {
        /* ignore */
      }
      return !d;
    });
  };
  return { dark, toggle };
}

function Shell() {
  const ed = useEditor();
  const { doc, tool, setTool, readOnly } = ed;
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const importAt = useRef(0);
  const imageRef = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<null | "split" | "merge" | "signature" | "privacy">(null);
  const [dragOver, setDragOver] = useState(false);
  const clipboard = useRef<EditorObject[]>([]);
  const theme = useTheme();
  const hasDoc = doc.pages.length > 0;
  // layout: ≥1024px both panels docked; 768–1023px pages docked, properties as a drawer;
  // <768px pages as a left drawer and properties as a bottom sheet
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isTablet = useMediaQuery("(min-width: 768px)");
  const [showPages, setShowPages] = useState(true);
  const [showProps, setShowProps] = useState(true);
  const [pagesOpen, setPagesOpen] = useState(false); // drawer (small screens)
  const [propsOpen, setPropsOpen] = useState(false); // drawer / sheet (small screens)
  const pagesDocked = isTablet && showPages;
  const propsDocked = isDesktop && showProps;
  const hasSelection = ed.selected.length > 0 || !!ed.nativeSel;

  const fitWidth = () => {
    const viewer = document.querySelector<HTMLElement>('[data-testid="viewer"]');
    const p = doc.pages[ed.currentPage];
    if (!viewer || !p) return;
    const g = pageGeometry(p, ed.sourceInfos);
    const r = totalRotation(p, ed.sourceInfos);
    const w = r === 90 || r === 270 ? g.height : g.width;
    const gutter = viewer.clientWidth < 640 ? 24 : 56;
    ed.setZoom(Math.max(0.25, Math.min(5, Math.floor(((viewer.clientWidth - gutter) / (w * (96 / 72))) * 100) / 100)));
  };

  // warn before leaving with unsaved edits
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (!ed.dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [ed.dirty]);

  const openPicked = async (files: FileList | File[] | null) => {
    const f = files ? Array.from(files) : [];
    if (!f.length) return;
    revokeAssetUrls();
    await ed.openFile(f[0]);
    if (f.length > 1) await ed.importPdfs(f.slice(1), Number.MAX_SAFE_INTEGER);
  };

  const addImage = async (file: File) => {
    const v = validateImageFile(file.name, file.type, file.size);
    if (!v.ok) return ed.toast("error", v.error);
    try {
      const img = await prepareImage(file, file.name);
      const id = ed.addAsset({ kind: "image", mime: img.mime, name: file.name, bytes: img.bytes, width: img.width, height: img.height });
      ed.setPendingImage(id);
      setTool("place-image");
      ed.toast("info", "Click on a page to place the image (or drag to size it).");
    } catch (e) {
      ed.toast("error", `Could not read the image: ${(e as Error).message}`);
    }
  };

  // keyboard shortcuts
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector("[role=dialog]")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); ed.undo(); return; }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); ed.redo(); return; }
      if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); fileRef.current?.click(); return; }
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (hasDoc && !readOnly) ed.setExportRequest({}); return; }
      if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); ed.setZoom((z) => Math.min(5, z * 1.2)); return; }
      if (mod && e.key === "-") { e.preventDefault(); ed.setZoom((z) => Math.max(0.25, z / 1.2)); return; }
      if (mod && e.key === "0") { e.preventDefault(); ed.setZoom(1); return; }
      const sel = doc.objects.filter((o) => ed.selected.includes(o.id));
      if (mod && e.key.toLowerCase() === "c" && sel.length && tool === "select") { clipboard.current = sel; return; }
      if (mod && e.key.toLowerCase() === "v" && clipboard.current.length && !readOnly) {
        e.preventDefault();
        const page = doc.pages[ed.currentPage];
        if (!page) return;
        let d = doc;
        const ids: string[] = [];
        for (const o of clipboard.current) {
          const c = { ...o, id: newId("obj"), pageId: page.id, x: o.x + (o.pageId === page.id ? 10 : 0), y: o.y + (o.pageId === page.id ? 10 : 0) } as EditorObject;
          d = addObject(d, c);
          ids.push(c.id);
        }
        ed.commit(d, "Paste");
        ed.setSelected(ids);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && sel.length) {
        e.preventDefault();
        ed.commit(deleteObjects(doc, sel.map((o) => o.id)), "Delete");
        ed.setSelected([]);
        return;
      }
      if (e.key.startsWith("Arrow") && sel.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        let d = doc;
        for (const o of sel) d = updateObject(d, o.id, { x: o.x + dx, y: o.y + dy });
        ed.commit(d, "Nudge", `nudge:${sel.map((o) => o.id).join()}`);
        return;
      }
      if (e.key === "Escape") {
        ed.setSelected([]);
        ed.setNativeSel(null);
        if (tool !== "select") setTool("select");
        return;
      }
      if (e.key === "PageDown") { ed.scrollToPage(Math.min(doc.pages.length - 1, ed.currentPage + 1)); return; }
      if (e.key === "PageUp") { ed.scrollToPage(Math.max(0, ed.currentPage - 1)); return; }
      if (!mod && !e.altKey) {
        const t2 = TOOLS.find((x) => x.key === e.key.toLowerCase());
        if (t2 && hasDoc) setTool(t2.id);
      }
    },
    [ed, doc, tool, setTool, hasDoc, readOnly],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  // small screens: open the properties sheet when a line is picked for native editing
  const [prevNativeSel, setPrevNativeSel] = useState(ed.nativeSel);
  if (prevNativeSel !== ed.nativeSel) {
    setPrevNativeSel(ed.nativeSel);
    if (ed.nativeSel && !propsDocked) setPropsOpen(true);
  }

  // small screens: fit the page width when a document is opened
  useEffect(() => {
    if (!ed.primaryId || isDesktop) return;
    const t = setTimeout(fitWidth, 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed.primaryId]);

  useEffect(() => {
    if (tool !== "edit-text") ed.setNativeSel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  const sidebar = (onPick: (() => void) | undefined, className: string) => (
    <Sidebar
      onImport={(at) => { importAt.current = at; importRef.current?.click(); }}
      onSplit={() => setDialog("split")}
      onMerge={() => setDialog("merge")}
      onPick={onPick}
      className={className}
    />
  );

  return (
    <div
      className="flex h-[100dvh] flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        openPicked(e.dataTransfer.files);
      }}
    >
      {/* top toolbar */}
      <header className="flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-panel px-2" role="toolbar" aria-label="Main toolbar">
        {hasDoc && (
          <IconButton
            label={pagesDocked || pagesOpen ? "Hide pages panel" : "Show pages panel"}
            active={isTablet ? showPages : pagesOpen}
            onClick={() => (isTablet ? setShowPages((v) => !v) : setPagesOpen((v) => !v))}
            testId="toggle-pages"
          >
            <PanelLeft className="h-4 w-4" />
          </IconButton>
        )}
        <div className="mr-2 hidden shrink-0 items-center gap-1.5 pl-1 font-semibold sm:flex"><FileText className="h-5 w-5 text-accent" /> <span className="hidden text-sm md:inline">PDF Editor</span></div>
        <button type="button" onClick={() => fileRef.current?.click()} title="Open PDF" aria-label="Open PDF" className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 text-sm font-medium text-white hover:brightness-110 sm:px-3" data-testid="open-btn">
          <FolderOpen className="h-4 w-4" /> <span className="hidden sm:inline">Open PDF</span>
        </button>
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden multiple data-testid="file-input" onChange={(e) => { openPicked(e.target.files); e.target.value = ""; }} />
        <input ref={importRef} type="file" accept="application/pdf,.pdf" hidden multiple data-testid="import-input" onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ""; if (f.length) ed.importPdfs(f, importAt.current); }} />
        <input ref={imageRef} type="file" accept="image/*" hidden data-testid="image-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) addImage(f); }} />
        <button type="button" disabled={!hasDoc || readOnly} onClick={() => ed.setExportRequest({})} title="Download PDF" aria-label="Download PDF" className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm font-medium hover:bg-panel-2 disabled:opacity-40 sm:px-3" data-testid="download-btn">
          <Download className="h-4 w-4" /> <span className="hidden sm:inline">Download</span>
        </button>
        <div className="mx-1 hidden h-6 w-px shrink-0 bg-line sm:block" />
        <IconButton label="Undo (Ctrl+Z)" onClick={ed.undo} disabled={!ed.hist.past.length} testId="undo"><Undo2 className="h-4 w-4" /></IconButton>
        <IconButton label="Redo (Ctrl+Y)" onClick={ed.redo} disabled={!ed.hist.future.length} testId="redo"><Redo2 className="h-4 w-4" /></IconButton>
        <div className="mx-1 hidden h-6 w-px shrink-0 bg-line sm:block" />
        <IconButton label="Zoom out" onClick={() => ed.setZoom((z) => Math.max(0.25, Math.round((z / 1.2) * 100) / 100))} disabled={!hasDoc}><Minus className="h-4 w-4" /></IconButton>
        <select aria-label="Zoom" className="hidden h-8 shrink-0 rounded-md border border-line bg-panel px-1 text-sm sm:block" value={ZOOMS.includes(ed.zoom) ? ed.zoom : "custom"} onChange={(e) => ed.setZoom(Number(e.target.value))} disabled={!hasDoc} data-testid="zoom-select">
          {!ZOOMS.includes(ed.zoom) && <option value="custom">{Math.round(ed.zoom * 100)}%</option>}
          {ZOOMS.map((z) => <option key={z} value={z}>{z * 100}%</option>)}
        </select>
        <IconButton label="Zoom in" onClick={() => ed.setZoom((z) => Math.min(5, Math.round(z * 1.2 * 100) / 100))} disabled={!hasDoc}><Plus className="h-4 w-4" /></IconButton>
        <IconButton label="Fit page width" onClick={fitWidth} disabled={!hasDoc} testId="zoom-fit"><MoveHorizontal className="h-4 w-4" /></IconButton>
        <div className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted sm:gap-2">
          {hasDoc && (
            <span className="hidden max-w-[260px] truncate lg:inline" title={ed.fileName} data-testid="doc-status">
              {ed.fileName} {readOnly ? "· view only" : ed.dirty ? "· unsaved changes" : "· no unsaved changes"}
            </span>
          )}
          <IconButton label="Privacy & help" onClick={() => setDialog("privacy")} className="hidden sm:grid"><ShieldCheck className="h-4 w-4 text-emerald-600" /></IconButton>
          <IconButton label={theme.dark ? "Light theme" : "Dark theme"} onClick={theme.toggle}>{theme.dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</IconButton>
          {hasDoc && (
            <IconButton
              label={propsDocked || propsOpen ? "Hide properties panel" : "Show properties panel"}
              active={isDesktop ? showProps : propsOpen}
              onClick={() => (isDesktop ? setShowProps((v) => !v) : setPropsOpen((v) => !v))}
              testId="toggle-props"
              className="relative"
            >
              <PanelRight className="h-4 w-4" />
              {!propsDocked && !propsOpen && hasSelection && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent" />}
            </IconButton>
          )}
        </div>
      </header>

      {/* contextual editing toolbar */}
      {hasDoc && (
        <div className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-panel px-2" role="toolbar" aria-label="Editing tools">
          {TOOLS.slice(0, 4).map((t) => (
            <IconButton key={t.id} label={t.label} active={tool === t.id} onClick={() => setTool(t.id)} disabled={readOnly && t.id !== "select" && t.id !== "text-select"} testId={`tool-${t.id}`}>{t.icon}</IconButton>
          ))}
          <div className="mx-1 h-6 w-px bg-line" />
          {TOOLS.slice(4).map((t) => (
            <IconButton key={t.id} label={t.label} active={tool === t.id} onClick={() => setTool(t.id)} disabled={readOnly} testId={`tool-${t.id}`}>{t.icon}</IconButton>
          ))}
          <div className="mx-1 h-6 w-px bg-line" />
          <IconButton label="Add image" onClick={() => imageRef.current?.click()} disabled={readOnly} active={tool === "place-image" && !ed.assets[ed.pendingImage ?? ""]?.name.startsWith("signature")} testId="tool-image"><ImagePlus className="h-4 w-4" /></IconButton>
          <IconButton label="Add signature" onClick={() => setDialog("signature")} disabled={readOnly} testId="tool-signature"><Signature className="h-4 w-4" /></IconButton>
          {tool === "place-image" && (
            <button className="ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-accent-soft px-2 py-1 text-xs text-accent" onClick={() => { ed.setPendingImage(null); setTool("select"); }}>
              <PenLine className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Click on a page to place ·</span> cancel <X className="h-3 w-3" />
            </button>
          )}
          {readOnly && <span className="ml-2 shrink-0 whitespace-nowrap rounded bg-warn-bg px-2 py-1 text-xs text-warn-text">View only – this PDF is encrypted</span>}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {hasDoc && pagesDocked && sidebar(undefined, "")}
        <main className="min-w-0 flex-1" aria-label="Document">
          {hasDoc ? <Viewer /> : <Welcome onOpen={() => fileRef.current?.click()} onPrivacy={() => setDialog("privacy")} />}
        </main>
        {hasDoc && propsDocked && <PropertiesPanel />}

        {/* small screens: pages drawer */}
        {hasDoc && !isTablet && pagesOpen && (
          <div className="absolute inset-0 z-30 flex" role="dialog" aria-label="Pages">
            <div className="pe-drawer-left h-full shadow-2xl">{sidebar(() => setPagesOpen(false), "w-[min(240px,80vw)]")}</div>
            <button type="button" aria-label="Close pages panel" className="flex-1 bg-black/30" onClick={() => setPagesOpen(false)} />
          </div>
        )}
        {/* small screens: properties drawer (tablet) or bottom sheet (phone) */}
        {hasDoc && !propsDocked && propsOpen && (
          <div className={`absolute inset-0 z-30 flex ${isTablet ? "flex-row" : "flex-col"}`} role="dialog" aria-label="Properties">
            <button type="button" aria-label="Close properties" className="flex-1 bg-black/30" onClick={() => setPropsOpen(false)} />
            <div className={isTablet ? "pe-drawer-right h-full shadow-2xl" : "pe-drawer-bottom h-[65%] overflow-hidden rounded-t-2xl shadow-2xl"}>
              <PropertiesPanel onClose={() => setPropsOpen(false)} className={isTablet ? "w-[320px]" : "w-full border-l-0"} />
            </div>
          </div>
        )}
      </div>

      {/* status bar */}
      <footer className="flex h-7 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-line bg-panel px-3 text-[11px] text-muted" data-testid="status-bar">
        {hasDoc ? (
          <>
            <span data-testid="status-page">Page {ed.currentPage + 1} of {doc.pages.length}</span>
            <span className="hidden sm:inline">Zoom {Math.round(ed.zoom * 100)}%</span>
            <span className="hidden truncate md:inline">{ed.hist.label ? `Last change: ${ed.hist.label}` : "No changes"}</span>
          </>
        ) : (
          <span>No document open</span>
        )}
        <span className="ml-auto flex min-w-0 items-center gap-1 truncate">
          {ed.busy ? <><Loader2 className="h-3 w-3 shrink-0 animate-spin" /> <span className="truncate">{ed.busy.message}</span></> : <><span className="sm:hidden">Ready · local only</span><span className="hidden sm:inline">Ready · files are processed locally in this browser</span></>}
        </span>
      </footer>

      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-accent/15 backdrop-blur-[1px]">
          <div className="rounded-xl border-2 border-dashed border-accent bg-panel px-8 py-6 text-lg font-medium">Drop a PDF to open it</div>
        </div>
      )}

      {ed.busy && (ed.busy.cancel || ed.busy.progress !== undefined) && (
        <div className="fixed bottom-10 left-1/2 z-40 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-panel px-4 py-2 text-sm shadow-lg" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{ed.busy.message}</span>
          {ed.busy.progress !== undefined && <span className="tabular-nums text-muted">{Math.round(ed.busy.progress * 100)}%</span>}
          {ed.busy.cancel && <button className="rounded border border-line px-2 py-0.5 text-xs hover:bg-panel-2" onClick={ed.busy.cancel}>Cancel</button>}
        </div>
      )}

      <div className="fixed right-3 top-14 z-50 flex w-[min(340px,calc(100vw-24px))] flex-col gap-2" aria-live="polite">
        {ed.toasts.map((t) => (
          <div key={t.id} role={t.kind === "error" ? "alert" : "status"} data-testid={`toast-${t.kind}`}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${t.kind === "error" ? "border-danger/40 bg-panel text-danger" : t.kind === "warn" ? "border-amber-400/50 bg-warn-bg text-warn-text" : t.kind === "success" ? "border-emerald-500/40 bg-panel text-emerald-700 dark:text-emerald-300" : "border-line bg-panel"}`}>
            <span className="flex-1">{t.text}</span>
            <button aria-label="Dismiss" onClick={() => ed.dismissToast(t.id)}><X className="h-3.5 w-3.5" /></button>
          </div>
        ))}
      </div>

      <ConfirmDialog />
      <PasswordDialog />
      {ed.exportRequest && <ExportDialog />}
      {dialog === "split" && <SplitDialog onClose={() => setDialog(null)} />}
      {dialog === "merge" && <MergeDialog onClose={() => setDialog(null)} />}
      {dialog === "signature" && <SignatureDialog onClose={() => setDialog(null)} />}
      {dialog === "privacy" && <PrivacyDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function Welcome({ onOpen, onPrivacy }: { onOpen: () => void; onPrivacy: () => void }) {
  const ed = useEditor();
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="w-full max-w-xl rounded-2xl border-2 border-dashed border-line bg-panel p-6 text-center sm:p-10">
        <FileText className="mx-auto mb-3 h-12 w-12 text-accent" />
        <h1 className="mb-1 text-xl font-semibold">Open a PDF to start editing</h1>
        <p className="mb-5 text-sm text-muted">Drag and drop a file here, or choose one from your computer.</p>
        <button onClick={onOpen} className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 font-medium text-white hover:brightness-110" disabled={!!ed.busy}>
          {ed.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />} Choose PDF
        </button>
        <p className="mt-6 flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted">
          <ShieldCheck className="h-4 w-4 text-emerald-600" /> Files are processed locally in your browser and never uploaded.
          <button className="underline" onClick={onPrivacy}>Details</button>
        </p>
      </div>
    </div>
  );
}

export default function Editor() {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div className="grid h-[100dvh] place-items-center p-6">
          <div className="max-w-md rounded-xl border border-line bg-panel p-6 text-sm">
            <h1 className="mb-2 text-base font-semibold">Something went wrong</h1>
            <p className="mb-3 text-muted">{error.message}</p>
            <button className="rounded-md bg-accent px-3 py-1.5 text-white" onClick={reset}>Try again</button>
          </div>
        </div>
      )}
    >
      <EditorProvider>
        <Shell />
      </EditorProvider>
    </ErrorBoundary>
  );
}
