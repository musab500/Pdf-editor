"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { Asset, EditorDoc, SourceInfo, TextStyle } from "@/lib/model/types";
import { historyReducer, initialHistory, isDirty, type HistoryState } from "@/lib/model/history";
import { insertSourcePages, newId } from "@/lib/model/ops";
import { WARN_PAGE_COUNT, validatePdfFile } from "@/lib/files/validate";
import { PasswordRequiredError, destroyPdf, openWithPdfjs } from "@/lib/pdf/pdfjs";
import { textFound } from "@/lib/pdf/verify";
import { SourceRuntime, openSource } from "./sources";
import { browserFaceRegistry } from "@/lib/export/faces";
import type { FaceRegistry } from "@/lib/text/fontFaces";

export type Tool =
  | "select"
  | "text-select"
  | "edit-text"
  | "replace"
  | "add-text"
  | "draw"
  | "highlight"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "place-image";

export interface Toast {
  id: string;
  kind: "info" | "error" | "success" | "warn";
  text: string;
}

export interface Busy {
  message: string;
  progress?: number;
  cancel?: () => void;
}

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export interface NativeSelection {
  pageId: string;
  sourceId: string;
  pageIndex: number;
  lineId: string;
}

export interface SearchHit {
  pageId: string;
  pageNumber: number;
  rect: { x: number; y: number; w: number; h: number };
  snippet: string;
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

export interface DrawStyle {
  color: string;
  width: number;
  highlight: string;
  shapeStroke: string;
  shapeFill: string | null;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}
interface PendingPassword {
  fileName: string;
  incorrect: boolean;
  resolve: (pw: string | null) => void;
}

const DEFAULT_STYLE: TextStyle = {
  family: "helvetica",
  size: 14,
  color: "#111111",
  bold: false,
  italic: false,
  align: "start",
  dir: "auto",
  lineHeight: 1.25,
};

function useStoreValue() {
  const [hist, dispatch] = useReducer(historyReducer, undefined, initialHistory);
  const doc = hist.present;
  const sourcesRef = useRef<Record<string, SourceRuntime>>({});
  const [sourcesVersion, setSourcesVersion] = useState(0);
  const bumpSources = useCallback(() => setSourcesVersion((v) => v + 1), []);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [fileName, setFileName] = useState("document.pdf");
  const assetsRef = useRef<Record<string, Asset>>({});
  const [assetsVersion, setAssetsVersion] = useState(0);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedPages, setSelectedPages] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [nativeSel, setNativeSel] = useState<NativeSelection | null>(null);
  const [ocr, setOcr] = useState<Record<string, OcrLine[]>>({});
  const [textStyle, setTextStyle] = useState<TextStyle>(DEFAULT_STYLE);
  const [drawStyle, setDrawStyle] = useState<DrawStyle>({ color: "#1f3fbf", width: 2, highlight: "#ffe14d", shapeStroke: "#d22d2d", shapeFill: null });
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [activeHit, setActiveHit] = useState(-1);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [pendingPassword, setPendingPassword] = useState<PendingPassword | null>(null);
  const [exportRequest, setExportRequest] = useState<{ pageIds?: string[]; label?: string } | null>(null);
  const [scrollRequest, setScrollRequest] = useState<{ index: number; seq: number; y?: number } | null>(null);
  const facesRef = useRef<FaceRegistry | null>(null);
  if (!facesRef.current) facesRef.current = browserFaceRegistry(() => assetsRef.current);

