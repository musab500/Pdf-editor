/**
 * Minimal, byte-exact PDF content-stream lexer/parser/serializer.
 *
 * Design goals:
 *  - Never corrupt a stream: every operation keeps the exact byte range it came
 *    from, and untouched operations are re-emitted verbatim.
 *  - Only operations explicitly marked as modified are re-serialized.
 *  - Inline images (BI ... ID <binary> EI) are preserved byte-for-byte.
 */

export type CSObject =
  | { t: "num"; v: number; raw?: string }
  | { t: "str"; bytes: Uint8Array; hex: boolean }
  | { t: "name"; v: string }
  | { t: "arr"; items: CSObject[] }
  | { t: "dict"; entries: [string, CSObject][] }
  | { t: "bool"; v: boolean }
  | { t: "null" };

export interface CSOperation {
  op: string;
  operands: CSObject[];
  /** byte offsets in the source buffer: [start, end) covering operands + operator */
  start: number;
  end: number;
  /** when set, the operation is re-serialized from `op`/`operands` */
  modified?: boolean;
  /** when set, the operation is removed on serialization */
  removed?: boolean;
  /** when set, these operations are emitted instead of this one */
  replacement?: { op: string; operands: CSObject[] }[];
}

export class ContentStreamError extends Error {}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isWS = (c: number) => WS.has(c);
const isDelim = (c: number) => DELIM.has(c);
const isRegular = (c: number) => !isWS(c) && !isDelim(c);

type Tok =
  | { k: "obj"; o: CSObject; s: number }
  | { k: "kw"; v: string; s: number; e: number }
  | { k: "arrS"; s: number }
  | { k: "arrE" }
  | { k: "dictS"; s: number }
  | { k: "dictE" };

class Lexer {
  pos = 0;
  constructor(private b: Uint8Array) {}

  skipWS() {
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWS(c)) this.pos++;
      else if (c === 0x25) {
        // comment
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  next(): Tok | null {
    this.skipWS();
    const b = this.b;
    if (this.pos >= b.length) return null;
    const s = this.pos;
    const c = b[this.pos];
    if (c === 0x28) return { k: "obj", o: this.literalString(), s };
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return { k: "dictS", s };
      }
      return { k: "obj", o: this.hexString(), s };
    }
    if (c === 0x3e) {
      if (b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { k: "dictE" };
      }
      throw new ContentStreamError(`Unexpected '>' at ${this.pos}`);
    }
    if (c === 0x5b) {
      this.pos++;
      return { k: "arrS", s };
    }
    if (c === 0x5d) {
      this.pos++;
      return { k: "arrE" };
    }
    if (c === 0x7b || c === 0x7d) {
      // PostScript calculator braces are not valid in content streams; treat as keyword
      this.pos++;
      return { k: "kw", v: String.fromCharCode(c), s, e: this.pos };
    }
    if (c === 0x2f) return { k: "obj", o: this.name(), s };
    if (c === 0x29) throw new ContentStreamError(`Unbalanced ')' at ${this.pos}`);
    // regular token: number or keyword
    let e = this.pos;
    while (e < b.length && isRegular(b[e])) e++;
    let word = "";
    for (let i = this.pos; i < e; i++) word += String.fromCharCode(b[i]);
    this.pos = e;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const v = parseFloat(word);
      if (!Number.isNaN(v)) return { k: "obj", o: { t: "num", v, raw: word }, s };
    }
    if (word === "true" || word === "false") return { k: "obj", o: { t: "bool", v: word === "true" }, s };
    if (word === "null") return { k: "obj", o: { t: "null" }, s };
    return { k: "kw", v: word, s, e };
  }

  literalString(): CSObject {
    const b = this.b;
    this.pos++; // (
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const n = b[this.pos++];
        switch (n) {
          case 0x6e: out.push(0x0a); break; // n
          case 0x72: out.push(0x0d); break; // r
          case 0x74: out.push(0x09); break; // t
          case 0x62: out.push(0x08); break; // b
          case 0x66: out.push(0x0c); break; // f
          case 0x28: case 0x29: case 0x5c: out.push(n); break;
          case 0x0d:
            if (b[this.pos] === 0x0a) this.pos++;
            break;
          case 0x0a: break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              let v = n - 0x30;
              for (let i = 0; i < 2; i++) {
                const d = b[this.pos];
                if (d >= 0x30 && d <= 0x37) {
                  v = v * 8 + (d - 0x30);
                  this.pos++;
                } else break;
              }
              out.push(v & 0xff);
            } else if (n !== undefined) out.push(n);
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) return { t: "str", bytes: Uint8Array.from(out), hex: false };
        out.push(c);
      } else out.push(c);
    }
    throw new ContentStreamError("Unterminated literal string");
  }

  hexString(): CSObject {
    const b = this.b;
    this.pos++; // <
    const digits: number[] = [];
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = b[this.pos++];
      if (isWS(c)) continue;
      const v = hexVal(c);
      if (v < 0) throw new ContentStreamError(`Bad hex digit at ${this.pos - 1}`);
      digits.push(v);
    }
    if (b[this.pos] !== 0x3e) throw new ContentStreamError("Unterminated hex string");
    this.pos++;
    if (digits.length % 2) digits.push(0);
    const bytes = new Uint8Array(digits.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (digits[2 * i] << 4) | digits[2 * i + 1];
    return { t: "str", bytes, hex: true };
  }

  name(): CSObject {
    const b = this.b;
    this.pos++; // /
    let s = "";
    while (this.pos < b.length && isRegular(b[this.pos])) {
      const c = b[this.pos];
      if (c === 0x23 && this.pos + 2 < b.length) {
        const h = (hexVal(b[this.pos + 1]) << 4) | hexVal(b[this.pos + 2]);
        if (h >= 0) {
          s += String.fromCharCode(h);
          this.pos += 3;
          continue;
        }
      }
      s += String.fromCharCode(c);
      this.pos++;
    }
    return { t: "name", v: s };
  }
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

