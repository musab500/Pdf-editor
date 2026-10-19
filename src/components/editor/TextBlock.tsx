"use client";
import { useEffect, useMemo, useState } from "react";
import type { Face, FaceRegistry, FontFamilyId } from "@/lib/text/fontFaces";
import { layoutText, type TextLayout } from "@/lib/text/layout";
import type { TextStyle } from "@/lib/model/types";

/** Load the face chain (chosen family + fallbacks) for previews. */
export function useFaceChain(faces: FaceRegistry, family: FontFamilyId, bold: boolean): Face[] | null {
  const [chain, setChain] = useState<{ key: string; faces: Face[] } | null>(null);
  const key = `${family}:${bold}`;
  useEffect(() => {
    let alive = true;
    faces.chain(family, bold).then((f) => alive && setChain({ key, faces: f }));
    return () => {
      alive = false;
    };
  }, [faces, family, bold, key]);
  return chain && chain.key === key ? chain.faces : null;
}

export function useLayout(faces: FaceRegistry, style: TextStyle, text: string, width: number): TextLayout | null {
  const chain = useFaceChain(faces, style.family, style.bold);
  return useMemo(
    () =>
      chain && chain.length
        ? layoutText(text, chain, { width, size: style.size, lineHeight: style.lineHeight, align: style.align, dir: style.dir })
        : null,
    [chain, text, width, style.size, style.lineHeight, style.align, style.dir],
  );
}

function cssFamily(face: Face) {
  return `${face.css}, 'PE Noto Sans', 'PE Noto Sans Arabic', sans-serif`;
}

/**
 * Render laid-out text as SVG in page points. Each run is centred on its
 * computed position so the browser's own shaping cannot shift line layout.
 */
export function TextBlockSvg({
  layout,
  style,
  width,
  height,
  padding,
}: {
  layout: TextLayout | null;
  style: TextStyle;
  width: number;
  height: number;
  padding: number;
}) {
  if (!layout) return null;
  const maxY = Math.max(height, layout.height + padding * 2);
  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${Math.max(width, 0.1)} ${Math.max(height, 0.1)}`}
      preserveAspectRatio="none"
      style={{ overflow: "visible", position: "absolute", inset: 0, pointerEvents: "none" }}
      aria-hidden
    >
      {layout.lines.map((line, li) =>
        line.runs.map((run, ri) => (
          <text
            key={`${li}-${ri}`}
            x={padding + line.x + run.x + run.width / 2}
            y={padding + line.baseline}
            textAnchor="middle"
            direction={run.rtl ? "rtl" : "ltr"}
            unicodeBidi="bidi-override"
            fontFamily={cssFamily(run.face)}
            fontSize={style.size}
            fontWeight={style.bold ? 700 : 400}
            fontStyle={style.italic ? "italic" : "normal"}
            fill={style.color}
            textLength={run.width > 0 && run.text.length > 1 ? run.width : undefined}
            lengthAdjust="spacingAndGlyphs"
            style={{ whiteSpace: "pre" }}
          >
            {run.text}
          </text>
        )),
      )}
      {maxY > height + 0.5 && <rect x={0} y={height} width={width} height={0} />}
    </svg>
  );
}
