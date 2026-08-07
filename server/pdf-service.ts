import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { documentArtifacts, type DocumentArtifact } from "@shared/models/documents";
import { db } from "./db";
import { filesApi } from "./files-api";
import type { FilesProvider } from "./files-providers";
import { createLogger } from "./log";
import { objectStorageService, type StorageObjectRef } from "./object_storage";
import { ObjectPermission } from "./object_storage/objectAcl";
import { requireCurrentUserPrincipal } from "./principal-context";
import { ownedInsertValues, visibleScopePredicate } from "./scoped-storage";

const log = createLogger("PdfService");

const HANDLE_TTL_SECONDS = 120;
const PDF_MIME = "application/pdf";
/** Same family as the viewer: Mozilla PDF.js. Caps keep Agent extract bounded. */
const MAX_EXTRACT_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 40;
const HARD_MAX_PAGES = 200;
const MAX_TOTAL_CHARS = 400_000;
const MAX_PAGE_CHARS = 20_000;
const DEFAULT_LIST_LIMIT = 50;
const HARD_LIST_LIMIT = 100;
/** Structured generate caps — keep Agent-authored PDFs bounded and deterministic. */
const MAX_GENERATE_TITLE_CHARS = 200;
const MAX_GENERATE_BLOCKS = 80;
const MAX_GENERATE_BLOCK_CHARS = 4_000;
const MAX_GENERATE_TOTAL_CHARS = 60_000;
const MAX_GENERATE_BYTES = 5 * 1024 * 1024;
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PAGE_MARGIN = 54;
const BODY_SIZE = 11;
const HEADING_SIZE = 16;
const TITLE_SIZE = 22;
const LINE_GAP = 4;

type ExternalSource = { kind: "external"; driveResourceId?: string; rootDriveResourceId?: string; provider?: FilesProvider; providerFileId?: string; vaultId?: string };
type InternalSource = { kind: "internal"; objectPath: string; document?: DocumentArtifact };
type ResolvedSource = ExternalSource | InternalSource;

export type OpenPdfInput = {
  driveResourceId?: string;
  rootDriveResourceId?: string;
  provider?: FilesProvider;
  providerFileId?: string;
  vaultId?: string;
  objectPath?: string;
  documentId?: string;
  uploadId?: string;
};

export interface OpenPdfResult {
  handle: string;
  streamUrl: string;
  metadata: {
    documentId: string | null;
    title: string;
    mimeType: typeof PDF_MIME;
    byteSize: number;
    pageCount: number | null;
    sourceKind: string;
    viewerUrl: string | null;
  };
}

type HandlePayload = { v: 1; exp: number; src: ResolvedSource };

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function signingSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for PDF content handles");
  return secret;
}

function handleKey(): Buffer {
  return createHash("sha256").update(signingSecret()).update("core-pdf-content-handle-v1").digest();
}

function issueHandle(source: ResolvedSource): string {
  const payload: HandlePayload = { v: 1, exp: Math.floor(Date.now() / 1000) + HANDLE_TTL_SECONDS, src: source };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", handleKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

function parseHandle(handle: string): HandlePayload {
  const [ivText, ciphertextText, tagText, extra] = handle.split(".");
  if (!ivText || !ciphertextText || !tagText || extra) throw httpError(403, "Invalid PDF content handle");
  let payload: HandlePayload;
  try {
    const decipher = createDecipheriv("aes-256-gcm", handleKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]);
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw httpError(403, "Invalid PDF content handle");
  }
  if (payload.v !== 1 || !payload.src || !Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw httpError(403, "Expired PDF content handle");
  }
  return payload;
}

function assertPdf(buffer: Buffer, contentType: string | null | undefined): void {
  const normalized = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (normalized !== PDF_MIME || buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw httpError(415, "Content is not a verified PDF");
  }
}

