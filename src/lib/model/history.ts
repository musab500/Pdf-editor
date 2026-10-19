import type { EditorDoc } from "./types";
import { emptyDoc } from "./types";

/**
 * Undo/redo history of EditorDoc snapshots. Snapshots share structure (ops
 * return shallow copies), and never contain PDF/image bytes, so keeping many
 * of them is cheap.
 */

export interface HistoryState {
  present: EditorDoc;
  past: { doc: EditorDoc; label: string }[];
  future: { doc: EditorDoc; label: string }[];
  /** label of the change that produced `present` */
  label: string;
  /** coalescing key + timestamp of the last commit (to merge e.g. typing) */
  lastKey?: string;
  lastAt: number;
  /** increments on every change */
  version: number;
  /** document state at the last download (or load); used to detect unsaved edits */
  savedDoc: EditorDoc;
}

export type HistoryAction =
  | { type: "reset"; doc: EditorDoc }
  | { type: "commit"; doc: EditorDoc; label: string; key?: string; now?: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "markSaved" };

export const MAX_HISTORY = 200;
const COALESCE_MS = 1200;

export const initialHistory = (): HistoryState => {
  const d = emptyDoc();
  return {
  present: d,
  past: [],
  future: [],
  label: "",
  lastAt: 0,
  version: 0,
  savedDoc: d,
  };
};

export function historyReducer(s: HistoryState, a: HistoryAction): HistoryState {
  switch (a.type) {
    case "reset":
      return { ...initialHistory(), present: a.doc, savedDoc: a.doc };
    case "commit": {
      if (a.doc === s.present) return s;
      const now = a.now ?? Date.now();
      if (a.key && a.key === s.lastKey && now - s.lastAt < COALESCE_MS) {
        // merge into the previous step (e.g. consecutive keystrokes in one text box)
        return { ...s, present: a.doc, future: [], lastAt: now, version: s.version + 1 };
      }
      const past = [...s.past, { doc: s.present, label: s.label }];
      if (past.length > MAX_HISTORY) past.shift();
      return { ...s, present: a.doc, past, future: [], label: a.label, lastKey: a.key, lastAt: now, version: s.version + 1 };
    }
    case "undo": {
      if (!s.past.length) return s;
      const prev = s.past[s.past.length - 1];
      return {
        ...s,
        present: prev.doc,
        label: prev.label,
        past: s.past.slice(0, -1),
        future: [{ doc: s.present, label: s.label }, ...s.future],
        lastKey: undefined,
        version: s.version + 1,
      };
    }
    case "redo": {
      if (!s.future.length) return s;
      const next = s.future[0];
      return {
        ...s,
        present: next.doc,
        label: next.label,
        past: [...s.past, { doc: s.present, label: s.label }],
        future: s.future.slice(1),
        lastKey: undefined,
        version: s.version + 1,
      };
    }
    case "markSaved":
      return { ...s, savedDoc: s.present };
  }
}

export const isDirty = (s: HistoryState) => s.present !== s.savedDoc;
