"use client";
import type { FieldInfo } from "@/lib/pdf/forms";
import type { FormValue } from "@/lib/model/types";

/**
 * Interactive AcroForm fields of the original document, drawn over the page.
 * Values are stored in the editor state and written into the real form fields on export.
 */
export function FormLayer({
  fields,
  pageIndex,
  viewBox,
  scale,
  values,
  disabled,
  onChange,
}: {
  fields: FieldInfo[];
  pageIndex: number;
  viewBox: [number, number, number, number];
  scale: number;
  values: Record<string, FormValue>;
  disabled: boolean;
  onChange: (name: string, v: FormValue, typing?: boolean) => void;
}) {
  const [x0, , , y1] = viewBox;
  const items = fields.flatMap((f) => f.widgets.filter((w) => w.pageIndex === pageIndex).map((w, i) => ({ f, w, i })));
  if (!items.length) return null;
  return (
    <div className="absolute inset-0" style={{ zIndex: 3, pointerEvents: "none" }}>
      {items.map(({ f, w, i }) => {
        const style = {
          left: (w.rect[0] - x0) * scale,
          top: (y1 - w.rect[3]) * scale,
          width: (w.rect[2] - w.rect[0]) * scale,
          height: (w.rect[3] - w.rect[1]) * scale,
          fontSize: Math.max(8, Math.min(14, (w.rect[3] - w.rect[1]) * 0.6)) * scale,
        };
        const v = values[f.name] ?? f.value;
        const common = {
          className: "absolute pointer-events-auto border border-sky-400/70 bg-sky-100/40 text-black outline-none focus:bg-sky-100/80",
          style,
          disabled: disabled || f.readOnly,
          title: f.name,
          "aria-label": `Form field ${f.name}`,
          "data-field": f.name,
          onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
          onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
        };
        const key = `${f.name}-${i}`;
        switch (f.kind) {
          case "text":
            return f.multiline ? (
              <textarea key={key} {...common} value={String(v ?? "")} maxLength={f.maxLength} dir="auto" onChange={(e) => onChange(f.name, e.target.value, true)} style={{ ...style, resize: "none", padding: 2 }} />
            ) : (
              <input key={key} {...common} type="text" value={String(v ?? "")} maxLength={f.maxLength} dir="auto" onChange={(e) => onChange(f.name, e.target.value, true)} style={{ ...style, padding: "0 2px" }} />
            );
          case "checkbox":
            return (
              <input key={key} {...common} type="checkbox" checked={!!v} onChange={(e) => onChange(f.name, e.target.checked)} className={common.className + " m-0 accent-sky-600"} />
            );
          case "radio":
            return (
              <input key={key} {...common} type="radio" name={`radio-${f.name}`} checked={v === w.option} onChange={() => onChange(f.name, w.option ?? "")} className={common.className + " m-0 accent-sky-600"} />
            );
          case "dropdown":
            return (
              <select key={key} {...common} value={String(v ?? "")} onChange={(e) => onChange(f.name, e.target.value)}>
                <option value="">—</option>
                {f.options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            );
          case "optionlist":
            return (
              <select
                key={key}
                {...common}
                multiple={f.multiSelect}
                value={Array.isArray(v) ? v : [String(v ?? "")]}
                onChange={(e) => onChange(f.name, Array.from(e.target.selectedOptions).map((o) => o.value))}
              >
                {f.options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            );
          default:
            return (
              <div key={key} className="absolute border border-dashed border-gray-400/70" style={style} title={`${f.name} (${f.kind} fields cannot be filled here)`} />
            );
        }
      })}
    </div>
  );
}
