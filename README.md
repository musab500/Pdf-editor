# PDF Editor — local & private

A personal PDF editor that runs entirely in the browser. Open a PDF, edit existing text, add text/images/signatures/drawings, manage pages, fill forms and download the result. Documents are **never uploaded**: the server (e.g. Vercel) only delivers the app; all PDF processing happens in your browser tab.

Built with Next.js (App Router) + React + TypeScript (strict), PDF.js (`pdfjs-dist`) for rendering/text, `pdf-lib` + `@pdf-lib/fontkit` for writing PDFs, Tesseract.js for optional OCR, Tailwind CSS, Lucide icons, Vitest and Playwright.

---

## Features

| Area | What works |
| --- | --- |
| Open | Open button, drag & drop (several files = open first, append the rest), file-type/size validation, clear errors for empty/corrupt/non-PDF files, password prompt for encrypted PDFs |
| View | Continuous scrolling, lazy page rendering, thumbnails, zoom (menu, buttons, Ctrl+wheel, Ctrl +/−/0, fit width), page navigation (thumbnails, PageUp/PageDown), light/dark theme |
| **Edit original text (native, Mode A)** | Click a line of existing text, type the replacement; the PDF's own text operators are rewritten in the original font. Only offered when it is safe (see below); every applied edit is re-read with PDF.js to verify it |
| **Replace text (visual, Mode B)** | Click a line or drag over any area (also scanned pages): the area is covered with a sampled background colour and new text is drawn on top, with font, size, colour, alignment, multi-line and Arabic/RTL support. Clearly labelled as *covering, not removing* |
| Add content | Text boxes (fonts, size, colour, bold/italic, alignment, direction, line height, custom .ttf/.otf fonts), images (PNG/JPEG/WebP/GIF/BMP/SVG), drawn or imported signatures, freehand drawing, highlights (area or selected text), rectangles, ellipses, lines, arrows. Move, resize, delete, duplicate, z-order, copy/paste, arrow-key nudging |
| Pages | Insert blank page, delete (with confirmation), rotate, duplicate, reorder (drag & drop or buttons), insert pages from another PDF, merge PDFs, split into page ranges (ZIP), export selected pages |
| Forms | AcroForm text fields, checkboxes, radio buttons, dropdowns and list boxes are filled in place and saved as real form values (Unicode/Arabic values get a generated appearance) |
| Search & copy | Search across the text layer, OCR results and added text; select and copy page text; highlight selected text |
| OCR (optional) | Tesseract.js (English + Arabic), self-hosted, runs locally; recognised lines can be searched, copied and used for visual replacement |
| History | Undo/redo for objects, text edits, native edits, form values and all page operations (Ctrl+Z / Ctrl+Y) |
| Export | Preview of the exported file, automatic verification (reopened with PDF.js: page count, sizes, rotation, added/edited text, images), editable file name (default `name-edited.pdf`), unsaved-changes warning |

### Keyboard shortcuts

`Ctrl+O` open · `Ctrl+S` download · `Ctrl+Z`/`Ctrl+Y` undo/redo · `Ctrl+C`/`Ctrl+V` copy/paste objects · `Del` delete · arrows nudge (Shift = 10 pt) · `Esc` deselect · tools: `V` select, `S` select text, `E` edit text, `R` replace, `T` text, `D` draw, `H` highlight.

---

## True text editing vs. visual replacement

PDF pages do not contain "paragraphs"; they contain drawing instructions such as *"select font F1 at 12 pt, move to (72, 700), draw these glyph codes"*. `pdf-lib` cannot edit existing text and PDF.js only *reads* it, so this project includes its own content-stream parser and font analysis (`src/lib/pdf/contentStream.ts`, `fontInfo.ts`, `textAnalysis.ts`, `nativeEdit.ts`).

**Native editing (Edit text tool)** rewrites the text-showing operators (`Tj`, `TJ`, `'`, `"`) of one line. The new text is re-encoded with the **original font**; the remaining operators of the line are replaced by an equivalent horizontal shift so all following content stays exactly in place. Nothing else in the content stream changes, and the old content stream is removed from the file on export. It is only allowed when all of this holds:

