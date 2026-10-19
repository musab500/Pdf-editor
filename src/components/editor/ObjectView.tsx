"use client";
import { useEffect, useMemo, useRef } from "react";
import type { Asset, EditorObject, ReplaceObj, TextObj } from "@/lib/model/types";
import type { FaceRegistry } from "@/lib/text/fontFaces";
import { familyInfo } from "@/lib/text/fontFaces";
import { REPLACE_PADDING, TEXT_PADDING } from "@/lib/pdf/exporter";
import { TextBlockSvg, useLayout } from "./TextBlock";

const urlCache = new Map<string, string>();
export function assetUrl(a: Asset): string {
  let u = urlCache.get(a.id);
  if (!u) {
    u = URL.createObjectURL(new Blob([a.bytes as BlobPart], { type: a.mime }));
    urlCache.set(a.id, u);
  }
  return u;
}
/** Revoke object URLs (called when a new document is opened). */
export function revokeAssetUrls(keep: Set<string> = new Set()) {
  for (const [id, u] of urlCache) {
    if (keep.has(id)) continue;
    URL.revokeObjectURL(u);
    urlCache.delete(id);
  }
}

function fontCss(o: TextObj | ReplaceObj) {
  const info = familyInfo(o.family);
  const base = info ? info.css : `'PE custom ${o.family.slice(7)}'`;
  return `${base}, 'PE Noto Sans', 'PE Noto Sans Arabic', sans-serif`;
}

function TextObjectBody({ obj, faces, scale, editing, onText, onDone }: { obj: TextObj | ReplaceObj; faces: FaceRegistry; scale: number; editing: boolean; onText: (t: string) => void; onDone: () => void }) {
  const pad = obj.kind === "replace" ? REPLACE_PADDING : TEXT_PADDING;
  const layout = useLayout(faces, obj, obj.text, obj.w - pad * 2);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus();
      taRef.current.select();
    }
  }, [editing]);
  return (
    <>
      {obj.kind === "replace" && <div style={{ position: "absolute", inset: 0, background: obj.cover }} />}
      {!editing && <TextBlockSvg layout={layout} style={obj} width={obj.w} height={obj.h} padding={pad} />}
      {!editing && !obj.text && (
        <div className="absolute inset-0 grid place-items-center text-[10px] text-muted/70 select-none">{obj.kind === "replace" ? "replacement text" : "text"}</div>
      )}
      {editing && (
        <textarea
          ref={taRef}
          aria-label="Text content"
          value={obj.text}
          dir={obj.dir === "auto" ? "auto" : obj.dir}
          onChange={(e) => onText(e.target.value)}
          onBlur={onDone}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            }
            e.stopPropagation();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute inset-0 resize-none border-0 outline-none"
          style={{
            padding: pad * scale,
            fontFamily: fontCss(obj),
            fontSize: obj.size * scale,
            lineHeight: obj.lineHeight,
            fontWeight: obj.bold ? 700 : 400,
            fontStyle: obj.italic ? "italic" : "normal",
            color: obj.color,
            textAlign: obj.align === "start" || obj.align === "end" ? obj.align : obj.align,
            background: obj.kind === "replace" ? obj.cover : "rgba(255,255,255,0.85)",
            overflow: "hidden",
            whiteSpace: "pre-wrap",
          }}
        />
      )}
    </>
  );
}

export function ObjectBody({
  obj,
  assets,
  faces,
  scale,
  editing,
  onText,
  onDone,
}: {
  obj: EditorObject;
  assets: Record<string, Asset>;
  faces: FaceRegistry;
  scale: number;
  editing: boolean;
  onText: (t: string) => void;
  onDone: () => void;
}) {
  const view = `0 0 ${Math.max(obj.w, 0.01)} ${Math.max(obj.h, 0.01)}`;
  const svgStyle = { position: "absolute" as const, inset: 0, overflow: "visible" as const, pointerEvents: "none" as const };
  const inkPaths = useMemo(
    () =>
      obj.kind === "ink"
        ? obj.strokes.map((s) => s.map(([x, y], i) => `${i ? "L" : "M"}${(x * obj.w).toFixed(2)} ${(y * obj.h).toFixed(2)}`).join(" "))
        : [],
    [obj],
  );
  switch (obj.kind) {
    case "text":
    case "replace":
      return <TextObjectBody obj={obj} faces={faces} scale={scale} editing={editing} onText={onText} onDone={onDone} />;
    case "image": {
      const a = assets[obj.assetId];
      if (!a) return <div className="absolute inset-0 bg-danger/20 text-xs">missing image</div>;
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={assetUrl(a)} alt="" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: obj.opacity, pointerEvents: "none" }} />;
    }
    case "ink":
      return (
        <svg width="100%" height="100%" viewBox={view} preserveAspectRatio="none" style={svgStyle}>
          {inkPaths.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={obj.color} strokeWidth={obj.width} strokeLinecap="round" strokeLinejoin="round" opacity={obj.opacity} vectorEffect="none" />
          ))}
        </svg>
      );
    case "rect":
    case "ellipse": {
      const sw = obj.stroke ? obj.strokeWidth : 0;
      const common = { fill: obj.fill ?? "none", stroke: obj.stroke ?? "none", strokeWidth: sw, opacity: obj.opacity };
      return (
        <svg width="100%" height="100%" viewBox={view} preserveAspectRatio="none" style={svgStyle}>
          {obj.kind === "rect" ? <rect x={0} y={0} width={obj.w} height={obj.h} {...common} /> : <ellipse cx={obj.w / 2} cy={obj.h / 2} rx={obj.w / 2} ry={obj.h / 2} {...common} />}
        </svg>
      );
    }
    case "line": {
      const ax = obj.p1[0] * obj.w, ay = obj.p1[1] * obj.h, bx = obj.p2[0] * obj.w, by = obj.p2[1] * obj.h;
      const ang = Math.atan2(by - ay, bx - ax);
      const len = Math.max(6, obj.strokeWidth * 4);
      return (
        <svg width="100%" height="100%" viewBox={view} preserveAspectRatio="none" style={svgStyle}>
          <g stroke={obj.stroke} strokeWidth={obj.strokeWidth} strokeLinecap="round" opacity={obj.opacity}>
            <line x1={ax} y1={ay} x2={bx} y2={by} />
            {obj.arrow &&
              [Math.PI * 0.85, -Math.PI * 0.85].map((d) => (
                <line key={d} x1={bx} y1={by} x2={bx + len * Math.cos(ang + d)} y2={by + len * Math.sin(ang + d)} />
              ))}
          </g>
        </svg>
      );
    }
    case "highlight":
      return <div style={{ position: "absolute", inset: 0, background: obj.color, opacity: obj.opacity, mixBlendMode: "multiply" }} />;
  }
}
