import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFContext,
  decodePDFRawStream,
} from "pdf-lib";

/** Small helpers around pdf-lib's low-level object model. */

export const N = (s: string) => PDFName.of(s);

export function lookup(ctx: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  if (obj instanceof PDFRef) return ctx.lookup(obj);
  return obj;
}

export function dictGet(dict: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!dict) return undefined;
  return dict.lookup(N(key));
}

export function asDict(o: PDFObject | undefined): PDFDict | undefined {
  return o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : undefined;
}

export function asArray(o: PDFObject | undefined): PDFArray | undefined {
  return o instanceof PDFArray ? o : undefined;
}

export function asNumber(o: PDFObject | undefined): number | undefined {
  return o instanceof PDFNumber ? o.asNumber() : undefined;
}

export function asName(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined;
}

export function asText(o: PDFObject | undefined): string | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  return undefined;
}

export function numbersOf(ctx: PDFContext, arr: PDFArray | undefined): number[] {
  if (!arr) return [];
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = lookup(ctx, arr.get(i));
    out.push(v instanceof PDFNumber ? v.asNumber() : 0);
  }
  return out;
}

/** Returns the decoded (unfiltered) bytes of a stream. Throws for unsupported filters. */
export function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) {
    if (!stream.dict.has(N("Filter"))) return stream.contents;
    return decodePDFRawStream(stream).decode();
  }
  const anyStream = stream as unknown as { getUnencodedContents?: () => Uint8Array };
  if (typeof anyStream.getUnencodedContents === "function") return anyStream.getUnencodedContents();
  return stream.getContents();
}

/** Concatenate all content streams of a page into one decoded buffer. */
export function pageContentBytes(ctx: PDFContext, contents: PDFObject | undefined): Uint8Array {
  const resolved = lookup(ctx, contents);
  const streams: PDFStream[] = [];
  if (resolved instanceof PDFStream) streams.push(resolved);
  else if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) {
      const s = lookup(ctx, resolved.get(i));
      if (s instanceof PDFStream) streams.push(s);
    }
  }
  const parts = streams.map(streamBytes);
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 0x0a; // streams are concatenated with whitespace (PDF 32000 §7.8.2)
  }
  return out;
}