- the page content parses cleanly and the line is visible text (not an invisible OCR layer);
- the font is a simple font (Type 1/TrueType) or a `Identity-H` CID font with a `ToUnicode` map — not Type 3, not a custom CMap;
- every original character could be identified, and every new character exists in the font: standard and non-embedded fonts are always complete; for **subset** fonts the character must already be drawn somewhere in the document with that font (otherwise its glyph is probably not in the file);
- the text is a single line in a non-complex script (Arabic, Hebrew and Indic text is stored as shaped glyphs in visual order and is refused).

If any check fails, the panel explains why and offers **visual replacement**. After applying, the page is rebuilt, reopened with PDF.js and the new text must be readable; otherwise the edit is rejected. Text is not reflowed: a longer replacement can overlap the following text (a warning appears).

**Visual replacement (Replace tool)** draws a filled rectangle over the area and new text on top. **The original text is still inside the file** (it can be selected, searched, extracted). It is **not redaction** — never use it to hide confidential information. This app does not offer true redaction.

---

## Privacy

- All processing happens in the browser (PDF.js, pdf-lib, fontkit, Tesseract.js; export and OCR run in Web Workers). There are no API routes, no upload endpoints, no database, no analytics, no telemetry, no cloud storage and no AI services.
- All runtime assets (PDF.js worker/CMaps/fonts, Tesseract core and language data, the bundled Noto fonts) are copied into `public/` at install/build time and served from the app's own origin — no CDN requests.
- A strict **Content-Security-Policy** (`next.config.ts`) only allows connections to the app's own origin, so document data cannot be sent elsewhere even by mistake.
- Documents live only in memory; nothing is written to `localStorage`/IndexedDB (only the theme preference is stored). Object URLs are revoked and PDF.js documents are destroyed when a new file is opened.
- PDF JavaScript is never executed (PDF.js scripting is disabled; XFA is off).
- The automated test `tests/e2e/privacy-ocr.spec.ts` records every network request during a session (open, OCR, add text, export) and asserts that all requests go to the app origin and none carries a body.

This describes the app as built; browser extensions or a modified deployment could behave differently.

---

## Getting started

Requirements: Node.js 20.9+ (tested with Node 22) and npm.

```bash
npm install          # also copies PDF.js / Tesseract assets into public/
npm run dev          # http://localhost:3000
npm run build        # production build (webpack, needed for the export Web Worker)
npm start            # serve the production build
```

### Tests

```bash
npm test                         # Vitest unit tests (engine, layout, export, forms, history, helpers)
npx playwright install chromium  # once, if you have no Chromium for Playwright
npm run build && npm run test:e2e   # Playwright end-to-end tests against the production build
npm run lint && npm run typecheck
```

Test fixtures live in `tests/fixtures` and can be regenerated with `npm run fixtures` (needs `pdftoppm` and `qpdf` for the scanned and encrypted fixtures): simple, multiple fonts, Arabic, tables + images, scanned, form fields + link annotation, mixed page sizes/rotations/crop box, plus empty, corrupt, non-PDF and password-protected files.

Results at the time of writing: **48 unit tests and 19 end-to-end tests pass**; the 3 performance tests are skipped unless `PERF=1` (they also pass).

### Performance

Measured in headless Chromium (Playwright, Linux container) with `node scripts/make-large.mjs && PERF=1 npx playwright test perf`:

| File | Open + first page | Export + verify | JS heap |
| --- | --- | --- | --- |
| 300 text pages, 0.3 MB | 1.5 s | 1.4 s | 43 MB |
| 1000 text pages, 1.1 MB | 2.1 s | 2.7 s | 89 MB |
| 24 scanned-image pages, 63 MB | 1.4 s | 1.7 s | 142 MB |

