"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { EditorObject, ImageObj, InkObj, LineObj, PageEntry, ReplaceObj, ShapeObj, HighlightObj, TextObj } from "@/lib/model/types";
import { pageGeometry, totalRotation } from "@/lib/model/types";
import { addObject, deleteObjects, newId, setFormValue, updateObject } from "@/lib/model/ops";
import { REPLACE_PADDING, TEXT_PADDING } from "@/lib/pdf/exporter";
import type { PageTextAnalysis, TextLine } from "@/lib/pdf/textAnalysis";
import { useEditor } from "./store";
import { PageCanvas, type PageCanvasHandle } from "./PageCanvas";
import { ObjectBody } from "./ObjectView";
import { clientToPage, rectFrom, resizeBox, rotCW, uprightBox, type PageFrame } from "./geometry";
import { TextSelectLayer } from "./TextSelectLayer";
import { FormLayer } from "./FormLayer";
import { ErrorBoundary } from "./ErrorBoundary";
import { pageTextItems, type TextItemBox } from "@/lib/pdf/pdfjs";

const CREATE_TOOLS = new Set(["add-text", "draw", "highlight", "rect", "ellipse", "line", "arrow", "place-image", "replace"]);

const toHex = (rgb: [number, number, number]) =>
  "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");

function guessFamily(line: TextLine): TextObj["family"] {
  const f = (line.font?.family ?? "").toLowerCase();
  if (line.rtl) return /sans|tahoma|arial|segoe|helvet/.test(f) ? "noto-sans-arabic" : "noto-naskh-arabic";
  if (/courier|mono|consol/.test(f)) return "courier";
  if (/times|serif|georgia|garamond|cambria|book|minion/.test(f) && !/sans/.test(f)) return "times";
  return "helvetica";
}

interface DragState {
  kind: "move" | "resize" | "create" | "ink";
  id?: string;
  sx?: number;
  sy?: number;
  start: { x: number; y: number };
  cur: { x: number; y: number };
  orig?: EditorObject;
  points?: [number, number][];
  moved: boolean;
}

