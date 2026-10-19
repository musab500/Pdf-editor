import { describe, expect, it } from "vitest";
import { parseContentStream, serializeContentStream, ContentStreamError } from "@/lib/pdf/contentStream";
import { parseToUnicode, glyphNameToUnicode } from "@/lib/pdf/fontInfo";

const enc = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 0xff)); // latin1
const dec = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("content stream parser", () => {
  it("parses operators, operands, strings, arrays and dicts", () => {
    const src = enc("q 1 0 0 1 10 20 cm BT /F1 12 Tf (Hello \\(x\\) \\101) Tj [(A) -120 <0042>] TJ ET /P <</MCID 3>> BDC EMC Q");
    const ops = parseContentStream(src);
    expect(ops.map((o) => o.op)).toEqual(["q", "cm", "BT", "Tf", "Tj", "TJ", "ET", "BDC", "EMC", "Q"]);
    const tj = ops[4].operands[0];
    expect(tj.t === "str" && dec(tj.bytes)).toBe("Hello (x) A");
    const arr = ops[5].operands[0];
    expect(arr.t).toBe("arr");
    if (arr.t === "arr") {
      expect(arr.items).toHaveLength(3);
      expect(arr.items[1]).toMatchObject({ t: "num", v: -120 });
      expect(arr.items[2].t === "str" && arr.items[2].hex).toBe(true);
    }
    expect(ops[7].operands[1].t).toBe("dict");
  });

  it("preserves inline images byte for byte", () => {
    const bin = "\u0000ÿ EI\u0001x";
    const src = enc(`q BI /W 2 /H 1 /BPC 8 /CS /G ID ${bin} EI Q`);
    // binary data containing " EI" not followed by whitespace must not end the image early
    const ops = parseContentStream(src);
    expect(ops.map((o) => o.op)).toEqual(["q", "BI", "Q"]);
    const out = serializeContentStream(src, ops);
    expect(dec(out)).toContain(`ID ${bin} EI`);
  });

  it("serializes untouched operations verbatim and only rewrites modified ones", () => {
    const src = enc("BT /F1 12 Tf 72 700 Td (old) Tj ET\n0.5 g 10 10 100 50 re f");
    const ops = parseContentStream(src);
    ops[3].modified = true;
    ops[3].operands = [{ t: "str", bytes: enc("new"), hex: false }];
    const out = dec(serializeContentStream(src, ops));
    expect(out).toContain("<6e6577> Tj");
    expect(out).toContain("72 700 Td");
    expect(out).toContain("10 10 100 50 re");
    expect(out).not.toContain("(old)");
  });

  it("rejects malformed streams instead of guessing", () => {
    expect(() => parseContentStream(enc("BT (unterminated Tj ET"))).toThrow(ContentStreamError);
    expect(() => parseContentStream(enc("[1 2 Tj"))).toThrow(ContentStreamError);
  });

  it("handles comments, names with # escapes and real numbers", () => {
    const ops = parseContentStream(enc("% comment\n/A#20B gs -.5 .25 +3. Td"));
    expect(ops[0].operands[0]).toMatchObject({ t: "name", v: "A B" });
    expect(ops[1].operands.map((o) => (o.t === "num" ? o.v : null))).toEqual([-0.5, 0.25, 3]);
  });
});

describe("ToUnicode CMaps", () => {
  it("parses bfchar and both bfrange forms", () => {
    const cmap = enc(`1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0003> <0020> <0024> <00660069> endbfchar
2 beginbfrange <0010> <0012> <0041> <0020> <0021> [<0627> <0644>] endbfrange`);
    const r = parseToUnicode(cmap);
    expect(r.codeLengths).toEqual([2]);
    expect(r.map.get(3)).toBe(" ");
    expect(r.map.get(0x24)).toBe("fi");
    expect(r.map.get(0x11)).toBe("B");
    expect(r.map.get(0x21)).toBe("ل");
  });

  it("maps glyph names", () => {
    expect(glyphNameToUnicode("space")).toBe(" ");
    expect(glyphNameToUnicode("Aacute")).toBe("Á");
    expect(glyphNameToUnicode("uni0627")).toBe("ا");
    expect(glyphNameToUnicode("u1F600")).toBe("😀");
    expect(glyphNameToUnicode("a.sc")).toBe("a");
  });
});
