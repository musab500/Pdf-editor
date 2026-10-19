// Generates large PDFs for performance measurements (not committed): tests/fixtures/large/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "tests/fixtures/large");
fs.mkdirSync(dir, { recursive: true });

async function textPages(n) {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const p = doc.addPage([595, 842]);
    for (let l = 0; l < 45; l++) p.drawText(`Page ${i + 1} line ${l + 1}: The quick brown fox jumps over the lazy dog 0123456789`, { x: 40, y: 800 - l * 17, size: 10, font: f });
  }
  fs.writeFileSync(path.join(dir, `text-${n}.pdf`), await doc.save());
}

async function imagePages(n, side) {
  // noisy RGB images compress badly → realistic "scanned" sizes
  const doc = await PDFDocument.create();
  const { deflateSync } = await import("node:zlib");
  for (let i = 0; i < n; i++) {
    const raw = Buffer.alloc((side * 3 + 1) * side);
    for (let y = 0; y < side; y++) {
      raw[y * (side * 3 + 1)] = 0;
      for (let x = 0; x < side * 3; x++) raw[y * (side * 3 + 1) + 1 + x] = (Math.random() * 60 + 180 + ((x + y + i) % 7)) | 0;
    }
    const png = makePng(side, side, deflateSync(raw));
    const img = await doc.embedPng(png);
    const p = doc.addPage([595, 842]);
    p.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    p.drawRectangle({ x: 40, y: 40, width: 100, height: 20, color: rgb(0, 0, 0) });
  }
  fs.writeFileSync(path.join(dir, `images-${n}.pdf`), await doc.save());
}

function makePng(w, h, idat) {
  const crc = (buf) => {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
      c = (crc ^ buf[n]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

await textPages(300);
await textPages(1000);
await imagePages(24, 1100);
for (const f of fs.readdirSync(dir)) console.log(f, (fs.statSync(path.join(dir, f)).size / 1048576).toFixed(1), "MB");
