"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { X as XIcon, AlertTriangle, ArrowDownToLine, ArrowUpToLine, CheckCircle2, Copy, Info, Loader2, ScanText, Trash2, Upload, XCircle } from "lucide-react";
import { useEditor, type Tool } from "./store";
import type { EditorObject, ReplaceObj, TextObj, TextStyle } from "@/lib/model/types";
import { addObject, deleteObjects, newId, reorderObject, updateObject } from "@/lib/model/ops";
import { BUILTIN_FAMILIES, type FontFamilyId } from "@/lib/text/fontFaces";
import { checkNativeEdit, type NativeEditCheck } from "@/lib/pdf/nativeEdit";
import type { TextLine } from "@/lib/pdf/textAnalysis";
import { recognizePage } from "@/lib/ocr/ocr";
import { pageGeometry } from "@/lib/model/types";
import { Button, Field, inputCls } from "./ui";

const toHex = (rgb: [number, number, number]) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-3 py-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function Note({ kind = "info", children }: { kind?: "info" | "warn" | "ok" | "error"; children: React.ReactNode }) {
  const Icon = kind === "warn" ? AlertTriangle : kind === "ok" ? CheckCircle2 : kind === "error" ? XCircle : Info;
  const cls = kind === "warn" ? "bg-warn-bg text-warn-text" : kind === "ok" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : kind === "error" ? "bg-danger/10 text-danger" : "bg-panel-2 text-muted";
  return (
    <div className={`flex gap-2 rounded-md p-2 text-xs leading-snug ${cls}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function NumberInput({ value, onChange, min, max, step = 1, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label: string }) {
  const [s, setS] = useState(String(Math.round(value * 100) / 100));
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    // the value changed from outside (undo, dragging…): show it
    setPrev(value);
    setS(String(Math.round(value * 100) / 100));
  }
  return (
    <input
      type="number"
      aria-label={label}
      className={inputCls}
      value={s}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        setS(e.target.value);
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v) && (min === undefined || v >= min) && (max === undefined || v <= max)) onChange(v);
      }}
    />
  );
}

function FontSelect({ value, onChange }: { value: FontFamilyId; onChange: (f: FontFamilyId) => void }) {
  const ed = useEditor();
  const fileRef = useRef<HTMLInputElement>(null);
  const customs = Object.values(ed.assets).filter((a) => a.kind === "font");
  return (
    <div className="flex gap-1">
      <select aria-label="Font" className={inputCls} value={value} onChange={(e) => onChange(e.target.value as FontFamilyId)}>
        {BUILTIN_FAMILIES.map((f) => (
          <option key={f.id} value={f.id}>{f.label}</option>
        ))}
        {customs.map((a) => (
          <option key={a.id} value={`custom:${a.id}`}>{a.name}</option>
        ))}
      </select>
      <button type="button" title="Use a font file (.ttf/.otf) from your computer" aria-label="Upload font" className="rounded-md border border-line px-2 hover:bg-panel-2" onClick={() => fileRef.current?.click()}>
        <Upload className="h-3.5 w-3.5" />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".ttf,.otf,font/ttf,font/otf"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const bytes = new Uint8Array(await f.arrayBuffer());
          try {
            const { fontkit } = await import("@/lib/text/fontFaces");
            fontkit.create(bytes); // validate
            if (/\.woff2?$/i.test(f.name)) throw new Error("WOFF fonts are not supported; use TTF or OTF.");
            const id = ed.addAsset({ kind: "font", mime: "font/ttf", name: f.name.replace(/\.(ttf|otf)$/i, ""), bytes });
            const face = new FontFace(`PE custom ${id}`, bytes.slice().buffer as ArrayBuffer);
            await face.load();
            document.fonts.add(face);
            onChange(`custom:${id}`);
          } catch (err) {
            ed.toast("error", `That font could not be used: ${(err as Error).message}`);
          }
        }}
      />
    </div>
  );
}

function TextStyleEditor({ style, onChange }: { style: TextStyle; onChange: (p: Partial<TextStyle>) => void }) {
  return (
    <>
      <Field label="Font">
        <FontSelect value={style.family} onChange={(family) => onChange({ family })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Size (pt)">
          <NumberInput label="Font size" value={style.size} min={2} max={400} step={0.5} onChange={(size) => onChange({ size })} />
        </Field>
        <Field label="Color">
          <input type="color" aria-label="Text color" className="h-8 w-full rounded border border-line bg-panel" value={style.color} onChange={(e) => onChange({ color: e.target.value })} />
        </Field>
      </div>
      <div className="flex gap-1">
        <button type="button" aria-pressed={style.bold} className={`flex-1 rounded-md border border-line py-1 text-sm font-bold ${style.bold ? "bg-accent-soft text-accent" : ""}`} onClick={() => onChange({ bold: !style.bold })}>B</button>
        <button type="button" aria-pressed={style.italic} className={`flex-1 rounded-md border border-line py-1 text-sm italic ${style.italic ? "bg-accent-soft text-accent" : ""}`} onClick={() => onChange({ italic: !style.italic })}>I</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Align">
          <select aria-label="Alignment" className={inputCls} value={style.align} onChange={(e) => onChange({ align: e.target.value as TextStyle["align"] })}>
            <option value="start">Start (auto)</option>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </Field>
        <Field label="Direction">
          <select aria-label="Text direction" className={inputCls} value={style.dir} onChange={(e) => onChange({ dir: e.target.value as TextStyle["dir"] })}>
            <option value="auto">Auto</option>
            <option value="ltr">Left → right</option>
            <option value="rtl">Right → left</option>
          </select>
        </Field>
      </div>
      <Field label="Line height">
        <NumberInput label="Line height" value={style.lineHeight} min={0.8} max={3} step={0.05} onChange={(lineHeight) => onChange({ lineHeight })} />
      </Field>
    </>
  );
}

function NativeEditPanel() {
  const ed = useEditor();
  const sel = ed.nativeSel!;
  const rt = ed.sources[sel.sourceId];
  const [line, setLine] = useState<TextLine | null>(null);
  const [text, setText] = useState("");
  const [check, setCheck] = useState<NativeEditCheck | null>(null);
  const [usageReady, setUsageReady] = useState(false);
  const analysisRef = useRef<Awaited<ReturnType<typeof rt.analysis>> | null>(null);
  const usageRef = useRef<Awaited<ReturnType<typeof rt.fontUsage>> | null>(null);
  const existing = ed.doc.nativeEdits[sel.sourceId]?.[sel.pageIndex]?.[sel.lineId];

  useEffect(() => {
    let alive = true;
    (async () => {
      const a = await rt.analysis(sel.pageIndex);
      const l = a.lines.find((x) => x.id === sel.lineId) ?? null;
      if (!alive) return;
      analysisRef.current = a;
      setLine(l);
      setText(existing?.text ?? (l && (l.rtl || l.inXObject) ? l.displayText : l?.text) ?? "");
      usageRef.current = await rt.fontUsage();
      if (alive) setUsageReady(true);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.sourceId, sel.pageIndex, sel.lineId]);

  useEffect(() => {
    if (!line || !analysisRef.current || !usageReady) return;
    setCheck(checkNativeEdit(analysisRef.current, line, text, usageRef.current ?? undefined));
  }, [line, text, usageReady]);

  if (!line) return <Section title="Edit original text"><Loader2 className="h-4 w-4 animate-spin" /></Section>;
  const f = line.font;
  const page = ed.doc.pages.find((p) => p.id === sel.pageId);
  const useVisual = () => {
    if (!page) return;
    const g = pageGeometry(page, ed.sourceInfos);
    const vb = g.viewBox;
    const r = { x: line.bbox.x0 - vb[0] - 1, y: vb[3] - line.bbox.y1 - 1, w: line.bbox.x1 - line.bbox.x0 + 2, h: line.bbox.y1 - line.bbox.y0 + 2 };
    const obj: ReplaceObj = {
      id: newId("obj"), kind: "replace", pageId: page.id, ...r, rotation: 0, text, originalText: line.displayText, cover: "#ffffff",
      family: line.rtl ? "noto-naskh-arabic" : /times|serif/i.test(f?.family ?? "") ? "times" : /courier|mono/i.test(f?.family ?? "") ? "courier" : "helvetica",
      size: Math.round(line.userFontSize * 10) / 10, color: toHex(line.fill), bold: !!f?.bold, italic: !!f?.italic,
      align: line.rtl ? "right" : "left", dir: line.rtl ? "rtl" : "auto", lineHeight: 1.15,
    };
    ed.commit(addObject(ed.doc, obj), "Visual replacement");
    ed.setNativeSel(null);
    ed.setTool("select");
    ed.setSelected([obj.id]);
    ed.toast("info", "Created a visual replacement. Check the cover colour matches the background.");
  };
  return (
    <>
      <Section title="Edit original text (native)">
        <Note>Rewrites the text operators inside the PDF using the original font. Following text is not reflowed.</Note>
        <Field label="Text">
          <input aria-label="New text" data-testid="native-text" className={inputCls} value={text} dir="auto" onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!check?.ok || text === (existing?.text ?? line.text)} onClick={() => ed.applyNativeEdit(sel, text, line.text)} testId="native-apply">
            Apply native edit
          </Button>
          {existing && <Button onClick={() => ed.applyNativeEdit(sel, line.text, line.text)}>Revert</Button>}
        </div>
        {check && check.ok && <Note kind="ok">This change can be written into the original text.</Note>}
        {check && !check.ok && (
          <Note kind="error">
            <b>Native editing is not possible here:</b>
            <ul className="mt-1 list-disc pl-4">{check.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          </Note>
        )}
        {check?.warnings.map((w, i) => <Note key={i} kind="warn">{w}</Note>)}
        <Button onClick={useVisual} testId="native-to-visual">Use visual replacement instead</Button>
      </Section>
      <Section title="Detected properties">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted">Original</dt><dd dir="auto" className="break-words">{line.displayText}</dd>
          <dt className="text-muted">Font</dt><dd>{f?.family || "unknown"}{f?.isSubset ? " (subset)" : ""}</dd>
          <dt className="text-muted">Type</dt><dd>{f ? `${f.subtype}${f.isCID ? " / CID" : ""}${f.embedded ? ", embedded" : f.standard14 ? ", standard" : ", not embedded"}` : "—"}</dd>
          <dt className="text-muted">Size</dt><dd>{line.userFontSize.toFixed(1)} pt</dd>
          <dt className="text-muted">Style</dt><dd>{[f?.bold && "bold", f?.italic && "italic"].filter(Boolean).join(", ") || "regular"}</dd>
          <dt className="text-muted">Color</dt><dd className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm border border-line" style={{ background: toHex(line.fill) }} />{toHex(line.fill)}</dd>
          <dt className="text-muted">Direction</dt><dd>{line.rtl ? "right-to-left" : "left-to-right"}{Math.abs(line.angle) > 0.5 ? `, rotated ${line.angle.toFixed(0)}°` : ""}</dd>
          <dt className="text-muted">Operators</dt><dd>{line.shows.length} text operator(s) ({[...new Set(line.shows.map((s) => s.op))].join(", ")})</dd>
          <dt className="text-muted">Spacing</dt><dd>char {line.shows[0].charSpacing.toFixed(2)}, word {line.shows[0].wordSpacing.toFixed(2)}, scale {Math.round(line.shows[0].horizontalScale * 100)}%</dd>
        </dl>
      </Section>
    </>
  );
}

function OcrSection() {
  const ed = useEditor();
  const [state, setState] = useState<{ running: boolean; progress: number; status: string } | null>(null);
  const [langs, setLangs] = useState<string[]>(["eng", "ara"]);
  const page = ed.doc.pages[ed.currentPage];
  const lines = page ? ed.ocr[page.id] : undefined;
  const run = async () => {
    if (!page || page.origin.kind !== "source") return;
    const rt = ed.sources[page.origin.sourceId];
    const ac = new AbortController();
    setState({ running: true, progress: 0, status: "starting" });
    ed.setBusy({ message: "Recognizing text (OCR)…", cancel: () => ac.abort() });
    try {
      const res = await recognizePage(rt.pdf, page.origin.index, langs, (p, s) => {
        setState({ running: true, progress: p, status: s });
        ed.setBusy({ message: `OCR: ${s}`, progress: p, cancel: () => ac.abort() });
      }, ac.signal);
      ed.setOcr((o) => ({ ...o, [page.id]: res }));
      ed.toast("success", `OCR found ${res.length} line(s) on page ${ed.currentPage + 1}.`);
    } catch (e) {
      if (!ac.signal.aborted) ed.toast("error", `OCR failed: ${(e as Error).message}`);
    } finally {
      setState(null);
      ed.setBusy(null);
    }
  };
  return (
    <Section title={`OCR – page ${ed.currentPage + 1}`}>
      <Note>For scanned pages. Recognition runs locally; results can be searched, copied and used to place visual replacements. Accuracy varies with scan quality.</Note>
      <div className="flex gap-3 text-xs">
        {[["eng", "English"], ["ara", "Arabic"]].map(([k, l]) => (
          <label key={k} className="flex items-center gap-1">
            <input type="checkbox" checked={langs.includes(k)} onChange={(e) => setLangs(e.target.checked ? [...langs, k] : langs.filter((x) => x !== k))} /> {l}
          </label>
        ))}
      </div>
      <Button onClick={run} disabled={!!state || !langs.length || !page || page.origin.kind !== "source"} testId="ocr-run">
        {state ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanText className="h-4 w-4" />} Recognize text
      </Button>
      {lines && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>{lines.length} line(s)</span>
            <button className="flex items-center gap-1 hover:text-fg" onClick={() => navigator.clipboard.writeText(lines.map((l) => l.text).join("\n"))}>
              <Copy className="h-3 w-3" /> Copy all
            </button>
          </div>
          <div className="max-h-40 overflow-auto rounded border border-line p-1 text-xs" dir="auto">
            {lines.map((l, i) => <div key={i}>{l.text}</div>)}
          </div>
        </div>
      )}
    </Section>
  );
}

function ObjectPanel({ obj }: { obj: EditorObject }) {
  const ed = useEditor();
  const set = (p: Partial<EditorObject>, key?: string) => ed.commit(updateObject(ed.doc, obj.id, p), "Change properties", key ?? `props:${obj.id}:${Object.keys(p).join(",")}`);
  const title = { text: "Text box", replace: "Visual replacement", image: obj.kind === "image" && obj.signature ? "Signature" : "Image", ink: "Drawing", rect: "Rectangle", ellipse: "Ellipse", line: "Line", highlight: "Highlight" }[obj.kind];
  return (
    <>
      <Section title={title}>
        {(obj.kind === "text" || obj.kind === "replace") && (
          <>
            {obj.kind === "replace" && (
              <Note kind="warn">
                This covers the original text with a {obj.cover} box and draws new text on top. The original text <b>still exists inside the PDF</b> and can be copied or extracted. It is <b>not a redaction</b> — do not use it to hide confidential information.
              </Note>
            )}
            <Field label="Content">
              <textarea aria-label="Text content" data-testid="prop-text" className={`${inputCls} min-h-20`} dir="auto" value={obj.text} onChange={(e) => set({ text: e.target.value } as Partial<TextObj>, `text:${obj.id}`)} />
            </Field>
            <TextStyleEditor style={obj} onChange={(p) => set(p)} />
            {obj.kind === "replace" && (
              <Field label="Cover color" hint="Sampled from the page around the area. Adjust if the background is not uniform.">
                <input type="color" aria-label="Cover color" className="h-8 w-full rounded border border-line" value={obj.cover} onChange={(e) => set({ cover: e.target.value } as Partial<ReplaceObj>)} />
              </Field>
            )}
            {obj.kind === "replace" && obj.originalText && <p className="text-[11px] text-muted" dir="auto">Original: {obj.originalText}</p>}
          </>
        )}
        {obj.kind === "image" && (
          <Field label={`Opacity (${Math.round(obj.opacity * 100)}%)`}>
            <input type="range" min={0.05} max={1} step={0.05} value={obj.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })} className="w-full" aria-label="Opacity" />
          </Field>
        )}
        {(obj.kind === "ink" || obj.kind === "highlight") && (
          <Field label="Color">
            <input type="color" aria-label="Color" className="h-8 w-full rounded border border-line" value={obj.color} onChange={(e) => set({ color: e.target.value })} />
          </Field>
        )}
        {obj.kind === "ink" && (
          <Field label="Width (pt)"><NumberInput label="Stroke width" value={obj.width} min={0.25} max={50} step={0.25} onChange={(width) => set({ width })} /></Field>
        )}
        {(obj.kind === "rect" || obj.kind === "ellipse") && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Stroke">
                <div className="flex items-center gap-1">
                  <input type="checkbox" aria-label="Has stroke" checked={!!obj.stroke} onChange={(e) => set({ stroke: e.target.checked ? "#d22d2d" : null })} />
                  <input type="color" aria-label="Stroke color" disabled={!obj.stroke} className="h-8 w-full rounded border border-line" value={obj.stroke ?? "#000000"} onChange={(e) => set({ stroke: e.target.value })} />
                </div>
              </Field>
              <Field label="Fill">
                <div className="flex items-center gap-1">
                  <input type="checkbox" aria-label="Has fill" checked={!!obj.fill} onChange={(e) => set({ fill: e.target.checked ? "#ffffff" : null })} />
                  <input type="color" aria-label="Fill color" disabled={!obj.fill} className="h-8 w-full rounded border border-line" value={obj.fill ?? "#ffffff"} onChange={(e) => set({ fill: e.target.value })} />
                </div>
              </Field>
            </div>
            <Field label="Stroke width (pt)"><NumberInput label="Stroke width" value={obj.strokeWidth} min={0.25} max={50} step={0.25} onChange={(strokeWidth) => set({ strokeWidth })} /></Field>
          </>
        )}
        {obj.kind === "line" && (
          <>
            <Field label="Color"><input type="color" aria-label="Line color" className="h-8 w-full rounded border border-line" value={obj.stroke} onChange={(e) => set({ stroke: e.target.value })} /></Field>
            <Field label="Width (pt)"><NumberInput label="Line width" value={obj.strokeWidth} min={0.25} max={50} step={0.25} onChange={(strokeWidth) => set({ strokeWidth })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={obj.arrow} onChange={(e) => set({ arrow: e.target.checked })} /> Arrow head</label>
          </>
        )}
        {(obj.kind === "rect" || obj.kind === "ellipse" || obj.kind === "line" || obj.kind === "ink" || obj.kind === "highlight") && (
          <Field label={`Opacity (${Math.round(obj.opacity * 100)}%)`}>
            <input type="range" min={0.05} max={1} step={0.05} value={obj.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })} className="w-full" aria-label="Opacity" />
          </Field>
        )}
      </Section>
      <Section title="Position (pt)">
        <div className="grid grid-cols-2 gap-2">
          <Field label="X"><NumberInput label="X" value={obj.x} step={1} onChange={(x) => set({ x })} /></Field>
          <Field label="Y"><NumberInput label="Y" value={obj.y} step={1} onChange={(y) => set({ y })} /></Field>
          <Field label="Width"><NumberInput label="Width" value={obj.w} min={1} step={1} onChange={(w) => set({ w })} /></Field>
          <Field label="Height"><NumberInput label="Height" value={obj.h} min={1} step={1} onChange={(h) => set({ h })} /></Field>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button onClick={() => ed.commit(reorderObject(ed.doc, obj.id, "front"), "Bring to front")}><ArrowUpToLine className="h-3.5 w-3.5" /> Front</Button>
          <Button onClick={() => ed.commit(reorderObject(ed.doc, obj.id, "back"), "Send to back")}><ArrowDownToLine className="h-3.5 w-3.5" /> Back</Button>
          <Button onClick={() => {
            const c = { ...obj, id: newId("obj"), x: obj.x + 10, y: obj.y + 10 } as EditorObject;
            ed.commit(addObject(ed.doc, c), "Duplicate");
            ed.setSelected([c.id]);
          }}><Copy className="h-3.5 w-3.5" /> Duplicate</Button>
          <Button variant="danger" onClick={() => { ed.commit(deleteObjects(ed.doc, [obj.id]), "Delete"); ed.setSelected([]); }} testId="obj-delete"><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
        </div>
        <p className="text-[11px] text-muted">Added objects are drawn into the page content when you download. They are separate from the document’s original content.</p>
      </Section>
    </>
  );
}

const TOOL_HELP: Partial<Record<Tool, string>> = {
  select: "Click an added object to select it. Drag to move, use the handles to resize, double-click text to edit. Del deletes, arrow keys nudge.",
  "text-select": "Select text on the page and copy it with Ctrl+C.",
  "edit-text": "Click a line of original text (dashed boxes) to rewrite it in the PDF itself. If that is not safely possible, you can switch to visual replacement.",
  replace: "Click a line of text or drag over any area (including scanned pages) to cover it and type replacement text.",
  "add-text": "Click to place a text box, or drag to set its width.",
  draw: "Draw freehand with the mouse or pen.",
  highlight: "Drag over an area to highlight it.",
  rect: "Drag to draw a rectangle.",
  ellipse: "Drag to draw an ellipse.",
  line: "Drag to draw a line.",
  arrow: "Drag to draw an arrow.",
  "place-image": "Click to place the image, or drag to set its width.",
};

export function PropertiesPanel({ className = "", onClose }: { className?: string; onClose?: () => void }) {
  const ed = useEditor();
  const { doc, selected, tool } = ed;
  const objs = useMemo(() => doc.objects.filter((o) => selected.includes(o.id)), [doc.objects, selected]);
  const src = ed.primaryId ? ed.sources[ed.primaryId] : undefined;
  let body: React.ReactNode;
  if (ed.nativeSel && ed.sources[ed.nativeSel.sourceId]) body = <NativeEditPanel key={`${ed.nativeSel.pageId}:${ed.nativeSel.lineId}`} />;
  else if (objs.length === 1) body = <ObjectPanel obj={objs[0]} />;
  else if (objs.length > 1)
    body = (
      <Section title={`${objs.length} objects selected`}>
        <Button variant="danger" onClick={() => { ed.commit(deleteObjects(doc, selected), "Delete"); ed.setSelected([]); }}><Trash2 className="h-3.5 w-3.5" /> Delete all</Button>
      </Section>
    );
  else
    body = (
      <>
        <Section title="Tool">
          <p className="text-xs leading-relaxed text-muted">{TOOL_HELP[tool]}</p>
          {tool === "edit-text" && (
            <Note kind="warn">
              Native editing works for text in simple and Latin fonts that contain the needed characters. Arabic, scanned pages, Type 3 fonts and missing glyphs require visual replacement.
            </Note>
          )}
          {tool === "replace" && (
            <Note kind="warn">Visual replacement hides the original text under a cover; it does not delete it from the file. It is not a redaction.</Note>
          )}
        </Section>
        {tool === "add-text" && (
          <Section title="New text style">
            <TextStyleEditor style={ed.textStyle} onChange={(p) => ed.setTextStyle({ ...ed.textStyle, ...p })} />
          </Section>
        )}
        {["draw", "highlight", "rect", "ellipse", "line", "arrow"].includes(tool) && (
          <Section title="Style">
            {tool === "highlight" ? (
              <Field label="Highlight color"><input type="color" aria-label="Highlight color" className="h-8 w-full rounded border border-line" value={ed.drawStyle.highlight} onChange={(e) => ed.setDrawStyle({ ...ed.drawStyle, highlight: e.target.value })} /></Field>
            ) : (
              <>
                <Field label="Color">
                  <input type="color" aria-label="Stroke color" className="h-8 w-full rounded border border-line" value={tool === "draw" ? ed.drawStyle.color : ed.drawStyle.shapeStroke} onChange={(e) => ed.setDrawStyle(tool === "draw" ? { ...ed.drawStyle, color: e.target.value } : { ...ed.drawStyle, shapeStroke: e.target.value })} />
                </Field>
                <Field label="Width (pt)"><NumberInput label="Stroke width" value={ed.drawStyle.width} min={0.25} max={40} step={0.25} onChange={(width) => ed.setDrawStyle({ ...ed.drawStyle, width })} /></Field>
                {(tool === "rect" || tool === "ellipse") && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={!!ed.drawStyle.shapeFill} onChange={(e) => ed.setDrawStyle({ ...ed.drawStyle, shapeFill: e.target.checked ? "#ffffff" : null })} /> Fill
                    {ed.drawStyle.shapeFill && <input type="color" aria-label="Fill color" value={ed.drawStyle.shapeFill} onChange={(e) => ed.setDrawStyle({ ...ed.drawStyle, shapeFill: e.target.value })} />}
                  </label>
                )}
              </>
            )}
          </Section>
        )}
        {(tool === "replace" || tool === "edit-text" || tool === "text-select") && <OcrSection />}
        {src && (
          <Section title="Document">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted">File</dt><dd className="break-all">{ed.fileName}</dd>
              <dt className="text-muted">Pages</dt><dd>{doc.pages.length}</dd>
              <dt className="text-muted">Size</dt><dd>{(src.info.size / 1024).toFixed(0)} KB</dd>
              <dt className="text-muted">Form fields</dt><dd>{src.fields?.length ?? 0}</dd>
              <dt className="text-muted">Added objects</dt><dd>{doc.objects.length}</dd>
              <dt className="text-muted">Native edits</dt><dd>{Object.values(doc.nativeEdits).reduce((n, s) => n + Object.values(s).reduce((m, p) => m + Object.keys(p).length, 0), 0)}</dd>
            </dl>
            {src.info.readOnlyReason && <Note kind="warn">{src.info.readOnlyReason}</Note>}
          </Section>
        )}
      </>
    );
  return (
    <aside className={`flex h-full w-[272px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel ${className}`} aria-label="Properties">
      {onClose && (
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-panel px-3 py-2">
          <span className="text-sm font-semibold">Properties</span>
          <button type="button" aria-label="Close properties" className="rounded p-1.5 hover:bg-panel-2" onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      )}
      {body}
    </aside>
  );
}