export async function createDocumentArtifact(input: {
  vaultId: string;
  sourceKind: DocumentArtifact["sourceKind"];
  sourceRef: string;
  mimeType: string;
  title: string;
  byteSize?: number | null;
  checksum?: string | null;
  objectPath?: string | null;
  pageCount?: number | null;
  provenance?: Record<string, unknown>;
}): Promise<DocumentArtifact> {
  const principal = requireCurrentUserPrincipal();
  if (!principal.userId || !principal.accountId || !principal.visibleVaultIds?.includes(input.vaultId)) {
    throw httpError(403, "Document vault access denied");
  }
  if (input.mimeType !== PDF_MIME) throw httpError(415, "Core PDF v1 accepts application/pdf only");
  const owner = ownedInsertValues(principal, {
    ownerUserId: documentArtifacts.ownerUserId,
    accountId: documentArtifacts.accountId,
    vaultId: documentArtifacts.vaultId,
  });
  const [row] = await db.insert(documentArtifacts).values({
    ...owner,
    vaultId: input.vaultId,
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    mimeType: input.mimeType,
    title: input.title,
    byteSize: input.byteSize ?? null,
    checksum: input.checksum ?? null,
    objectPath: input.objectPath ?? null,
    pageCount: input.pageCount ?? null,
    createdByUserId: principal.userId,
    provenance: input.provenance ?? {},
  }).returning();
  return row;
}

async function visibleDocument(id: string): Promise<DocumentArtifact> {
  const principal = requireCurrentUserPrincipal();
  const [row] = await db.select().from(documentArtifacts).where(and(
    eq(documentArtifacts.id, id),
    visibleScopePredicate(principal, {
      ownerUserId: documentArtifacts.ownerUserId,
      accountId: documentArtifacts.accountId,
      vaultId: documentArtifacts.vaultId,
    }),
  )).limit(1);
  if (!row) throw httpError(404, "Document not found");
  return row;
}

async function resolveSource(input: OpenPdfInput): Promise<ResolvedSource> {
  const hasProviderTuple = !!(input.provider || input.providerFileId || input.vaultId || input.rootDriveResourceId);
  const discriminators = [!!input.driveResourceId, hasProviderTuple, !!input.objectPath, !!input.documentId, !!input.uploadId].filter(Boolean).length;
  if (discriminators !== 1) throw httpError(400, "Exactly one PDF source is required");
  if (hasProviderTuple) {
    if (!input.provider || !input.providerFileId || !input.vaultId) throw httpError(400, "provider, providerFileId, and vaultId are required together");
    return { kind: "external", provider: input.provider, providerFileId: input.providerFileId, vaultId: input.vaultId, rootDriveResourceId: input.rootDriveResourceId };
  }
  if (input.driveResourceId) return { kind: "external", driveResourceId: input.driveResourceId };
  if (input.documentId) {
    const document = await visibleDocument(input.documentId);
    if (document.mimeType !== PDF_MIME) throw httpError(415, "Document is not a PDF");
    if (document.sourceKind === "bound_external") return { kind: "external", driveResourceId: document.sourceRef };
    if (!document.objectPath) throw httpError(404, "Document bytes are unavailable");
    return { kind: "internal", objectPath: document.objectPath, document };
  }
  return { kind: "internal", objectPath: input.objectPath ?? input.uploadId! };
}

async function readInternal(source: InternalSource): Promise<{ buffer: Buffer; contentType: string; ref: StorageObjectRef }> {
  const principal = requireCurrentUserPrincipal();
  const ref = await objectStorageService.getObjectEntityFile(source.objectPath, principal);
  const allowed = await objectStorageService.canAccessObjectEntity({ principal, objectFile: ref, requestedPermission: ObjectPermission.READ });
  if (!allowed) throw httpError(403, "PDF access denied");
  const [buffer] = await ref.download();
  const metadata = await ref.getMetadata();
  return { buffer, contentType: metadata.contentType ?? "", ref };
}

