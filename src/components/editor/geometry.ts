/** Screen ↔ page coordinate helpers. Page space: unrotated, top-left origin, points. */

export const PX_PER_PT = 96 / 72;

/** rotate a vector clockwise (screen coordinates, y down) */
export function rotCW(x: number, y: number, deg: number): [number, number] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [x * c - y * s, x * s + y * c];
}

export interface PageFrame {
  el: HTMLElement; // outer (rotated-bounding) element
  w: number; // page width in points (unrotated)
  h: number;
  scale: number; // px per point
  rot: number; // clockwise display rotation
}

export function clientToPage(f: PageFrame, clientX: number, clientY: number): { x: number; y: number } {
  const r = f.el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const [lx, ly] = rotCW(clientX - cx, clientY - cy, -f.rot);
  return { x: (lx + (f.w * f.scale) / 2) / f.scale, y: (ly + (f.h * f.scale) / 2) / f.scale };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

/**
 * Resize a (possibly rotated) box by dragging one of its handles.
 * sx/sy ∈ {-1,0,1}: which edge/corner is dragged in the box's own frame.
 */
export function resizeBox(b: Box, sx: number, sy: number, p: { x: number; y: number }, min = 4, keepAspect = false): Box {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const [ax, ay] = rotCW((-sx * b.w) / 2, (-sy * b.h) / 2, b.rotation);
  const anchor = { x: cx + ax, y: cy + ay };
  const [dx, dy] = rotCW(p.x - anchor.x, p.y - anchor.y, -b.rotation);
  let w = sx ? Math.max(min, sx * dx) : b.w;
  let h = sy ? Math.max(min, sy * dy) : b.h;
  if (keepAspect && sx && sy) {
    const ratio = b.w / b.h;
    if (w / h > ratio) h = w / ratio;
    else w = h * ratio;
  }
  // the anchor is the opposite corner/edge midpoint; the new centre sits half the new size away from it
  const [ox, oy] = rotCW((sx * w) / 2, (sy * h) / 2, b.rotation);
  const centre = { x: anchor.x + ox, y: anchor.y + oy };
  return { x: centre.x - w / 2, y: centre.y - h / 2, w, h, rotation: b.rotation };
}

/** Axis-aligned rectangle from two points. */
export function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** A box that appears upright on a page displayed with clockwise rotation `pageRot`, covering the AABB `r`. */
export function uprightBox(r: { x: number; y: number; w: number; h: number }, pageRot: number): Box {
  const rotation = (360 - pageRot) % 360;
  const swap = rotation === 90 || rotation === 270;
  const w = swap ? r.h : r.w;
  const h = swap ? r.w : r.h;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rotation };
}
