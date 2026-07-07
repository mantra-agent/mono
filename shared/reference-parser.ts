import { createReferenceRef, isParseableReferenceType, type ReferencePart, type ReferenceRef } from "./references";

const CANONICAL_START = /[A-Za-z_]/;
const TYPE_BODY = /[A-Za-z0-9_]/;
const ID_STOP = /\s|[\]<>]/;
const LEGACY_BRACKET_TYPES = new Set(["page", "person", "goal", "spec"]);

function pushText(parts: ReferencePart[], text: string) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last?.kind === "text") last.text += text;
  else parts.push({ kind: "text", text });
}

function pushReference(parts: ReferencePart[], ref: ReferenceRef) {
  parts.push({ kind: "reference", ref });
}

function findClosingBackticks(text: string, start: number, ticks: number): number {
  return text.indexOf("`".repeat(ticks), start + ticks);
}

function parseCanonical(text: string, start: number): { ref: ReferenceRef; end: number } | null {
  if (text[start] !== "@") return null;
  let cursor = start + 1;
  if (!CANONICAL_START.test(text[cursor] || "")) return null;
  const typeStart = cursor;
  while (TYPE_BODY.test(text[cursor] || "")) cursor++;
  if (text[cursor] !== ":") return null;
  const type = text.slice(typeStart, cursor).toLowerCase();
  if (!isParseableReferenceType(type)) return null;
  cursor++;
  const idStart = cursor;
  while (cursor < text.length && !ID_STOP.test(text[cursor])) cursor++;
  let id = text.slice(idStart, cursor);
  while (/[.,;:!?)]$/.test(id)) {
    id = id.slice(0, -1);
    cursor--;
  }
  if (!id) return null;
  const raw = text.slice(start, cursor);
  return { ref: createReferenceRef({ type, id, raw }), end: cursor };
}

function parseLegacyBracket(text: string, start: number): { ref: ReferenceRef; end: number } | null {
  if (text[start] !== "[") return null;
  const close = text.indexOf("]", start + 1);
  if (close === -1) return null;
  const body = text.slice(start + 1, close);
  const colon = body.indexOf(":");
  if (colon <= 0) return null;
  const type = body.slice(0, colon).trim().toLowerCase();
  if (!LEGACY_BRACKET_TYPES.has(type)) return null;
  const id = body.slice(colon + 1).trim();
  if (!id || /\s/.test(id)) return null;
  const raw = text.slice(start, close + 1);
  const metadata = type === "spec" ? { legacyType: "spec" } : undefined;
  return { ref: createReferenceRef({ type, id, raw, legacy: true, metadata }), end: close + 1 };
}

function parseLegacyIntention(text: string, start: number): { ref: ReferenceRef; end: number } | null {
  const slice = text.slice(start);
  const match = slice.match(/^_?\bIntention ID:\s*([a-z0-9][a-z0-9_-]{2,})_?/i);
  if (!match) return null;
  const raw = match[0];
  return {
    ref: createReferenceRef({ type: "intention", id: match[1], raw, legacy: true }),
    end: start + raw.length,
  };
}

function parseAt(text: string, start: number): { ref: ReferenceRef; end: number } | null {
  return parseCanonical(text, start) ?? parseLegacyBracket(text, start) ?? parseLegacyIntention(text, start);
}

export function parseReferenceText(text: string): ReferencePart[] {
  const parts: ReferencePart[] = [];
  let cursor = 0;
  let textStart = 0;
  let inFence = false;

  while (cursor < text.length) {
    if (text.startsWith("```", cursor)) {
      cursor += 3;
      inFence = !inFence;
      continue;
    }

    if (text[cursor] === "`") {
      const ticks = /^`+/.exec(text.slice(cursor))?.[0].length ?? 1;
      const close = findClosingBackticks(text, cursor, ticks);
      if (close !== -1) {
        cursor = close + ticks;
        continue;
      }
    }

    if (!inFence && (text[cursor] === "@" || text[cursor] === "[" || text.startsWith("Intention ID:", cursor) || text.startsWith("_Intention ID:", cursor))) {
      const parsed = parseAt(text, cursor);
      if (parsed) {
        pushText(parts, text.slice(textStart, cursor));
        pushReference(parts, parsed.ref);
        cursor = parsed.end;
        textStart = cursor;
        continue;
      }
    }

    cursor++;
  }

  pushText(parts, text.slice(textStart));
  return parts.length ? parts : [{ kind: "text", text }];
}

export function normalizeLegacyReferences(text: string): { text: string; refs: ReferenceRef[]; changed: boolean } {
  const parts = parseReferenceText(text);
  const refs = parts.filter((part): part is { kind: "reference"; ref: ReferenceRef } => part.kind === "reference").map(part => part.ref);
  const normalized = parts.map(part => part.kind === "text" ? part.text : part.ref.canonical).join("");
  return { text: normalized, refs, changed: normalized !== text };
}
