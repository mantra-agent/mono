import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { documentArtifacts, type DocumentArtifact } from "@shared/models/documents";
import { db } from "./db";
import { filesApi } from "./files-api";
import type { FilesProvider } from "./files-providers";
import { objectStorageService, type StorageObjectRef } from "./object_storage";
import { ObjectPermission } from "./object_storage/objectAcl";
import { requireCurrentUserPrincipal } from "./principal-context";
import { ownedInsertValues, visibleScopePredicate } from "./scoped-storage";

const HANDLE_TTL_SECONDS = 120;
const PDF_MIME = "application/pdf";

type ExternalSource = { kind: "external"; driveResourceId?: string; provider?: FilesProvider; providerFileId?: string; vaultId?: string };
type InternalSource = { kind: "internal"; objectPath: string; document?: DocumentArtifact };
type ResolvedSource = ExternalSource | InternalSource;

export type OpenPdfInput = {
  driveResourceId?: string;
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
  const hasProviderTuple = !!(input.provider || input.providerFileId || input.vaultId);
  const discriminators = [!!input.driveResourceId, hasProviderTuple, !!input.objectPath, !!input.documentId, !!input.uploadId].filter(Boolean).length;
  if (discriminators !== 1) throw httpError(400, "Exactly one PDF source is required");
  if (hasProviderTuple) {
    if (!input.provider || !input.providerFileId || !input.vaultId) throw httpError(400, "provider, providerFileId, and vaultId are required together");
    return { kind: "external", provider: input.provider, providerFileId: input.providerFileId, vaultId: input.vaultId };
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

export async function openPdf(input: OpenPdfInput): Promise<OpenPdfResult> {
  const source = await resolveSource(input);
  const bytes = await readSource(source);
  assertPdf(bytes.buffer, bytes.contentType);
  const handle = issueHandle(source);
  return {
    handle,
    streamUrl: `/api/pdf/content/${encodeURIComponent(handle)}`,
    metadata: {
      documentId: bytes.document?.id ?? null,
      title: bytes.title,
      mimeType: PDF_MIME,
      byteSize: bytes.buffer.length,
      pageCount: bytes.document?.pageCount ?? null,
      sourceKind: bytes.sourceKind,
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