async function readSource(source: ResolvedSource): Promise<{ buffer: Buffer; contentType: string; title: string; sourceKind: string; document: DocumentArtifact | null }> {
  if (source.kind === "external") {
    const result = await filesApi.readAuthorizedBytes(source);
    return { buffer: result.buffer, contentType: result.contentType, title: result.metadata.name, sourceKind: "bound_external", document: null };
  }
  const result = await readInternal(source);
  return { buffer: result.buffer, contentType: result.contentType, title: source.document?.title ?? result.ref.name.split("/").pop() ?? "PDF", sourceKind: source.document?.sourceKind ?? "upload", document: source.document ?? null };
}

function viewerUrlFor(input: OpenPdfInput, documentId: string | null): string | null {
  if (documentId) return `/documents/${encodeURIComponent(documentId)}`;
  if (input.driveResourceId) {
    const params = new URLSearchParams({ source: "drive_resource" });
    if (input.vaultId) params.set("vaultId", input.vaultId);
    return `/documents/${encodeURIComponent(input.driveResourceId)}?${params.toString()}`;
  }
  if (input.provider && input.providerFileId && input.vaultId) {
    const params = new URLSearchParams({
      source: "provider",
      provider: input.provider,
      vaultId: input.vaultId,
    });
    if (input.rootDriveResourceId) params.set("rootDriveResourceId", input.rootDriveResourceId);
    return `/documents/${encodeURIComponent(input.providerFileId)}?${params.toString()}`;
  }
  if (input.objectPath || input.uploadId) {
    const objectPath = input.objectPath ?? input.uploadId!;
    const params = new URLSearchParams({ source: "object", objectPath });
    return `/documents/${encodeURIComponent(objectPath)}?${params.toString()}`;
  }
  return null;
}

export async function openPdf(input: OpenPdfInput): Promise<OpenPdfResult> {
  const source = await resolveSource(input);
  const bytes = await readSource(source);
  assertPdf(bytes.buffer, bytes.contentType);
  const handle = issueHandle(source);
  const documentId = bytes.document?.id ?? null;
  return {
    handle,
    streamUrl: `/api/pdf/content/${encodeURIComponent(handle)}`,
    metadata: {
      documentId,
      title: bytes.title,
      mimeType: PDF_MIME,
      byteSize: bytes.buffer.length,
      pageCount: bytes.document?.pageCount ?? null,
      sourceKind: bytes.sourceKind,
      viewerUrl: viewerUrlFor(input, documentId),
    },
  };
}

export async function readPdfContentHandle(handle: string): Promise<Buffer> {
  const payload = parseHandle(handle);
  // Handles identify a source, never authority. Re-run live ACL/bind checks on every read.
  const bytes = await readSource(payload.src);
  assertPdf(bytes.buffer, bytes.contentType);
  return bytes.buffer;
}

export type ExtractPdfTextInput = OpenPdfInput & {
  /** 1-based inclusive start page (default 1). */
  startPage?: number;
  /** Max pages to return from startPage (default 40, hard cap 200). */
  maxPages?: number;
};

export interface ExtractedPdfPage {
  index: number;
  text: string;
}

export interface ExtractPdfTextResult {
  documentId: string | null;
  title: string;
  pageCount: number;
  pages: ExtractedPdfPage[];
  truncated: boolean;
  textExtractStatus: DocumentArtifact["textExtractStatus"] | "ready" | "failed";
  byteSize: number;
  sourceKind: string;
}

type PdfJsModule = {
  getDocument: (src: Record<string, unknown>) => { promise: Promise<PdfJsDocument> };
  GlobalWorkerOptions?: { workerSrc: string };
};

type PdfJsDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<{
    getTextContent: () => Promise<{ items?: Array<{ str?: string }> }>;
  }>;
  destroy: () => Promise<void> | void;
};