/** Parse a decoded content stream into operations. Throws ContentStreamError on malformed input. */
export function parseContentStream(bytes: Uint8Array): CSOperation[] {
  const lx = new Lexer(bytes);
  const ops: CSOperation[] = [];
  let operands: CSObject[] = [];
  let opStart = -1;
  const stack: { kind: "arr" | "dict"; items: CSObject[]; s: number }[] = [];

  const push = (o: CSObject, s: number) => {
    if (stack.length) stack[stack.length - 1].items.push(o);
    else {
      if (opStart < 0) opStart = s;
      operands.push(o);
    }
  };

  for (;;) {
    const tok = lx.next();
    if (!tok) break;
    switch (tok.k) {
      case "obj":
        push(tok.o, tok.s);
        break;
      case "arrS":
      case "dictS":
        if (!stack.length && opStart < 0) opStart = tok.s;
        stack.push({ kind: tok.k === "arrS" ? "arr" : "dict", items: [], s: tok.s });
        break;
      case "arrE": {
        const top = stack.pop();
        if (!top || top.kind !== "arr") throw new ContentStreamError("Unbalanced ']'");
        push({ t: "arr", items: top.items }, top.s);
        break;
      }
      case "dictE": {
        const top = stack.pop();
        if (!top || top.kind !== "dict") throw new ContentStreamError("Unbalanced '>>'");
        const entries: [string, CSObject][] = [];
        for (let i = 0; i + 1 < top.items.length; i += 2) {
          const k = top.items[i];
          if (k.t !== "name") throw new ContentStreamError("Dictionary key is not a name");
          entries.push([k.v, top.items[i + 1]]);
        }
        push({ t: "dict", entries }, top.s);
        break;
      }
      case "kw": {
        if (stack.length) throw new ContentStreamError(`Operator '${tok.v}' inside array/dict`);
        const start = opStart >= 0 ? opStart : tok.s;
        if (tok.v === "BI") {
          // inline image: find "ID", then binary data until whitespace + "EI" + delimiter
          const idPos = findInlineImageEnd(bytes, tok.e);
          ops.push({ op: "BI", operands: [], start, end: idPos });
          lx.pos = idPos;
        } else {
          ops.push({ op: tok.v, operands, start, end: tok.e });
        }
        operands = [];
        opStart = -1;
        break;
      }
    }
  }
  if (stack.length) throw new ContentStreamError("Unterminated array or dictionary");
  // Trailing operands without operator are tolerated (some producers emit them) but preserved.
  if (operands.length) ops.push({ op: "", operands, start: opStart, end: bytes.length });
  return ops;
}

function findInlineImageEnd(b: Uint8Array, from: number): number {
  // locate " ID" keyword
  let i = from;
  let idEnd = -1;
  while (i < b.length - 1) {
    if (b[i] === 0x49 && b[i + 1] === 0x44 && (i === 0 || isWS(b[i - 1]) || isDelim(b[i - 1])) && (i + 2 >= b.length || isWS(b[i + 2]))) {
      idEnd = i + 3; // skip single whitespace after ID
      break;
    }
    i++;
  }
  if (idEnd < 0) throw new ContentStreamError("Inline image without ID");
  for (let j = idEnd; j < b.length - 1; j++) {
    if (
      b[j] === 0x45 &&
      b[j + 1] === 0x49 &&
      isWS(b[j - 1]) &&
      (j + 2 >= b.length || isWS(b[j + 2]) || isDelim(b[j + 2]))
    ) {
      return j + 2;
    }
  }
  throw new ContentStreamError("Inline image without EI");
}

// ---------------------------------------------------------------- serializer

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(4);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

function hexOf(bytes: Uint8Array): string {
  let s = "<";
  for (const x of bytes) s += x.toString(16).padStart(2, "0");
  return s + ">";
}

function nameOf(v: string): string {
  let s = "/";
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || c === 0x23 || isDelim(c)) s += "#" + c.toString(16).padStart(2, "0");
    else s += v[i];
  }
  return s;
}

export function serializeObject(o: CSObject): string {
  switch (o.t) {
    case "num":
      return fmtNum(o.v);
    case "str":
      return hexOf(o.bytes);
    case "name":
      return nameOf(o.v);
    case "arr":
      return "[" + o.items.map(serializeObject).join(" ") + "]";
    case "dict":
      return "<<" + o.entries.map(([k, v]) => nameOf(k) + " " + serializeObject(v)).join(" ") + ">>";
    case "bool":
      return o.v ? "true" : "false";
    case "null":
      return "null";
  }
}

const enc = new TextEncoder();

/**
 * Serialize operations back into a content stream. Unmodified operations are
 * copied verbatim from `source`, including the whitespace that preceded them.
 */
export function serializeContentStream(source: Uint8Array, ops: CSOperation[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const add = (c: Uint8Array) => {
    chunks.push(c);
    total += c.length;
  };
  for (const op of ops) {
    if (op.removed) continue;
    if (op.replacement) {
      for (const r of op.replacement) {
        add(enc.encode((r.operands.length ? r.operands.map(serializeObject).join(" ") + " " : "") + r.op + "\n"));
      }
    } else if (op.modified) {
      const s = (op.operands.length ? op.operands.map(serializeObject).join(" ") + " " : "") + op.op + "\n";
      add(enc.encode(s));
    } else {
      add(source.subarray(op.start, op.end));
      add(NL);
    }
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
const NL = new Uint8Array([0x0a]);
