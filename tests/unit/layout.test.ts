import { describe, expect, it } from "vitest";
import { layoutText, visualRuns } from "@/lib/text/layout";
import { faces } from "./helpers";

describe("text layout (shared by preview and export)", async () => {
  const reg = faces();
  const helv = await reg.chain("helvetica", false);
  const naskh = await reg.chain("noto-naskh-arabic", false);

  it("wraps words to the box width and honours explicit newlines", () => {
    const l = layoutText("one two three four five six\nseven", helv, { width: 60, size: 12, lineHeight: 1.2, align: "start", dir: "auto" });
    expect(l.lines.length).toBeGreaterThan(3);
    for (const line of l.lines) expect(line.width).toBeLessThanOrEqual(60.01);
    expect(l.lines[l.lines.length - 1].text).toBe("seven");
  });

  it("breaks over-long words by character", () => {
    const l = layoutText("Supercalifragilisticexpialidocious", helv, { width: 50, size: 12, lineHeight: 1.2, align: "start", dir: "ltr" });
    expect(l.lines.length).toBeGreaterThan(2);
  });

  it("orders mixed Arabic/Latin runs visually (bidi) and right-aligns RTL paragraphs", () => {
    const runs = visualRuns("مرحبا Hello 2024 عالم", naskh, true);
    // visual (left→right) order in an RTL paragraph: عالم | Hello 2024 | مرحبا
    expect(runs.map((r) => [r.text.trim(), r.rtl])).toEqual([["عالم", true], ["Hello 2024", false], ["مرحبا", true]]);
    const l = layoutText("مرحبا", naskh, { width: 200, size: 12, lineHeight: 1.2, align: "start", dir: "auto" });
    expect(l.rtlBase).toBe(true);
    expect(l.lines[0].x + l.lines[0].width).toBeCloseTo(200, 1);
  });

  it("falls back to a font that has the glyphs (Arabic inside a Helvetica box)", () => {
    const l = layoutText("Price: 5 ريال", helv, { width: 300, size: 12, lineHeight: 1.2, align: "left", dir: "ltr" });
    const faceKeys = l.lines[0].runs.map((r) => r.face.key);
    expect(faceKeys).toContain("helvetica:regular");
    expect(faceKeys.some((k) => k.includes("arabic"))).toBe(true);
    expect(l.missingChars).toEqual([]);
  });

  it("mirrors brackets in RTL runs", () => {
    const runs = visualRuns("(نص)", naskh, true);
    const all = runs.map((r) => r.text).join("");
    expect(all).toContain("(");
    expect(all).toContain(")");
  });

  it("reports characters no font can draw", () => {
    const l = layoutText("✓", helv, { width: 100, size: 12, lineHeight: 1.2, align: "left", dir: "ltr" });
    expect(l.missingChars).toEqual(["✓"]);
  });
});