export const PageView = memo(function PageView({ page, index, scale, visible }: { page: PageEntry; index: number; scale: number; visible: boolean }) {
  const ed = useEditor();
  const { doc, sources, sourceInfos, tool, selected, setSelected, commit, faces, toast } = ed;
  const geo = pageGeometry(page, sourceInfos);
  const rot = totalRotation(page, sourceInfos);
  const W = geo.width * scale;
  const H = geo.height * scale;
  const swap = rot === 90 || rot === 270;
  const outerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<PageCanvasHandle>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PageTextAnalysis | null>(null);
  const [hoverLine, setHoverLine] = useState<string | null>(null);
  const [selMenu, setSelMenu] = useState<{ rects: { x: number; y: number; w: number; h: number }[]; left: number; top: number; text: string } | null>(null);
  const rt = page.origin.kind === "source" ? sources[page.origin.sourceId] : undefined;
  const srcIndex = page.origin.kind === "source" ? page.origin.index : -1;
  const isPrimaryPage = page.origin.kind === "source" && page.origin.sourceId === ed.primaryId;
  const editable = !ed.readOnly && (!rt || rt.editable);
  const objects = useMemo(() => doc.objects.filter((o) => o.pageId === page.id), [doc.objects, page.id]);

  useEffect(() => {
    if (tool !== "text-select") setSelMenu(null);
  }, [tool]);

  const frame = useCallback((): PageFrame => ({ el: outerRef.current!, w: geo.width, h: geo.height, scale, rot }), [geo.width, geo.height, scale, rot]);
  const toPage = useCallback((e: { clientX: number; clientY: number }) => clientToPage(frame(), e.clientX, e.clientY), [frame]);

  // text analysis of the original page (for native editing and replacement targets)
  const needAnalysis = visible && rt && editable && (tool === "edit-text" || tool === "replace");
  useEffect(() => {
    if (!needAnalysis || !rt || analysis) return;
    let alive = true;
    rt.analysis(srcIndex)
      .then((a) => alive && setAnalysis(a))
      .catch((e) => toast("error", `Text analysis failed: ${(e as Error).message}`));
    return () => {
      alive = false;
    };
  }, [needAnalysis, rt, srcIndex, analysis, toast]);

  const vb = geo.viewBox;
  const lineRect = (l: { bbox: { x0: number; y0: number; x1: number; y1: number } }) => ({
    x: l.bbox.x0 - vb[0],
    y: vb[3] - l.bbox.y1,
    w: l.bbox.x1 - l.bbox.x0,
    h: l.bbox.y1 - l.bbox.y0,
  });

  /** median colour around a rectangle on the rendered page (used to cover original text) */
  const sampleCover = useCallback(
    (r: { x: number; y: number; w: number; h: number }): string => {
      const c = canvasRef.current?.canvas;
      const ppp = canvasRef.current?.pixelsPerPoint ?? 0;
      if (!c || !ppp) return "#ffffff";
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return "#ffffff";
      const pts: [number, number][] = [];
      const m = 1.5;
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        pts.push([r.x - m + t * (r.w + 2 * m), r.y - m], [r.x - m + t * (r.w + 2 * m), r.y + r.h + m]);
        pts.push([r.x - m, r.y - m + t * (r.h + 2 * m)], [r.x + r.w + m, r.y - m + t * (r.h + 2 * m)]);
      }
      const rs: number[] = [], gs: number[] = [], bs: number[] = [];
      for (const [x, y] of pts) {
        const px = Math.round(x * ppp), py = Math.round(y * ppp);
        if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue;
        const d = ctx.getImageData(px, py, 1, 1).data;
        rs.push(d[0]); gs.push(d[1]); bs.push(d[2]);
      }
      if (!rs.length) return "#ffffff";
      const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)] / 255;
      return toHex([med(rs), med(gs), med(bs)]);
    },
    [],
  );

  // ------------------------------------------------------------ object helpers
  const style = ed.textStyle;
  const createReplace = (r: { x: number; y: number; w: number; h: number }, fromLine?: TextLine, text = "") => {
    const cover = sampleCover(r);
    const pad = REPLACE_PADDING;
    const box = uprightBox({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }, rot);
    const obj: ReplaceObj = {
      id: newId("obj"),
      kind: "replace",
      pageId: page.id,
      ...box,
      text: fromLine ? fromLine.displayText : text,
      originalText: fromLine?.displayText ?? (text || undefined),
      cover,
      family: fromLine ? guessFamily(fromLine) : style.family,
      size: fromLine ? Math.round(fromLine.userFontSize * 10) / 10 : Math.max(6, Math.min(r.h * 0.75, 36)),
      color: fromLine ? toHex(fromLine.fill) : style.color,
      bold: fromLine?.font?.bold ?? false,
      italic: fromLine?.font?.italic ?? false,
      align: fromLine ? (fromLine.rtl ? "right" : "left") : "start",
      dir: fromLine ? (fromLine.rtl ? "rtl" : "auto") : "auto",
      lineHeight: 1.15,
    };
    commit(addObject(doc, obj), "Visual replacement");
    setSelected([obj.id]);
    setEditingId(obj.id);
  };

  /** an upright box (as seen on screen) of visual size vw × vh centred at c (page space) */
  const visualBox = (c: { x: number; y: number }, vw: number, vh: number) => ({ x: c.x - vw / 2, y: c.y - vh / 2, w: vw, h: vh, rotation: (360 - rot) % 360 });

  const finishCreate = (d: DragState) => {
    const r = rectFrom(d.start, d.cur);
    const id = newId("obj");
    const base = { id, pageId: page.id, rotation: 0 };
    let obj: EditorObject | null = null;
    switch (tool) {
      case "add-text": {
        const lineH = style.size * style.lineHeight + TEXT_PADDING * 2 + 2;
        let box;
        if (Math.max(r.w, r.h) > 8) {
          // dragged: the rectangle (in page space) defines width; height at least one line
          const vw = swap ? r.h : r.w;
          const vh = Math.max(swap ? r.w : r.h, lineH);
          box = visualBox({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, vw, vh);
        } else {
          // clicked: start the text at the click point (as seen on screen)
          const vw = 220;
          const [ox, oy] = rotCW(vw / 2, 0, -rot);
          box = visualBox({ x: d.start.x + ox, y: d.start.y + oy }, vw, lineH);
        }
        obj = { ...base, ...box, kind: "text", text: "", ...style } satisfies TextObj;
        break;
      }
      case "replace":
        if (r.w < 3 || r.h < 3) return;
        createReplace(r);
        return;
      case "highlight":
        if (r.w < 2 || r.h < 2) return;
        obj = { ...base, ...r, kind: "highlight", color: ed.drawStyle.highlight, opacity: 0.4 } satisfies HighlightObj;
        break;
      case "rect":
      case "ellipse":
        if (r.w < 2 || r.h < 2) return;
        obj = { ...base, ...r, kind: tool, stroke: ed.drawStyle.shapeStroke, fill: ed.drawStyle.shapeFill, strokeWidth: ed.drawStyle.width, opacity: 1 } satisfies ShapeObj;
        break;
      case "line":
      case "arrow": {
        if (Math.hypot(d.cur.x - d.start.x, d.cur.y - d.start.y) < 3) return;
        const w = Math.max(r.w, 1), h = Math.max(r.h, 1);
        obj = {
          ...base, x: r.x, y: r.y, w, h, kind: "line",
          p1: [(d.start.x - r.x) / w, (d.start.y - r.y) / h],
          p2: [(d.cur.x - r.x) / w, (d.cur.y - r.y) / h],
          stroke: ed.drawStyle.shapeStroke, strokeWidth: ed.drawStyle.width, arrow: tool === "arrow", opacity: 1,
        } satisfies LineObj;
        break;
      }
      case "place-image": {
        const a = ed.pendingImage ? ed.assets[ed.pendingImage] : undefined;
        if (!a) return;
        const aspect = (a.width ?? 1) / (a.height ?? 1);
        const dragged = Math.max(r.w, r.h) > 8;
        const visualPageW = swap ? geo.height : geo.width;
        const vw = dragged ? (swap ? r.h : r.w) : Math.min(visualPageW * 0.4, (a.width ?? 200) * 0.75);
        const vh = vw / aspect;
        const isSig = a.name.startsWith("signature");
        const box = visualBox(dragged ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : d.start, vw, vh);
        obj = { ...base, ...box, kind: "image", assetId: a.id, opacity: 1, signature: isSig } satisfies ImageObj;
        ed.setPendingImage(null);
        ed.setTool("select");
        break;
      }
    }
    if (!obj) return;
    commit(addObject(doc, obj), `Add ${obj.kind}`);
    setSelected([obj.id]);
    if (obj.kind === "text") {
      setEditingId(obj.id);
      // switch to the select tool so the new box can be typed in, moved and resized right away
      ed.setTool("select");
    }
  };

  const finishInk = (d: DragState) => {
    const pts = d.points ?? [];
    if (pts.length < 2) return;
    const wpad = ed.drawStyle.width;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x = Math.min(...xs) - wpad, y = Math.min(...ys) - wpad;
    const w = Math.max(Math.max(...xs) - Math.min(...xs) + wpad * 2, 1), h = Math.max(Math.max(...ys) - Math.min(...ys) + wpad * 2, 1);
    const obj: InkObj = {
      id: newId("obj"), kind: "ink", pageId: page.id, x, y, w, h, rotation: 0,
      strokes: [pts.map(([px, py]) => [(px - x) / w, (py - y) / h] as [number, number])],
      color: ed.drawStyle.color, width: ed.drawStyle.width, opacity: 1,
    };
    commit(addObject(doc, obj), "Draw");
  };

  // ------------------------------------------------------------ pointer handling
  const onPointerDownCreate = (e: RPointerEvent) => {
    if (e.button !== 0 || !editable) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toPage(e);
    // leaving an empty text box behind is never useful
    const editingObj = editingId ? doc.objects.find((o) => o.id === editingId) : undefined;
    if (editingObj && editingObj.kind === "text" && !editingObj.text.trim()) commit(deleteObjects(doc, [editingObj.id]), "Remove empty text");
    setSelected([]);
    setEditingId(null);
    ed.setNativeSel(null);
    setDrag({ kind: tool === "draw" ? "ink" : "create", start: p, cur: p, points: [[p.x, p.y]], moved: false });
  };

  const onObjPointerDown = (e: RPointerEvent, o: EditorObject, sx?: number, sy?: number) => {
    if (e.button !== 0 || tool !== "select" || !editable) return;
    e.stopPropagation();
    if (editingId === o.id && sx === undefined) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toPage(e);
    if (e.shiftKey) setSelected(selected.includes(o.id) ? selected.filter((s) => s !== o.id) : [...selected, o.id]);
    else if (!selected.includes(o.id)) setSelected([o.id]);
    ed.setNativeSel(null);
    setDrag({ kind: sx !== undefined ? "resize" : "move", id: o.id, sx, sy, start: p, cur: p, orig: o, moved: false });
  };

  const onPointerMove = (e: RPointerEvent) => {
    if (!drag) return;
    const p = toPage(e);
    const moved = drag.moved || Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 1.5 / scale;
    if (drag.kind === "ink") setDrag({ ...drag, cur: p, moved, points: [...(drag.points ?? []), [p.x, p.y]] });
    else setDrag({ ...drag, cur: p, moved });
  };

  /** text selected with the text-select tool → offer "Highlight" / "Copy" */
  const checkTextSelection = () => {
    setTimeout(() => {
      const sel = window.getSelection();
      const outer = outerRef.current;
      if (!sel || sel.isCollapsed || !outer || !sel.anchorNode || !outer.contains(sel.anchorNode)) {
        setSelMenu(null);
        return;
      }
      const f = frame();
      const rects: { x: number; y: number; w: number; h: number }[] = [];
      for (const r of Array.from(sel.getRangeAt(0).getClientRects())) {
        if (r.width < 1 || r.height < 1) continue;
        const pts = [clientToPage(f, r.left, r.top), clientToPage(f, r.right, r.top), clientToPage(f, r.left, r.bottom), clientToPage(f, r.right, r.bottom)];
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        const rr = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        const same = rects.find((q) => Math.abs(q.y - rr.y) < 1.5 && Math.abs(q.h - rr.h) < 1.5 && rr.x <= q.x + q.w + 2 && rr.x + rr.w >= q.x - 2);
        if (same) {
          const x0 = Math.min(same.x, rr.x), x1 = Math.max(same.x + same.w, rr.x + rr.w);
          same.x = x0;
          same.w = x1 - x0;
        } else rects.push(rr);
      }
      if (!rects.length) return setSelMenu(null);
      const last = sel.getRangeAt(0).getBoundingClientRect();
      const o = outer.getBoundingClientRect();
      setSelMenu({ rects, left: last.left - o.left, top: last.bottom - o.top + 6, text: sel.toString() });
    }, 0);
  };

  const onPointerUp = () => {
    if (tool === "text-select") checkTextSelection();
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (d.kind === "create") finishCreate(d);
    else if (d.kind === "ink") finishInk(d);
    else if ((d.kind === "move" || d.kind === "resize") && d.moved && d.orig) {
      const preview = previewOf(d);
      if (preview) {
        let next = doc;
        const ids = d.kind === "move" ? (selected.includes(d.id!) ? selected : [d.id!]) : [d.id!];
        const dx = d.cur.x - d.start.x, dy = d.cur.y - d.start.y;
        for (const id of ids) {
          const o = doc.objects.find((x) => x.id === id);
          if (!o) continue;
          next = updateObject(next, id, d.kind === "move" ? { x: o.x + dx, y: o.y + dy } : preview);
        }
        commit(next, d.kind === "move" ? "Move" : "Resize");
      }
    }
  };

  function previewOf(d: DragState): Partial<EditorObject> | null {
    if (!d.orig) return null;
    const o = d.orig;
    if (d.kind === "move") return { x: o.x + d.cur.x - d.start.x, y: o.y + d.cur.y - d.start.y };
    if (d.kind === "resize") {
      const keep = o.kind === "image";
      const b = resizeBox(o, d.sx!, d.sy!, d.cur, 2, keep);
      return { x: b.x, y: b.y, w: b.w, h: b.h };
    }
    return null;
  }

  const live = (o: EditorObject): EditorObject => {
    if (!drag || !drag.moved) return o;
    if (drag.kind === "move" && (drag.id === o.id || (selected.includes(o.id) && selected.includes(drag.id!))))
      return { ...o, x: o.x + drag.cur.x - drag.start.x, y: o.y + drag.cur.y - drag.start.y } as EditorObject;
    if (drag.kind === "resize" && drag.id === o.id) return { ...o, ...previewOf(drag) } as EditorObject;
    return o;
  };

  const setText = (o: EditorObject, t: string) => commit(updateObject(doc, o.id, { text: t } as Partial<EditorObject>), "Edit text", `text:${o.id}`);
  const doneEditing = (o: EditorObject) => {
    setEditingId(null);
    if (o.kind === "text") {
      const cur = doc.objects.find((x) => x.id === o.id) as TextObj | undefined;
      if (cur && !cur.text.trim()) commit(deleteObjects(doc, [o.id]), "Remove empty text");
    }
  };

  // ------------------------------------------------------------ analysis targets
  const lines = analysis?.lines.filter((l) => !l.invisible && l.text.trim()) ?? [];
  // fallback targets: PDF.js text items when our own analysis found nothing (unusual encodings etc.)
  const [fallbackItems, setFallbackItems] = useState<TextItemBox[] | null>(null);
  const needFallback = tool === "replace" && visible && !!analysis && lines.length === 0 && !!rt;
  useEffect(() => {
    if (!needFallback || fallbackItems || !rt) return;
    let alive = true;
    rt.pdf
      .getPage(srcIndex + 1)
      .then((pg) => pageTextItems(pg))
      .then((items) => alive && setFallbackItems(items))
      .catch(() => alive && setFallbackItems([]));
    return () => {
      alive = false;
    };
  }, [needFallback, fallbackItems, rt, srcIndex]);

  const pageEdits = page.origin.kind === "source" ? doc.nativeEdits[page.origin.sourceId]?.[page.origin.index] : undefined;
  const ocrLines = ed.ocr[page.id] ?? [];

  const onLineClick = (l: TextLine) => {
    if (tool === "edit-text" && page.origin.kind === "source") {
      ed.setNativeSel({ pageId: page.id, sourceId: page.origin.sourceId, pageIndex: page.origin.index, lineId: l.id });
      setSelected([]);
    } else if (tool === "replace") createReplace(lineRect(l), l);
  };

  const hits = ed.searchHits.filter((h) => h.pageId === page.id);
  const activeHit = ed.searchHits[ed.activeHit];
  const creationActive = CREATE_TOOLS.has(tool) && editable;
  const dragRect = drag && drag.kind === "create" && drag.moved ? rectFrom(drag.start, drag.cur) : null;

  const outerW = swap ? H : W;
  const outerH = swap ? W : H;

  return (
    <div
      ref={outerRef}
      data-page-index={index}
      data-testid={`page-${index + 1}`}
      className="relative mx-auto page-shadow bg-white"
      style={{ width: outerW, height: outerH }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <div
        className="absolute"
        style={{ width: W, height: H, left: (outerW - W) / 2, top: (outerH - H) / 2, transform: `rotate(${rot}deg)`, transformOrigin: "center" }}
        onPointerDown={(e) => {
          if (tool === "select" && e.target === e.currentTarget) {
            setSelected([]);
            setEditingId(null);
          }
        }}
      >
        {rt ? (
          <PageCanvas
            ref={canvasRef}
            pdf={rt.pdf}
            pageIndex={srcIndex}
            widthPt={geo.width}
            heightPt={geo.height}
            scale={scale}
            visible={visible}
            version={rt.renderVersion}
            hideForms={isPrimaryPage && (rt.fields?.length ?? 0) > 0}
          />
        ) : (
          <div className="absolute inset-0 bg-white" />
        )}
        {tool === "select" && <div className="absolute inset-0" onPointerDown={() => { setSelected([]); setEditingId(null); }} />}

        {rt && tool === "text-select" && visible && <TextSelectLayer pdf={rt.pdf} pageIndex={srcIndex} scale={scale} version={rt.renderVersion} />}

        {isPrimaryPage && rt?.fields && rt.fields.length > 0 && (
          <FormLayer
            fields={rt.fields}
            pageIndex={srcIndex}
            viewBox={vb}
            scale={scale}
            values={doc.formValues}
            disabled={!editable}
            onChange={(name, v, typing) => commit(setFormValue(doc, name, v), "Fill form", typing ? `form:${name}` : undefined)}
          />
        )}

        {hits.map((h, i) => (
          <div
            key={i}
            className="absolute pointer-events-none rounded-sm"
            style={{
              left: h.rect.x * scale, top: h.rect.y * scale, width: h.rect.w * scale, height: h.rect.h * scale,
              background: h === activeHit ? "rgba(255,140,0,0.45)" : "rgba(255,220,0,0.4)", mixBlendMode: "multiply",
            }}
          />
        ))}

        {/* added objects */}
        {objects.map((o0) => {
          const o = live(o0);
          const isSel = selected.includes(o.id);
          const editing = editingId === o.id;
          return (
            <div
              key={o.id}
              data-object-id={o.id}
              data-object-kind={o.kind}
              className="absolute"
              style={{
                left: o.x * scale, top: o.y * scale, width: o.w * scale, height: o.h * scale,
                transform: o.rotation ? `rotate(${o.rotation}deg)` : undefined,
                transformOrigin: "center",
                cursor: tool === "select" && editable ? (editing ? "text" : "move") : undefined,
                pointerEvents: tool === "select" || editing ? "auto" : "none",
                touchAction: tool === "select" && isSel ? "none" : undefined,
                outline: isSel ? "1.5px solid var(--accent)" : undefined,
                outlineOffset: 1,
                zIndex: editing ? 5 : undefined,
              }}
              onPointerDown={(e) => onObjPointerDown(e, o0)}
              onDoubleClick={() => (o.kind === "text" || o.kind === "replace") && editable && setEditingId(o.id)}
            >
              <div className="absolute" style={{ inset: -5 }} />
              <ErrorBoundary resetKey={o0}>
                <ObjectBody obj={o} assets={ed.assets} faces={faces} scale={scale} editing={editing} onText={(t) => setText(o0, t)} onDone={() => doneEditing(o0)} />
              </ErrorBoundary>
              {o.kind === "replace" && isSel && !editing && (
                <div className="absolute -top-5 left-0 whitespace-nowrap rounded bg-amber-500 px-1 text-[10px] text-white">Visual replacement — covers, does not remove</div>
              )}
              {isSel && selected.length === 1 && !editing && tool === "select" && editable &&
                [-1, 0, 1].flatMap((sx) =>
                  [-1, 0, 1].map((sy) =>
                    sx === 0 && sy === 0 ? null : (
                      <div
                        key={`${sx}${sy}`}
                        role="presentation"
                        className="pe-handle absolute rounded-sm border border-accent bg-white"
                        style={{ left: `${((sx + 1) / 2) * 100}%`, top: `${((sy + 1) / 2) * 100}%`, cursor: "nwse-resize", touchAction: "none" }}
                        onPointerDown={(e) => onObjPointerDown(e, o0, sx, sy)}
                      />
                    ),
                  ),
                )}
            </div>
          );
        })}

        {/* creation overlay */}
        {creationActive && (
          <div
            className="absolute inset-0"
            style={{ cursor: tool === "add-text" ? "text" : "crosshair", touchAction: "none" }}
            onPointerDown={onPointerDownCreate}
            data-testid={`create-layer-${index + 1}`}
          />
        )}

        {/* original-text targets (edit-text / replace) */}
        {(tool === "edit-text" || tool === "replace") && editable && (
          <div className="absolute inset-0 pointer-events-none">
            {lines.map((l) => {
              const r = lineRect(l);
              const edited = !!pageEdits?.[l.id];
              const sel = ed.nativeSel?.pageId === page.id && ed.nativeSel.lineId === l.id;
              return (
                <button
                  key={l.id}
                  type="button"
                  title={tool === "edit-text" ? `Edit original text: ${l.displayText}` : `Replace visually: ${l.displayText}`}
                  aria-label={`${tool === "edit-text" ? "Edit" : "Replace"} text: ${l.displayText}`}
                  data-line-id={l.id}
                  className="absolute pointer-events-auto rounded-[2px]"
                  style={{
                    left: (r.x - 1) * scale, top: (r.y - 1) * scale, width: (r.w + 2) * scale, height: (r.h + 2) * scale,
                    border: sel ? "2px solid var(--accent)" : edited ? "1.5px solid #1a9b55" : hoverLine === l.id ? "1.5px solid var(--accent)" : "1px dashed rgba(47,111,222,0.45)",
                    background: hoverLine === l.id ? "rgba(47,111,222,0.08)" : "transparent",
                    cursor: "pointer",
                  }}
                  onPointerEnter={() => setHoverLine(l.id)}
                  onPointerLeave={() => setHoverLine(null)}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onLineClick(l)}
                />
              );
            })}
            {tool === "replace" &&
              lines.length === 0 &&
              fallbackItems?.map((l, i) => (
                <button
                  key={`pj${i}`}
                  type="button"
                  title={`Replace visually: ${l.str}`}
                  aria-label={`Replace text: ${l.str}`}
                  className="absolute pointer-events-auto rounded-[2px] border border-dashed border-sky-500/70 hover:bg-sky-500/10"
                  style={{ left: l.x * scale, top: l.y * scale, width: l.w * scale, height: l.h * scale }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => createReplace(l, undefined, l.str)}
                />
              ))}
            {tool === "replace" &&
              ocrLines.map((l, i) => (
                <button
                  key={`ocr${i}`}
                  type="button"
                  title={`OCR (${Math.round(l.confidence)}%): ${l.text}`}
                  className="absolute pointer-events-auto rounded-[2px] border border-dashed border-fuchsia-500/70 hover:bg-fuchsia-500/10"
                  style={{ left: l.x * scale, top: l.y * scale, width: l.w * scale, height: l.h * scale }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => createReplace(l, undefined, l.text)}
                />
              ))}
            {analysis && !lines.length && !ocrLines.length && !fallbackItems?.length && visible && (
              <div className="absolute left-2 right-2 top-2 rounded bg-warn-bg p-2 text-xs text-warn-text shadow">
                No editable text was found on this page{analysis.parseError ? ` (${analysis.parseError})` : ""}. It may be a scanned image
                {analysis.hasFormXObjects ? " or its text lives inside embedded form objects" : ""}. Use OCR in the side panel, or drag a region to replace it visually.
              </div>
            )}
          </div>
        )}

        {dragRect && (
          <div
            className="absolute pointer-events-none border border-accent"
            style={{
              left: dragRect.x * scale, top: dragRect.y * scale, width: dragRect.w * scale, height: dragRect.h * scale,
              background: tool === "highlight" ? ed.drawStyle.highlight + "66" : "rgba(47,111,222,0.08)",
              borderRadius: tool === "ellipse" ? "50%" : undefined,
            }}
          />
        )}
        {drag?.kind === "ink" && drag.points && (
          <svg className="absolute inset-0 pointer-events-none" width={W} height={H}>
            <polyline
              points={drag.points.map(([x, y]) => `${x * scale},${y * scale}`).join(" ")}
              fill="none" stroke={ed.drawStyle.color} strokeWidth={ed.drawStyle.width * scale} strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        )}
        {drag?.kind === "create" && (tool === "line" || tool === "arrow") && drag.moved && (
          <svg className="absolute inset-0 pointer-events-none" width={W} height={H}>
            <line x1={drag.start.x * scale} y1={drag.start.y * scale} x2={drag.cur.x * scale} y2={drag.cur.y * scale} stroke={ed.drawStyle.shapeStroke} strokeWidth={ed.drawStyle.width * scale} />
          </svg>
        )}
      </div>
      {selMenu && tool === "text-select" && (
        <div className="absolute z-20 flex gap-1 rounded-md border border-line bg-panel p-1 text-xs shadow-lg" style={{ left: Math.max(0, selMenu.left - 60), top: selMenu.top }} onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="rounded px-2 py-1 hover:bg-panel-2 disabled:opacity-40"
            disabled={!editable}
            data-testid="selection-highlight"
            onClick={() => {
              let next = doc;
              for (const r of selMenu.rects)
                next = addObject(next, { id: newId("obj"), kind: "highlight", pageId: page.id, x: r.x, y: r.y, w: r.w, h: r.h, rotation: 0, color: ed.drawStyle.highlight, opacity: 0.4 } satisfies HighlightObj);
              commit(next, "Highlight text");
              window.getSelection()?.removeAllRanges();
              setSelMenu(null);
            }}
          >
            Highlight
          </button>
          <button className="rounded px-2 py-1 hover:bg-panel-2" onClick={() => { navigator.clipboard?.writeText(selMenu.text).catch(() => {}); setSelMenu(null); ed.toast("info", "Copied to clipboard."); }}>
            Copy
          </button>
        </div>
      )}
    </div>
  );
});
