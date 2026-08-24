/**
 * Minimal PDF writer — a real, paginated report, no dependency.
 *
 * A PDF is a plain-text object graph (a few dictionaries plus one content
 * stream per page, each stream a short list of text/line operators) with a
 * byte-offset index at the end, so it doesn't need a rendering library.
 * Fonts are two of the 14 standard PDF fonts (Helvetica / Helvetica-Bold),
 * built into every reader, so nothing needs embedding.
 *
 * ponytail: WinAnsi-range text only, and a fixed table/column layout rather
 * than a general layout engine - this exists to print one thing, a tabular
 * business report.
 */

const PAGE_W = 792, PAGE_H = 612; // US Letter, landscape
const MARGIN = 40;
const USABLE_W = PAGE_W - MARGIN * 2;
const ROW_H = 13;
const HEAD_FONT = 8.5, BODY_FONT = 8;

/** Helvetica advance widths (units/1000) for ASCII 32-126. Digits are all 556,
 *  which is what matters most - numeric columns right-align exactly. */
const W: Record<string, number> = {};
{
  const widths =
    "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 " + // 32-47
    "556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 " + // 48-63
    "1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 " + // 64-79
    "667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 " +  // 80-95
    "333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 " +  // 96-111
    "556 556 333 500 278 556 500 722 500 500 500 334 260 334 584";        // 112-126
  widths.split(/\s+/).forEach((w, i) => { W[String.fromCharCode(32 + i)] = Number(w); });
}
function textWidth(s: string, size: number, bold = false): number {
  let units = 0;
  for (const ch of s) units += W[ch] ?? 556;
  // Helvetica-Bold runs a little wider; close enough for column fitting.
  return (units / 1000) * size * (bold ? 1.06 : 1);
}

export type PdfCol = { header: string; width: number; align?: "left" | "right" };
export type PdfSection = {
  title: string;
  note?: string;
  columns: PdfCol[];
  rows: (string | number | null)[][];
  /** Shown instead of the table when there are no rows. */
  empty?: string;
};
export type PdfKpi = { label: string; value: string; prev?: string; change?: string };
export type PdfReport = {
  title: string;
  subtitle: string;
  meta: string;
  kpiHeader?: [string, string, string];
  kpis: PdfKpi[];
  sections: PdfSection[];
};

/**
 * WinAnsi puts the typographic punctuation we actually use in 0x80-0x9F,
 * where Latin-1 has control codes - so these need mapping by hand rather
 * than falling through the <= 0xff shortcut and rendering as "?".
 */
const WINANSI: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85,
  "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a,
  "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92,
  "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c,
  "ž": 0x9e, "Ÿ": 0x9f,
};