let pdfJsLoad: Promise<PdfJsModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsLoad) {
    pdfJsLoad = (async () => {
      // Same Mozilla PDF.js family as the client viewer (pdfjs-dist@6.2.108).
      // Production installs from package-lock; do not CDN-import in Node.
      const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
      return mod as unknown as PdfJsModule;
    })();
  }
  return pdfJsLoad;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function pageTextFromContent(content: { items?: Array<{ str?: string }> }): string {
  const parts: string[] = [];
  for (const item of content.items ?? []) {
    if (typeof item?.str === "string" && item.str.length > 0) parts.push(item.str);
  }
  return parts.join(" ").replace(/[ \t]+\n/g, "\n").replace(/\s+/g, " ").trim();
}

async function extractPagesFromBuffer(
  buffer: Buffer,
  startPage: number,
  maxPages: number,
): Promise<{ pageCount: number; pages: ExtractedPdfPage[]; truncated: boolean }> {
  const pdfjs = await loadPdfJs();
  // The Node legacy build disables real workers and supplies its own module-relative
  // fake-worker source. Do not blank workerSrc: fake-worker setup still imports it.
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  try {
    const pageCount = doc.numPages;
    const start = Math.min(Math.max(1, startPage), Math.max(1, pageCount));
    const endExclusive = Math.min(pageCount + 1, start + maxPages);
    const pages: ExtractedPdfPage[] = [];
    let totalChars = 0;
    let truncated = endExclusive - 1 < pageCount || start > 1;

    for (let index = start; index < endExclusive; index += 1) {
      const page = await doc.getPage(index);
      const raw = pageTextFromContent(await page.getTextContent());
      let text = raw.length > MAX_PAGE_CHARS ? raw.slice(0, MAX_PAGE_CHARS) : raw;
      if (raw.length > MAX_PAGE_CHARS) truncated = true;
      if (totalChars + text.length > MAX_TOTAL_CHARS) {
        text = text.slice(0, Math.max(0, MAX_TOTAL_CHARS - totalChars));
        truncated = true;
        if (text.length > 0) pages.push({ index, text });
        break;
      }
      totalChars += text.length;
      pages.push({ index, text });
      if (totalChars >= MAX_TOTAL_CHARS) {
        truncated = truncated || index < pageCount;
        break;
      }
    }
    return { pageCount, pages, truncated };
  } finally {
    await doc.destroy();
  }
}

async function markTextExtractStatus(
  documentId: string | null | undefined,
  status: "pending" | "ready" | "failed",
  patch?: {
    pageCount?: number | null;
    provenanceExtract?: Record<string, unknown>;
  },
): Promise<void> {
  if (!documentId) return;
  const principal = requireCurrentUserPrincipal();
  const [existing] = await db.select().from(documentArtifacts).where(and(
    eq(documentArtifacts.id, documentId),
    visibleScopePredicate(principal, {
      ownerUserId: documentArtifacts.ownerUserId,
      accountId: documentArtifacts.accountId,
      vaultId: documentArtifacts.vaultId,
    }),
  )).limit(1);
  if (!existing) return;

  const provenance = {
    ...(existing.provenance && typeof existing.provenance === "object" ? existing.provenance as Record<string, unknown> : {}),
    ...(patch?.provenanceExtract ? { textExtract: patch.provenanceExtract } : {}),
  };

  await db.update(documentArtifacts).set({
    textExtractStatus: status,
    pageCount: patch?.pageCount ?? existing.pageCount,
    provenance,
    updatedAt: new Date(),
  }).where(and(
    eq(documentArtifacts.id, documentId),
    visibleScopePredicate(principal, {
      ownerUserId: documentArtifacts.ownerUserId,
      accountId: documentArtifacts.accountId,
      vaultId: documentArtifacts.vaultId,
    }),
  ));
}

/**
 * Authorize via the exact openPdf resolve+read path, then extract plain text per page.
 * Extract status/cache on document_artifacts is a derivative only — never ACL authority.
 */
