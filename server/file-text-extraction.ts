import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { readDocxRich } from "./docx-utils";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_OFFICE_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_OFFICE_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 5_000_000;
const MAX_WORKSHEETS = 100;
const MAX_WORKSHEET_CELLS = 1_000_000;

export function isExtractableOfficeMime(mimeType: string | null | undefined): boolean {
  const mime = mimeType?.toLowerCase();
  return mime === DOCX_MIME || mime === XLSX_MIME;
}

export async function extractOfficeText(
  content: Buffer,
  mimeType: string | null | undefined,
): Promise<string | null> {
  if (content.length > MAX_OFFICE_SOURCE_BYTES) return null;

  const mime = mimeType?.toLowerCase();
  if (mime === DOCX_MIME) {
    const rich = await readDocxRich(content);
    const text = rich.paragraphs
      .map((paragraph) => paragraph.runs.map((run) => run.text).join(""))
      .join("\n")
      .trim();
    return boundedText(text);
  }

  if (mime === XLSX_MIME) {
    return extractXlsxAsCsv(content);
  }

  return null;
}

function boundedText(text: string): string | null {
  return text.length <= MAX_EXTRACTED_TEXT_CHARS ? text : null;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseXml(xml: string): any {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    trimValues: false,
  }).parse(xml);
}

function zipUncompressedBytes(zip: JSZip): number {
  let total = 0;
  for (const file of Object.values(zip.files)) {
    const size = Number((file as any)?._data?.uncompressedSize ?? 0);
    if (!Number.isFinite(size) || size < 0) return Number.POSITIVE_INFINITY;
    total += size;
    if (total > MAX_OFFICE_UNCOMPRESSED_BYTES) return total;
  }
  return total;
}

async function extractXlsxAsCsv(content: Buffer): Promise<string | null> {
  const zip = await JSZip.loadAsync(content);
  if (zipUncompressedBytes(zip) > MAX_OFFICE_UNCOMPRESSED_BYTES) return null;

  const workbookFile = zip.file("xl/workbook.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookFile || !relsFile) return null;

  const [workbookXml, relsXml, sharedStrings] = await Promise.all([
    workbookFile.async("string"),
    relsFile.async("string"),
    readSharedStrings(zip),
  ]);
  const workbook = parseXml(workbookXml);
  const rels = parseXml(relsXml);

  const targets = new Map<string, string>();
  for (const rel of asArray(rels?.Relationships?.Relationship)) {
    const id = rel?.["@_Id"];
    const target = rel?.["@_Target"];
    if (typeof id === "string" && typeof target === "string") {
      targets.set(id, normalizeWorksheetPath(target));
    }
  }

  const sheets = asArray(workbook?.workbook?.sheets?.sheet);
  if (sheets.length > MAX_WORKSHEETS) return null;

  const rendered: string[] = [];
  let totalCells = 0;
  let totalChars = 0;
  let totalColumnSlots = 0;
  for (const sheet of sheets) {
    const name = typeof sheet?.["@_name"] === "string" ? sheet["@_name"] : "Sheet";
    const relationId = sheet?.["@_r:id"];
    const path = targets.get(relationId);
    const worksheetFile = path ? zip.file(path) : null;
    if (!worksheetFile) continue;

    const worksheet = parseXml(await worksheetFile.async("string"));
    const rows: string[] = [];
    for (const row of asArray(worksheet?.worksheet?.sheetData?.row)) {
      const values: string[] = [];
      let column = 0;
      for (const cell of asArray(row?.c)) {
        const reference = typeof cell?.["@_r"] === "string" ? cell["@_r"] : "";
        const targetColumn = reference ? columnIndex(reference) : column;
        if (targetColumn < column) return null;
        totalColumnSlots += targetColumn - column + 1;
        if (totalColumnSlots > MAX_WORKSHEET_CELLS) return null;
        while (column < targetColumn) {
          values.push("");
          column += 1;
        }
        values.push(csvEscape(cellValue(cell, sharedStrings)));
        column += 1;
        totalCells += 1;
        if (totalCells > MAX_WORKSHEET_CELLS) return null;
      }
      rows.push(values.join(","));
    }

    const section = [`--- Sheet: ${name} ---`, ...rows].join("\n");
    totalChars += section.length + (rendered.length ? 2 : 0);
    if (totalChars > MAX_EXTRACTED_TEXT_CHARS) return null;
    rendered.push(section);
  }

  return rendered.length ? rendered.join("\n\n") : null;
}

async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const file = zip.file("xl/sharedStrings.xml");
  if (!file) return [];
  const parsed = parseXml(await file.async("string"));
  return asArray(parsed?.sst?.si).map((item) => collectText(item));
}

function collectText(value: any): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(collectText).join("");
  if (typeof value === "object") {
    if (value.t != null) return collectText(value.t);
    if (value["#text"] != null) return String(value["#text"]);
    return Object.entries(value)
      .filter(([key]) => !key.startsWith("@_"))
      .map(([, nested]) => collectText(nested))
      .join("");
  }
  return "";
}

function cellValue(cell: any, sharedStrings: string[]): string {
  const type = cell?.["@_t"];
  if (type === "inlineStr") return collectText(cell?.is);
  const raw = collectText(cell?.v);
  if (type === "s") {
    const index = Number.parseInt(raw, 10);
    return Number.isInteger(index) ? sharedStrings[index] ?? "" : "";
  }
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  return raw;
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? "A";
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, value - 1);
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function normalizeWorksheetPath(target: string): string {
  const normalized = target.replace(/\\/g, "/").replace(/^\//, "");
  if (normalized.startsWith("xl/")) return normalized;
  const parts = normalized.split("/");
  const resolved: string[] = ["xl"];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}
