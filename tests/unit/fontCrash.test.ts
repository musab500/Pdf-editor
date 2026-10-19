import { describe, expect, it } from "vitest";
import { exportPdf } from "@/lib/pdf/exporter";
import { layoutText } from "@/lib/text/layout";
import { FIX, docWith, faces, pagesOf, textObj } from "./helpers";
import { extractText } from "./pdfText";

// fontkit throws "Cannot read properties of null (reading 'xCoordinate')" for an Arabic mark without base
const NASTY = [" ٍ", "ٍ", "كلٍّ من", "ً ّ ٍ", "مرحبا ٍ test", "، ٍ."];

describe("text shaping never crashes", () => {
  it("lays out and exports isolated Arabic marks with every bundled font", async () => {
    const reg = faces();
    for (const family of ["noto-sans-arabic", "noto-naskh-arabic", "noto-sans", "helvetica"] as const) {
      for (const bold of [false, true]) {
        const chain = await reg.chain(family, bold);
        for (const t of NASTY) expect(() => layoutText(t, chain, { width: 200, size: 12, lineHeight: 1.2, align: "start", dir: "auto" })).not.toThrow();
      }
    }
    const doc = docWith(pagesOf("s", 1), { objects: NASTY.map((t, i) => textObj("p0", t, { y: 100 + i * 40, family: "noto-sans-arabic" })) });
    const r = await exportPdf({ primarySourceId: "s", sources: { s: FIX("simple.pdf") }, doc, assets: {} }, faces());
    expect((await extractText(r.bytes))[0]).toContain("test");
  });
});
