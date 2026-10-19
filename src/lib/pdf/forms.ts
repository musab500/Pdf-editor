import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFTextField,
  PDFButton,
  PDFSignature,
} from "pdf-lib";
import type { FormValue } from "../model/types";

export type FieldKind = "text" | "checkbox" | "radio" | "dropdown" | "optionlist" | "button" | "signature" | "unknown";

export interface FieldWidgetInfo {
  pageIndex: number;
  /** rect in PDF user space [x0,y0,x1,y1] */
  rect: [number, number, number, number];
  /** for radio buttons: the export value this widget represents */
  option?: string;
}

export interface FieldInfo {
  name: string;
  kind: FieldKind;
  value: FormValue;
  options: string[];
  readOnly: boolean;
  multiline: boolean;
  multiSelect: boolean;
  maxLength?: number;
  widgets: FieldWidgetInfo[];
}

function kindOf(f: PDFField): FieldKind {
  if (f instanceof PDFTextField) return "text";
  if (f instanceof PDFCheckBox) return "checkbox";
  if (f instanceof PDFRadioGroup) return "radio";
  if (f instanceof PDFDropdown) return "dropdown";
  if (f instanceof PDFOptionList) return "optionlist";
  if (f instanceof PDFButton) return "button";
  if (f instanceof PDFSignature) return "signature";
  return "unknown";
}

/** Map of annotation ref → page index for the document's pages. */
export function annotationPageIndex(doc: PDFDocument): Map<string, number> {
  const m = new Map<string, number>();
  doc.getPages().forEach((p, i) => {
    const annots = p.node.Annots();
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) {
      const r = annots.get(k);
      if (r instanceof PDFRef) m.set(r.toString(), i);
    }
  });
  return m;
}

export function readFields(doc: PDFDocument): FieldInfo[] {
  let fields: PDFField[];
  try {
    fields = doc.getForm().getFields();
  } catch {
    return [];
  }
  const annotPages = annotationPageIndex(doc);
  const pageRefs = doc.getPages().map((p) => p.ref.toString());
  const out: FieldInfo[] = [];
  for (const f of fields) {
    const kind = kindOf(f);
    let value: FormValue = "";
    let options: string[] = [];
    let multiline = false;
    let multiSelect = false;
    let maxLength: number | undefined;
    try {
      if (f instanceof PDFTextField) {
        value = f.getText() ?? "";
        multiline = f.isMultiline();
        maxLength = f.getMaxLength();
      } else if (f instanceof PDFCheckBox) value = f.isChecked();
      else if (f instanceof PDFRadioGroup) {
        value = f.getSelected() ?? "";
        options = f.getOptions();
      } else if (f instanceof PDFDropdown) {
        value = f.getSelected()[0] ?? "";
        options = f.getOptions();
      } else if (f instanceof PDFOptionList) {
        value = f.getSelected();
        options = f.getOptions();
        multiSelect = f.isMultiselect();
      }
    } catch {
      /* malformed field – keep defaults */
    }
    const widgets: FieldWidgetInfo[] = [];
    const radioOpts = f instanceof PDFRadioGroup ? f.getOptions() : [];
    f.acroField.getWidgets().forEach((w, wi) => {
      const ref = doc.context.getObjectRef(w.dict);
      let pageIndex = ref ? annotPages.get(ref.toString()) : undefined;
      if (pageIndex === undefined) {
        const p = w.P();
        if (p) pageIndex = pageRefs.indexOf(p.toString());
      }
      if (pageIndex === undefined || pageIndex < 0) return;
      const r = w.getRectangle();
      widgets.push({
        pageIndex,
        rect: [r.x, r.y, r.x + r.width, r.y + r.height],
        // with an /Opt array the widgets' on-states are indices; getOptions() gives the export values
        option: f instanceof PDFRadioGroup ? (radioOpts[wi] ?? w.getOnValue()?.decodeText()) : undefined,
      });
    });
    out.push({ name: f.getName(), kind, value, options, readOnly: f.isReadOnly(), multiline, multiSelect, maxLength, widgets });
  }
  return out;
}

const safe = (fn: () => void) => {
  try {
    fn();
  } catch {
    /* appearance generation failed – the value is still stored */
  }
};

const WIN_ANSI_RE = /^[ -~ -ÿ\n\r\t]*$/;

/**
 * Write values into the form. Returns names of text fields whose value needs a
 * Unicode font for its appearance (handled by the caller).
 */
export function applyFormValues(doc: PDFDocument, values: Record<string, FormValue>, warn: (msg: string) => void = () => {}): string[] {
  const form = doc.getForm();
  const needsUnicode: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    let f: PDFField | undefined;
    try {
      f = form.getField(name);
    } catch {
      warn(`Form field “${name}” no longer exists; its value was not saved.`);
      continue;
    }
    try {
      applyOne(f, name, value);
    } catch (e) {
      warn(`Form field “${name}” could not be set: ${(e as Error).message}`);
    }
  }
  return needsUnicode;

  function applyOne(f: PDFField, name: string, value: FormValue) {
    if (f instanceof PDFTextField && typeof value === "string") {
      f.setText(value || undefined);
      if (!WIN_ANSI_RE.test(value)) needsUnicode.push(name);
      else safe(() => f.defaultUpdateAppearances(form.getDefaultFont()));
    } else if (f instanceof PDFCheckBox) {
      if (value) f.check();
      else f.uncheck();
    } else if (f instanceof PDFRadioGroup && typeof value === "string") {
      if (value) f.select(value);
      else f.clear();
    } else if (f instanceof PDFDropdown && typeof value === "string") {
      if (value) f.select(value);
      else f.clear();
      if (WIN_ANSI_RE.test(value)) safe(() => f.defaultUpdateAppearances(form.getDefaultFont()));
      else needsUnicode.push(name);
    } else if (f instanceof PDFOptionList && Array.isArray(value)) {
      if (value.length) f.select(value);
      else f.clear();
      if (value.every((v) => WIN_ANSI_RE.test(v))) safe(() => f.defaultUpdateAppearances(form.getDefaultFont()));
      else needsUnicode.push(name);
    }
  }
}