export async function extractPdfText(input: ExtractPdfTextInput): Promise<ExtractPdfTextResult> {
  const startPage = clampInt(input.startPage, 1, 1, HARD_MAX_PAGES);
  const maxPages = clampInt(input.maxPages, DEFAULT_MAX_PAGES, 1, HARD_MAX_PAGES);
  const source = await resolveSource(input);
  const bytes = await readSource(source);
  assertPdf(bytes.buffer, bytes.contentType);
  if (bytes.buffer.length > MAX_EXTRACT_BYTES) {
    throw httpError(413, `PDF exceeds extract size cap (${MAX_EXTRACT_BYTES} bytes)`);
  }

  const documentId = bytes.document?.id ?? (input.documentId ?? null);
  await markTextExtractStatus(documentId, "pending");

  try {
    const extracted = await extractPagesFromBuffer(bytes.buffer, startPage, maxPages);
    await markTextExtractStatus(documentId, "ready", {
      pageCount: extracted.pageCount,
      // Derivative metadata only — full page text is returned to the caller, not
      // persisted as a second ACL-bearing body. Re-authorize on every extract.
      provenanceExtract: {
        status: "ready",
        extractedAt: new Date().toISOString(),
        startPage,
        maxPages,
        pageCount: extracted.pageCount,
        returnedPages: extracted.pages.length,
        truncated: extracted.truncated,
        engine: "pdfjs-dist@6.2.108",
      },
    });
    log.debug(`extractPdfText ready pages=${extracted.pages.length} truncated=${extracted.truncated}`);
    return {
      documentId,
      title: bytes.title,
      pageCount: extracted.pageCount,
      pages: extracted.pages,
      truncated: extracted.truncated,
      textExtractStatus: "ready",
      byteSize: bytes.buffer.length,
      sourceKind: bytes.sourceKind,
    };
  } catch (error) {
    await markTextExtractStatus(documentId, "failed", {
      provenanceExtract: {
        status: "failed",
        failedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message.slice(0, 200) : "extract_failed",
      },
    });
    log.warn(`extractPdfText failed: ${error instanceof Error ? error.message : String(error)}`);
    if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") {
      throw error;
    }
    throw httpError(500, "PDF text extraction failed");
  }
}

export interface ListDocumentArtifactsInput {
  vaultId?: string;
  limit?: number;
  offset?: number;
}

export async function listDocumentArtifacts(input: ListDocumentArtifactsInput = {}): Promise<{
  count: number;
  documents: Array<{
    id: string;
    title: string;
    mimeType: string;
    sourceKind: string;
    vaultId: string;
    byteSize: number | null;
    pageCount: number | null;
    textExtractStatus: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
}> {
  const principal = requireCurrentUserPrincipal();
  const limit = clampInt(input.limit, DEFAULT_LIST_LIMIT, 1, HARD_LIST_LIMIT);
  const offset = clampInt(input.offset, 0, 0, 10_000);
  const vaultId = typeof input.vaultId === "string" && input.vaultId.trim() ? input.vaultId.trim() : undefined;
  if (vaultId && !principal.visibleVaultIds?.includes(vaultId)) {
    throw httpError(403, "Document vault access denied");
  }

  const scope = visibleScopePredicate(principal, {
    ownerUserId: documentArtifacts.ownerUserId,
    accountId: documentArtifacts.accountId,
    vaultId: documentArtifacts.vaultId,
  });
  const where = vaultId
    ? and(scope, eq(documentArtifacts.vaultId, vaultId), eq(documentArtifacts.mimeType, PDF_MIME))
    : and(scope, eq(documentArtifacts.mimeType, PDF_MIME));

  const rows = await db.select({
    id: documentArtifacts.id,
    title: documentArtifacts.title,
    mimeType: documentArtifacts.mimeType,
    sourceKind: documentArtifacts.sourceKind,
    vaultId: documentArtifacts.vaultId,
    byteSize: documentArtifacts.byteSize,
    pageCount: documentArtifacts.pageCount,
    textExtractStatus: documentArtifacts.textExtractStatus,
    createdAt: documentArtifacts.createdAt,
    updatedAt: documentArtifacts.updatedAt,
  }).from(documentArtifacts).where(where).orderBy(desc(documentArtifacts.updatedAt)).limit(limit).offset(offset);

  return { count: rows.length, documents: rows };
}

export type PdfGenerateBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullet"; text: string };

export type GeneratePdfSpec = {
  title: string;
  blocks?: PdfGenerateBlock[];
  vaultId?: string;
};

export interface GeneratePdfResult {
  documentId: string;
  title: string;
  objectPath: string;
  byteSize: number;
  pageCount: number;
  sourceKind: "generated";
  mimeType: typeof PDF_MIME;
  viewerUrl: string;
  open: OpenPdfResult;
}

function sanitizePdfText(value: unknown, maxChars: number, label: string): string {
  if (typeof value !== "string") throw httpError(400, `${label} must be a string`);
  // pdf-lib standard fonts are WinAnsi — strip control chars and normalize whitespace.
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!cleaned) throw httpError(400, `${label} is required`);
  if (cleaned.length > maxChars) throw httpError(400, `${label} exceeds ${maxChars} characters`);
  return cleaned;
}

