import { crc32 } from "node:zlib";

/**
 * Minimal .xlsx writer — a real Excel workbook, no dependency.
 *
 * An xlsx is a ZIP of OOXML parts, so this emits the four parts Excel needs plus
 * one sheet each, packed with stored (uncompressed) ZIP entries. Strings go inline
 * rather than through a sharedStrings table, which costs a few bytes and removes
 * the one piece of bookkeeping that would otherwise be easy to get wrong.
 *
 * ponytail: store-only, no compression. Exports are hundreds of KB at most; reach
 * for deflate only if a file ever gets big enough to notice.
 */

export type Sheet = {
  name: string;
  columns: { header: string; width?: number }[];
  rows: (string | number | null)[][];
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   // Excel rejects most control characters outright.
   .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

/** Excel sheet names: 31 chars, and none of : \ / ? * [ ] */
const safeName = (s: string) => esc(s.replace(/[:\\/?*[\]]/g, "-").slice(0, 31));

function colRef(n: number) {
  let s = "";
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

function sheetXml(sheet: Sheet) {
  const cell = (v: string | number | null, c: number, r: number) => {
    const ref = `${colRef(c)}${r}`;
    if (v === null || v === "") return "";
    if (typeof v === "number" && Number.isFinite(v)) {
      return `<c r="${ref}"><v>${v}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
  };

  const cols = sheet.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 16}" customWidth="1"/>`)
    .join("");

  const header =
    `<row r="1">${sheet.columns.map((c, i) => cell(c.header, i, 1)).join("")}</row>`;
  const body = sheet.rows
    .map((row, ri) => `<row r="${ri + 2}">${row.map((v, ci) => cell(v, ci, ri + 2)).join("")}</row>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>${cols}</cols><sheetData>${header}${body}</sheetData></worksheet>`;
}

/* ---------- the ZIP container (stored entries, no compression) ---------- */

function zipEntry(name: string, body: string) {
  const data = Buffer.from(body, "utf8");
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);  // local file header signature
  local.writeUInt16LE(20, 4);          // version needed
  local.writeUInt16LE(0, 6);           // flags
  local.writeUInt16LE(0, 8);           // method 0 = stored
  local.writeUInt16LE(0, 10);          // mod time
  local.writeUInt16LE(0x21, 12);       // mod date (1980-01-01)
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  return { nameBuf, data, crc, local };
}

function zip(files: { name: string; body: string }[]) {
  const entries = files.map((f) => zipEntry(f.name, f.body));
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const e of entries) {
    offsets.push(offset);
    chunks.push(e.local, e.nameBuf, e.data);
    offset += e.local.length + e.nameBuf.length + e.data.length;
  }

  const central: Buffer[] = [];
  let centralSize = 0;
  entries.forEach((e, i) => {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);    // central directory signature
    h.writeUInt16LE(20, 4);            // version made by
    h.writeUInt16LE(20, 6);            // version needed
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10);            // stored
    h.writeUInt16LE(0, 12);
    h.writeUInt16LE(0x21, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.data.length, 20);
    h.writeUInt32LE(e.data.length, 24);
    h.writeUInt16LE(e.nameBuf.length, 28);
    h.writeUInt16LE(0, 30);            // extra
    h.writeUInt16LE(0, 32);            // comment
    h.writeUInt16LE(0, 34);            // disk
    h.writeUInt16LE(0, 36);            // internal attrs
    h.writeUInt32LE(0, 38);            // external attrs
    h.writeUInt32LE(offsets[i], 42);
    central.push(h, e.nameBuf);
    centralSize += h.length + e.nameBuf.length;
  });

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);    // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, end]);
}

export function buildXlsx(sheets: Sheet[]): Buffer {
  const named = sheets.map((s, i) => ({ ...s, name: safeName(s.name) || `Sheet${i + 1}` }));

  const files = [
    {
      name: "[Content_Types].xml",
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`,
    },
    {
      name: "_rels/.rels",
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
</Relationships>`,
    },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, body: sheetXml(s) })),
  ];

  return zip(files);
}
