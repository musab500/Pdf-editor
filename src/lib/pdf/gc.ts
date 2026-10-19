import { PDFArray, PDFContext, PDFDict, PDFNull, PDFObject, PDFRef, PDFStream } from "pdf-lib";

function forEachChild(obj: PDFObject, fn: (child: PDFObject, set: (v: PDFObject | undefined) => void) => void) {
  if (obj instanceof PDFStream) obj = obj.dict;
  if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) fn(v, (nv) => (nv === undefined ? obj.delete(k) : obj.set(k, nv)));
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const idx = i;
      fn(obj.get(idx), (nv) => obj.set(idx, nv ?? PDFNull));
    }
  }
}

/**
 * Remove references to deleted pages: link/outline destinations get a null
 * page, /P and /Pg back-references are dropped. Without this, deleted pages
 * would stay reachable and their content would remain inside the file.
 */
export function detachRemovedPages(ctx: PDFContext, removed: Set<string>) {
  if (!removed.size) return;
  const isRemoved = (o: PDFObject | undefined) => o instanceof PDFRef && removed.has(o.toString());
  const visit = (obj: PDFObject, depth: number) => {
    if (depth > 64) return;
    const target = obj instanceof PDFStream ? obj.dict : obj;
    if (target instanceof PDFArray && target.size() >= 2 && isRemoved(target.get(0))) target.set(0, PDFNull);
    if (target instanceof PDFDict) {
      for (const [k, v] of target.entries()) {
        const key = k.decodeText();
        if ((key === "P" || key === "Pg" || key === "Dest" || key === "D") && isRemoved(v)) target.delete(k);
      }
    }
    forEachChild(target, (child) => {
      if (!(child instanceof PDFRef)) visit(child, depth + 1);
    });
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (removed.has(ref.toString())) continue;
    visit(obj, 0);
  }
}

/** Delete every indirect object that is not reachable from the trailer. */
export function collectGarbage(ctx: PDFContext): number {
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo;
  for (const o of [t.Root, t.Info, t.Encrypt, t.ID]) if (o) stack.push(o);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      const key = o.toString();
      if (reachable.has(key)) continue;
      reachable.add(key);
      const target = ctx.lookup(o);
      if (target) stack.push(target);
      continue;
    }
    forEachChild(o, (child) => stack.push(child));
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.toString())) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}