  const sources = sourcesRef.current;
  const sourceInfos = useMemo(() => {
    const m: Record<string, SourceInfo> = {};
    for (const [k, v] of Object.entries(sourcesRef.current)) m[k] = v.info;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesVersion]);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = newId("toast");
    setToasts((t) => [...t.slice(-4), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" || kind === "warn" ? 9000 : 4500);
  }, []);
  const dismissToast = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const commit = useCallback((next: EditorDoc, label: string, key?: string) => dispatch({ type: "commit", doc: next, label, key }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);

  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setPendingConfirm({ ...o, resolve })), []);
  const askPassword = useCallback(
    (fileName: string, incorrect: boolean) => new Promise<string | null>((resolve) => setPendingPassword({ fileName, incorrect, resolve })),
    [],
  );

  const addAsset = useCallback((a: Omit<Asset, "id">) => {
    const id = newId("asset");
    assetsRef.current = { ...assetsRef.current, [id]: { ...a, id } };
    setAssetsVersion((v) => v + 1);
    return id;
  }, []);

  /** Read, validate and open one PDF file. Asks for a password if needed. */
  const loadSource = useCallback(
    async (file: File): Promise<SourceRuntime | null> => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const v = validatePdfFile(file.name, file.type, bytes);
      if (!v.ok) {
        toast("error", v.error);
        return null;
      }
      if (v.warning) toast("warn", v.warning);
      let password: string | undefined;
      for (;;) {
        try {
          const rt = await openSource(newId("src"), file.name, bytes, password);
          if (rt.info.pageCount === 0) {
            toast("error", `“${file.name}” has no pages.`);
            await rt.destroy();
            return null;
          }
          return rt;
        } catch (e) {
          if (e instanceof PasswordRequiredError) {
            const pw = await askPassword(file.name, e.incorrect);
            if (pw === null) return null;
            password = pw;
            continue;
          }
          toast("error", `Could not open “${file.name}”: ${(e as Error).message}`);
          return null;
        }
      }
    },
    [toast, askPassword],
  );

  const openFile = useCallback(
    async (file: File) => {
      if (isDirty(hist) && !(await confirm({ title: "Discard unsaved changes?", message: "Opening another PDF replaces the current document. Your edits have not been downloaded.", confirmLabel: "Discard and open", danger: true })))
        return;
      setBusy({ message: `Opening ${file.name}…` });
      try {
        const rt = await loadSource(file);
        if (!rt) return;
        for (const s of Object.values(sourcesRef.current)) await s.destroy().catch(() => {});
        sourcesRef.current = { [rt.info.id]: rt };
        assetsRef.current = Object.fromEntries(Object.entries(assetsRef.current).filter(([, a]) => a.kind === "font"));
        setPrimaryId(rt.info.id);
        setFileName(file.name);
        const { doc: d } = insertSourcePages({ pages: [], objects: [], nativeEdits: {}, formValues: {} }, rt.info.id, Array.from({ length: rt.info.pageCount }, (_, i) => i), 0);
        dispatch({ type: "reset", doc: d });
        setSelected([]);
        setSelectedPages([]);
        setCurrentPage(0);
        setNativeSel(null);
        setOcr({});
        setSearchHits([]);
        setActiveHit(-1);
        setTool("select");
        bumpSources();
        if (rt.info.readOnlyReason) toast("warn", rt.info.readOnlyReason);
        if (rt.info.pageCount > WARN_PAGE_COUNT) toast("warn", `This document has ${rt.info.pageCount} pages; some operations may be slow.`);
      } finally {
        setBusy(null);
      }
    },
    [hist, confirm, loadSource, bumpSources, toast],
  );

  /** Insert all pages of the given PDFs at `at` (merge = at end). */
  const importPdfs = useCallback(
    async (files: File[], at: number) => {
      let d = doc;
      let insertAt = at;
      let count = 0;
      setBusy({ message: "Importing pages…" });
      try {
        for (const f of files) {
          const rt = await loadSource(f);
          if (!rt) continue;
          if (rt.info.readOnlyReason) {
            toast("error", `“${f.name}” is encrypted and cannot be merged.`);
            await rt.destroy();
            continue;
          }
          sourcesRef.current = { ...sourcesRef.current, [rt.info.id]: rt };
          const r = insertSourcePages(d, rt.info.id, Array.from({ length: rt.info.pageCount }, (_, i) => i), insertAt);
          d = r.doc;
          insertAt += rt.info.pageCount;
          count += rt.info.pageCount;
        }
        if (count) {
          bumpSources();
          commit(d, `Import ${count} page(s)`);
          toast("success", `Inserted ${count} page(s).`);
        }
      } finally {
        setBusy(null);
      }
    },
    [doc, loadSource, bumpSources, commit, toast],
  );

  // ------------------------------------------------------------ native edit rendering
  const editsKeys = useMemo(() => {
    const m: Record<string, string> = {};
    for (const id of Object.keys(sourcesRef.current)) m[id] = JSON.stringify(doc.nativeEdits[id] ?? {});
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.nativeEdits, sourcesVersion]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const [id, key] of Object.entries(editsKeys)) {
        const rt = sourcesRef.current[id];
        if (!rt || rt.renderedEditsKey === key || (key === "{}" && rt.pdf === rt.basePdf)) continue;
        if (key === "{}") {
          await rt.setRenderPdf(rt.basePdf, key);
        } else {
          const { bytes } = await rt.buildPatched(doc.nativeEdits[id]);
          if (cancelled) return;
          await rt.setRenderPdf(await openWithPdfjs(bytes), key);
        }
        if (!cancelled) bumpSources();
      }
    })().catch((e) => toast("error", `Could not refresh the page view: ${(e as Error).message}`));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editsKeys]);

  /**
   * Apply a native (Mode A) edit: rebuild the source with the edit, verify via
   * PDF.js that the new text is present, and only then commit it.
   */
  const applyNativeEdit = useCallback(
    async (sel: NativeSelection, newText: string, original: string): Promise<boolean> => {
      const rt = sourcesRef.current[sel.sourceId];
      if (!rt) return false;
      setBusy({ message: "Rewriting the original text…" });
      try {
        const { setNativeEdit } = await import("@/lib/model/ops");
        const candidate = setNativeEdit(doc, sel.sourceId, sel.pageIndex, sel.lineId, newText, original);
        const { bytes, results } = await rt.buildPatched(candidate.nativeEdits[sel.sourceId]);
        const mine = results.find((r) => r.pageIndex === sel.pageIndex && r.lineId === sel.lineId);
        if (newText !== original && (!mine || !mine.ok)) {
          toast("error", `Native edit not applied: ${mine?.reasons.join(" ") ?? "the text could not be located."} Use visual replacement instead.`);
          return false;
        }
        const pdf = await openWithPdfjs(bytes);
        if (newText.trim()) {
          const page = await pdf.getPage(sel.pageIndex + 1);
          const content = await page.getTextContent();
          const text = content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
          if (!textFound(newText, text)) {
            await destroyPdf(pdf);
            toast("error", "Verification failed: the new text could not be read back from the rewritten page, so the edit was not applied. Use visual replacement instead.");
            return false;
          }
        }
        await rt.setRenderPdf(pdf, JSON.stringify(candidate.nativeEdits[sel.sourceId] ?? {}));
        commit(candidate, "Edit original text");
        bumpSources();
        toast("success", "Original text rewritten and verified.");
        return true;
      } catch (e) {
        toast("error", `Native edit failed: ${(e as Error).message}`);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [doc, commit, bumpSources, toast],
  );

  const readOnly = !!(primaryId && sourcesRef.current[primaryId]?.info.readOnlyReason);

  const scrollToPage = useCallback((index: number, y?: number) => {
    setScrollRequest((r) => ({ index, y, seq: (r?.seq ?? 0) + 1 }));
    setCurrentPage(index);
  }, []);

  return {
    hist,
    doc,
    dispatch,
    commit,
    undo,
    redo,
    dirty: isDirty(hist),
    sources,
    sourceInfos,
    sourcesVersion,
    bumpSources,
    primaryId,
    fileName,
    setFileName,
    assets: assetsRef.current,
    assetsVersion,
    addAsset,
    tool,
    setTool,
    selected,
    setSelected,
    selectedPages,
    setSelectedPages,
    currentPage,
    setCurrentPage,
    scrollToPage,
    scrollRequest,
    zoom,
    setZoom,
    toasts,
    toast,
    dismissToast,
    busy,
    setBusy,
    openFile,
    importPdfs,
    loadSource,
    readOnly,
    nativeSel,
    setNativeSel,
    applyNativeEdit,
    ocr,
    setOcr,
    textStyle,
    setTextStyle,
    drawStyle,
    setDrawStyle,
    pendingImage,
    setPendingImage,
    searchHits,
    setSearchHits,
    activeHit,
    setActiveHit,
    confirm,
    pendingConfirm,
    setPendingConfirm,
    pendingPassword,
    setPendingPassword,
    exportRequest,
    setExportRequest,
    faces: facesRef.current,
  };
}

export type EditorStore = ReturnType<typeof useStoreValue>;
const Ctx = createContext<EditorStore | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const v = useStoreValue();
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useEditor(): EditorStore {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEditor outside EditorProvider");
  return v;
}

export type { HistoryState };