function normalizeGenerateSpec(input: GeneratePdfSpec): {
  title: string;
  blocks: PdfGenerateBlock[];
  vaultId: string | undefined;
} {
  const title = sanitizePdfText(input.title, MAX_GENERATE_TITLE_CHARS, "title");
  const rawBlocks = Array.isArray(input.blocks) ? input.blocks : [];
  if (rawBlocks.length > MAX_GENERATE_BLOCKS) {
    throw httpError(400, `blocks exceeds cap of ${MAX_GENERATE_BLOCKS}`);
  }

  let totalChars = title.length;
  const blocks: PdfGenerateBlock[] = [];
  for (let i = 0; i < rawBlocks.length; i += 1) {
    const block = rawBlocks[i];
    if (!block || typeof block !== "object") throw httpError(400, `blocks[${i}] is invalid`);
    const type = (block as { type?: unknown }).type;
    if (type !== "heading" && type !== "paragraph" && type !== "bullet") {
      throw httpError(400, `blocks[${i}].type must be heading, paragraph, or bullet`);
    }
    const text = sanitizePdfText((block as { text?: unknown }).text, MAX_GENERATE_BLOCK_CHARS, `blocks[${i}].text`);
    totalChars += text.length;
    if (totalChars > MAX_GENERATE_TOTAL_CHARS) {
      throw httpError(400, `PDF generate content exceeds ${MAX_GENERATE_TOTAL_CHARS} characters`);
    }
    blocks.push({ type, text });
  }

  const vaultId = typeof input.vaultId === "string" && input.vaultId.trim()
    ? input.vaultId.trim()
    : undefined;
  return { title, blocks, vaultId };
}

function wrapLine(text: string, font: { widthOfTextAtSize: (t: string, s: number) => number }, size: number, maxWidth: number): string[] {
  const paragraphs = text.split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = words[0];
    for (let i = 1; i < words.length; i += 1) {
      const candidate = `${current} ${words[i]}`;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
  }
  return lines;
}