/** Escape a PDF literal string, mapped into the WinAnsi byte range. */
function pdfStr(s: string): string {
  let out = "";
  for (const ch of s) {
    const mapped = WINANSI[ch];
    const code = mapped ?? ch.codePointAt(0)!;
    out += String.fromCharCode(code <= 0xff ? code : 0x3f);
  }
  return out.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function truncate(text: string, widthPt: number, size: number, bold = false): string {
  if (textWidth(text, size, bold) <= widthPt) return text;
  let s = text;
  while (s.length > 1 && textWidth(s + "…", size, bold) > widthPt) s = s.slice(0, -1);
  return s + "…";
}

class Page {
  private text: string[] = [];
  private ops: string[] = [];
  private curFont = "";
  private curSize = 0;
  private curGray = -1;

  text_(x: number, y: number, s: string, font: "F1" | "F2", size: number, gray = 0) {
    if (!s) return;
    if (gray !== this.curGray) { this.text.push(`${gray} g`); this.curGray = gray; }
    if (font !== this.curFont || size !== this.curSize) {
      this.text.push(`/${font} ${size} Tf`);
      this.curFont = font; this.curSize = size;
    }
    this.text.push(`1 0 0 1 ${x.toFixed(1)} ${(PAGE_H - y).toFixed(1)} Tm (${pdfStr(s)}) Tj`);
  }

  /** Right-aligned: x is the RIGHT edge. */
  textR(x: number, y: number, s: string, font: "F1" | "F2", size: number, gray = 0) {
    this.text_(x - textWidth(s, size, font === "F2"), y, s, font, size, gray);
  }

  line(x1: number, x2: number, y: number, gray = 0.75) {
    this.ops.push(`${gray} G 0.6 w ${x1.toFixed(1)} ${(PAGE_H - y).toFixed(1)} m ${x2.toFixed(1)} ${(PAGE_H - y).toFixed(1)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, gray = 0.94) {
    this.ops.push(`${gray} g ${x.toFixed(1)} ${(PAGE_H - y - h).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
    this.curGray = -1; // the fill changed the gray state
  }

  toStream(): string {
    return [...this.ops, "BT", ...this.text, "ET"].join("\n");
  }
}

const scaled = (columns: PdfCol[]) => {
  const total = columns.reduce((a, c) => a + c.width, 0) || 1;
  return columns.map((c) => (c.width / total) * USABLE_W);
};

/** Column x positions: left edge for left-aligned, right edge for right-aligned. */
function drawRow(
  page: Page, cols: PdfCol[], widths: number[], values: (string | number | null)[],
  y: number, font: "F1" | "F2", size: number, gray = 0
) {
  let x = MARGIN;
  cols.forEach((c, i) => {
    const raw = values[i] === null || values[i] === undefined ? "" : String(values[i]);
    const pad = 6;
    if (c.align === "right") {
      page.textR(x + widths[i] - pad, y, truncate(raw, widths[i] - pad, size, font === "F2"), font, size, gray);
    } else {
      page.text_(x, y, truncate(raw, widths[i] - pad, size, font === "F2"), font, size, gray);
    }
    x += widths[i];
  });
}

function layoutSection(section: PdfSection, pages: Page[]) {
  const widths = scaled(section.columns);
  const headerRow = section.columns.map((c) => c.header);

  let page = new Page();
  pages.push(page);
  page.text_(MARGIN, MARGIN + 8, section.title, "F2", 14);
  let y = MARGIN + 26;
  if (section.note) { page.text_(MARGIN, y, section.note, "F1", 8.5, 0.42); y += 14; }

  if (!section.rows.length) {
    page.text_(MARGIN, y + 8, section.empty ?? "Nothing to report for this period.", "F1", 9, 0.42);
    return;
  }

  const drawHead = () => {
    page.rect(MARGIN, y - 9, USABLE_W, 15);
    drawRow(page, section.columns, widths, headerRow, y, "F2", HEAD_FONT, 0.15);
    y += ROW_H + 3;
  };
  drawHead();

  for (const row of section.rows) {
    if (y > PAGE_H - MARGIN) {
      page = new Page();
      pages.push(page);
      page.text_(MARGIN, MARGIN + 8, `${section.title} (continued)`, "F2", 11, 0.42);
      y = MARGIN + 26;
      drawHead();
    }
    drawRow(page, section.columns, widths, row, y, "F1", BODY_FONT);
    page.line(MARGIN, MARGIN + USABLE_W, y + 4, 0.88);
    y += ROW_H;
  }
}

function layoutCover(report: PdfReport): Page {
  const page = new Page();
  page.text_(MARGIN, MARGIN + 16, report.title, "F2", 21);
  page.text_(MARGIN, MARGIN + 38, report.subtitle, "F1", 11, 0.25);
  page.text_(MARGIN, MARGIN + 54, report.meta, "F1", 8.5, 0.5);

  const [h0, h1, h2] = report.kpiHeader ?? ["", "This period", "Previous"];
  const cols: PdfCol[] = [
    { header: h0, width: 3 },
    { header: h1, width: 1.1, align: "right" },
    { header: h2, width: 1.1, align: "right" },
    { header: "Change", width: 1.4, align: "right" },
  ];
  const widths = scaled(cols);
  let y = MARGIN + 92;

  page.rect(MARGIN, y - 9, USABLE_W, 15);
  drawRow(page, cols, widths, cols.map((c) => c.header), y, "F2", HEAD_FONT, 0.15);
  y += ROW_H + 4;

  for (const k of report.kpis) {
    // The current-period figure is the one being read, so it alone is bold -
    // drawn in its own pass so the rest of the row isn't overprinted.
    drawRow(page, cols, widths, [k.label, null, k.prev ?? "", k.change ?? ""], y, "F1", 9.5);
    drawRow(page, cols, widths, [null, k.value, null, null], y, "F2", 9.5);
    page.line(MARGIN, MARGIN + USABLE_W, y + 5, 0.88);
    y += 19;
  }
  return page;
}

export function buildPdf(report: PdfReport): Buffer {
  const pages: Page[] = [layoutCover(report)];
  for (const section of report.sections) layoutSection(section, pages);

  const n = pages.length;
  const pageObjId = (i: number) => 5 + i;
  const streamObjId = (i: number) => 5 + n + i;

  const chunks: string[] = [];
  let offset = 0;
  const push = (s: string) => { chunks.push(s); offset += Buffer.byteLength(s, "latin1"); };
  push("%PDF-1.4\n");

  const objOffsets: number[] = [0]; // index 0 unused (object numbers start at 1)
  const obj = (body: string) => { objOffsets.push(offset); push(body); };

  obj(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  obj(`2 0 obj\n<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObjId(i)} 0 R`).join(" ")}] /Count ${n} >>\nendobj\n`);
  obj(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
  obj(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`);

  pages.forEach((_, i) => {
    obj(`${pageObjId(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamObjId(i)} 0 R >>\nendobj\n`);
  });
  pages.forEach((p, i) => {
    const stream = p.toStream();
    obj(`${streamObjId(i)} 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream\nendobj\n`);
  });

  const xrefStart = offset;
  const total = objOffsets.length;
  const xref = ["xref", `0 ${total}`, "0000000000 65535 f "];
  for (let i = 1; i < total; i++) xref.push(`${String(objOffsets[i]).padStart(10, "0")} 00000 n `);
  push(xref.join("\n") + "\n");
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  return Buffer.from(chunks.join(""), "latin1");
}