Based on this the app warns above **100 MB** or **1000 pages** and refuses files above **200 MB** (the browser holds several copies of the bytes during export). A typical Windows laptop should be in the same range; very large scans mainly cost memory.

---

## Deploying to Vercel (free Hobby plan)

1. Push this folder to a GitHub repository (`git init && git add . && git commit -m "PDF editor" && git push`).
2. In Vercel: **Add New → Project → Import** the repository. The framework is detected as Next.js; keep the defaults (build command `npm run build`, which uses webpack and copies the runtime assets automatically). No environment variables are needed.
3. Deploy, open the URL and try a PDF.

The app is fully static (no server functions are used), so it consumes only CDN bandwidth/requests. Per Vercel's documentation (checked October 2026) the Hobby plan is free, **restricted to non-commercial personal use**, and includes e.g. 100 GB Fast Data Transfer and 1,000,000 CDN requests per month; if limits are exceeded, the feature is paused until 30 days have passed. Limits change — check <https://vercel.com/docs/plans/hobby>. A first visit downloads about 1–3 MB of app code; OCR downloads up to ~9 MB of engine and language data on first use.

---

## Known limitations

- **Native text editing** is limited to the safe cases listed above. Arabic/RTL, complex scripts, Type 3 fonts, text inside Form XObjects, scanned pages and characters missing from subset fonts need visual replacement. No reflow of following text.
- **Visual replacement covers, it does not delete.** No true redaction.
- **Encrypted PDFs** (user or owner password) can be viewed, searched and copied but not edited or exported, because `pdf-lib` cannot decrypt them.
- **Added objects are flattened into the page content** on export (they are not interactive annotations). Existing annotations, links and form fields of the original document are preserved; forms on *imported or duplicated* pages are flattened, and internal links on such pages are removed.
- When pages are deleted, bookmarks pointing to them lose their destination; tagged-PDF structure may become outdated.
- Fonts embedded for added text are subset Noto fonts (Latin, Greek, Cyrillic, Arabic) or the PDF standard fonts; other scripts need an uploaded TTF/OTF. Exact appearance of the original font is only preserved by native editing.
- Highlights are drawn as page content (multiply blend), not as PDF highlight annotations.
- XFA (dynamic, LiveCycle) forms are not supported; push buttons and signature fields are shown but cannot be filled.
- OCR accuracy depends on scan quality; OCR text is not embedded as a searchable layer in the output.
- Text extraction of Arabic from some third-party PDFs is in visual order, so search may not match.
- A deployed Vercel instance has not been tested by the author of this code (no Vercel account was available in the build environment); the production build was tested locally with `next start`, which serves the same static output and headers.

---

## Project structure

```
src/
  app/                    Next.js shell (layout, page, global CSS, icon)
  components/editor/      UI: Editor shell, Viewer, PageView (+ layers), Sidebar, PropertiesPanel, dialogs, store
  lib/model/              editor document model, pure operations, undo/redo history
  lib/pdf/                content-stream parser, font analysis, text analysis, native edit,
                          exporter, text drawing, forms, garbage collection, verification, PDF.js wrapper
  lib/text/               font faces (standard + bundled Noto + custom), bidi-aware layout
  lib/export/             export runner (Web Worker with main-thread fallback)
  lib/ocr/                Tesseract.js OCR
  lib/files/              file validation and naming
  workers/export.worker.ts
scripts/                  copy-assets (runtime assets → public/), make-fixtures, make-large (perf)
tests/unit/               Vitest
tests/e2e/                Playwright
public/fonts/             Noto Sans / Noto Naskh Arabic / Noto Sans Arabic (SIL OFL, see OFL.txt)
```

## Licences

App code: yours. Dependencies: PDF.js (Apache-2.0), pdf-lib and @pdf-lib/fontkit (MIT), Tesseract.js (Apache-2.0), bidi-js (MIT), fflate (MIT), Lucide (ISC), Next.js/React (MIT). Fonts: SIL Open Font License 1.1 (`public/fonts/OFL.txt`).