async function renderStructuredPdf(title: string, blocks: PdfGenerateBlock[]): Promise<{ buffer: Buffer; pageCount: number }> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(title);
  pdfDoc.setProducer("Mantra Core PDF");
  pdfDoc.setCreator("Mantra");
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const maxWidth = PAGE_WIDTH - PAGE_MARGIN * 2;

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - PAGE_MARGIN;

  const ensureSpace = (needed: number) => {
    if (y - needed < PAGE_MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - PAGE_MARGIN;
    }
  };

  const drawWrapped = (
    text: string,
    opts: { size: number; bold?: boolean; indent?: number; color?: ReturnType<typeof rgb> },
  ) => {
    const activeFont = opts.bold ? fontBold : font;
    const indent = opts.indent ?? 0;
    const lines = wrapLine(text, activeFont, opts.size, maxWidth - indent);
    const lineHeight = opts.size + LINE_GAP;
    for (const line of lines) {
      ensureSpace(lineHeight);
      if (line.length > 0) {
        page.drawText(line, {
          x: PAGE_MARGIN + indent,
          y: y - opts.size,
          size: opts.size,
          font: activeFont,
          color: opts.color ?? rgb(0.1, 0.1, 0.1),
        });
      }
      y -= lineHeight;
    }
  };

  drawWrapped(title, { size: TITLE_SIZE, bold: true, color: rgb(0.05, 0.05, 0.05) });
  y -= 10;

  for (const block of blocks) {
    if (block.type === "heading") {
      y -= 8;
      drawWrapped(block.text, { size: HEADING_SIZE, bold: true });
      y -= 4;
      continue;
    }
    if (block.type === "bullet") {
      drawWrapped(`• ${block.text}`, { size: BODY_SIZE, indent: 12 });
      y -= 2;
      continue;
    }
    drawWrapped(block.text, { size: BODY_SIZE });
    y -= 6;
  }

  const bytes = await pdfDoc.save({ useObjectStreams: false });
  const buffer = Buffer.from(bytes);
  if (buffer.length > MAX_GENERATE_BYTES) {
    throw httpError(413, `Generated PDF exceeds ${MAX_GENERATE_BYTES} bytes`);
  }
  assertPdf(buffer, PDF_MIME);
  return { buffer, pageCount: pdfDoc.getPageCount() };
}

/**
 * Deterministic structured PDF generation. Bytes always land in private object
 * storage under the principal ACL, with a document_artifacts row
 * source_kind='generated'. Round-trip open reuses the same authorize path.
 */
export async function generatePdf(input: GeneratePdfSpec): Promise<GeneratePdfResult> {
  const principal = requireCurrentUserPrincipal();
  if (!principal.userId || !principal.accountId) {
    throw httpError(403, "Authenticated user principal required");
  }

  const spec = normalizeGenerateSpec(input);
  const vaultId = spec.vaultId ?? principal.activeVaultId ?? null;
  if (!vaultId || !principal.visibleVaultIds?.includes(vaultId)) {
    throw httpError(403, "Document vault access denied");
  }

  const rendered = await renderStructuredPdf(spec.title, spec.blocks);
  const checksum = createHash("sha256").update(rendered.buffer).digest("hex");

  const uploaded = await objectStorageService.uploadObjectEntity(rendered.buffer, {
    extension: ".pdf",
    contentType: PDF_MIME,
    category: "uploads",
    principal,
    acl: {
      owner: principal.userId,
      ownerUserId: principal.userId,
      accountId: principal.accountId,
      createdByUserId: principal.userId,
      scope: "user",
      visibility: "private",
    },
  });

  const document = await createDocumentArtifact({
    vaultId,
    sourceKind: "generated",
    sourceRef: `generate:${checksum.slice(0, 16)}`,
    mimeType: PDF_MIME,
    title: spec.title,
    byteSize: uploaded.size,
    checksum,
    objectPath: uploaded.objectPath,
    pageCount: rendered.pageCount,
    provenance: {
      generated: {
        engine: "pdf-lib@1.17.1",
        generatedAt: new Date().toISOString(),
        blockCount: spec.blocks.length,
        titleChars: spec.title.length,
      },
    },
  });

  const open = await openPdf({ documentId: document.id });
  log.info("generatePdf created document artifact", {
    documentId: document.id,
    byteSize: uploaded.size,
    pageCount: rendered.pageCount,
    blockCount: spec.blocks.length,
  });

  return {
    documentId: document.id,
    title: document.title,
    objectPath: uploaded.objectPath,
    byteSize: uploaded.size,
    pageCount: rendered.pageCount,
    sourceKind: "generated",
    mimeType: PDF_MIME,
    viewerUrl: `/documents/${encodeURIComponent(document.id)}`,
    open,
  };
}
