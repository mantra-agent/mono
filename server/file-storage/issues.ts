import { documentStorage } from "../memory/document-storage";
import { documentStoreDocuments, issueKindEnum, issueStatusEnum, users, type Issue, type InsertIssue, type IssueStatus, type IssueNote } from "@shared/schema";
import { createLogger } from "../log";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db, runWithDatabaseTransaction } from "../db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Principal } from "../principal";
import { createUserPrincipalFromUser } from "../principal";
import { principalHasPermission } from "../permissions";
import { runWithPrincipal, requireCurrentPrincipal } from "../principal-context";

const log = createLogger("StoreIssues");

export class IssueCreateValidationError extends Error {
  readonly code = "issue_create_validation";
  constructor(message: string) {
    super(message);
    this.name = "IssueCreateValidationError";
  }
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeReproSteps(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function parseOptionalPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function issueToContent(issue: Issue): string {
  let body = "";

  if (issue.description) {
    body += issue.description + "\n";
  }

  if (issue.reproSteps) {
    body += "\n## Repro Steps\n\n" + issue.reproSteps + "\n";
  }

  if (issue.spec) {
    body += "\n## Spec\n\n" + issue.spec + "\n";
  }

  if (issue.feedback) {
    body += "\n## Feedback\n\n" + issue.feedback + "\n";
  }

  if (issue.logs) {
    body += "\n## Logs\n\n```\n" + issue.logs + "\n```\n";
  }

  const notes: IssueNote[] = Array.isArray(issue.notes) ? issue.notes as IssueNote[] : [];
  if (notes.length > 0) {
    body += "\n## Activity\n";
    for (const note of notes) {
      const ts = note.timestamp || "";
      const author = note.author || "unknown";
      body += `\n### ${ts} [${author}]\n\n${note.content}\n`;
      if (note.statusChange) {
        body += `\n*Status: ${note.statusChange.from} → ${note.statusChange.to}*\n`;
      }
    }
  }

  return body.trim();
}

function parseContent(content: string): {
  description: string;
  reproSteps: string | null;
  spec: string | null;
  feedback: string | null;
  logs: string | null;
  notes: IssueNote[];
} {
  const body = content.trim();

  const reproMatch = body.match(/\n## Repro Steps\n\n([\s\S]*?)(?=\n## |\n$|$)/);
  const specMatch = body.match(/\n## Spec\n\n([\s\S]*?)(?=\n## |\n$|$)/);
  const feedbackMatch = body.match(/\n## Feedback\n\n([\s\S]*?)(?=\n## |\n$|$)/);
  const logsMatch = body.match(/\n## Logs\n\n```\n([\s\S]*?)\n```/);
  const activityMatch = body.match(/\n## Activity\n([\s\S]*?)$/);

  let description = body;
  const firstSection = body.indexOf("\n## ");
  if (firstSection > -1) {
    description = body.substring(0, firstSection);
  }
  description = description.trim();

  let notes: IssueNote[] = [];
  if (activityMatch) {
    const activityBlock = activityMatch[1];
    const noteBlocks = activityBlock.split(/\n### /).filter(Boolean);
    for (const block of noteBlocks) {
      const headerMatch = block.match(/^(.+?)\s+\[(\w+)\]\n\n?([\s\S]*?)(?:\n\n\*Status:\s*(\S+)\s*→\s*(\S+)\*)?$/);
      if (headerMatch) {
        const note: IssueNote = {
          id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: headerMatch[1].trim(),
          author: headerMatch[2] as "user" | "agent",
          content: headerMatch[3].trim(),
        };
        if (headerMatch[4] && headerMatch[5]) {
          note.statusChange = { from: headerMatch[4] as IssueStatus, to: headerMatch[5] as IssueStatus };
        }
        notes.push(note);
      }
    }
  }

  return {
    description,
    reproSteps: reproMatch ? reproMatch[1].trim() : null,
    spec: specMatch ? specMatch[1].trim() : null,
    feedback: feedbackMatch ? feedbackMatch[1].trim() : null,
    logs: logsMatch ? logsMatch[1].trim() : null,
    notes,
  };
}

function docToIssue(
  doc: { content: string; metadata: Record<string, unknown> },
  reporterEmail?: string | null,
): Issue {
  const meta = doc.metadata;
  const parsed = parseContent(doc.content || "");
  const reproFromMeta = normalizeOptionalText(meta.reproSteps);
  const buildIdRaw = meta.buildId;
  const buildId =
    typeof buildIdRaw === "string" && buildIdRaw.trim().length > 0
      ? buildIdRaw.trim()
      : null;

  return {
    id: typeof meta.id === "number" ? meta.id : parseInt(String(meta.id), 10),
    title: String(meta.title || "Untitled"),
    description: String(meta.description || parsed.description || ""),
    reproSteps: reproFromMeta || parsed.reproSteps || "",
    status: String(meta.status || "open"),
    kind: issueKindEnum.catch("tracked").parse(meta.kind),
    page: (meta.page as string) || null,
    screenshot: (meta.screenshot as string) || null,
    spec: (meta.spec as string) || parsed.spec || null,
    feedback: (meta.feedback as string) || parsed.feedback || null,
    notes: (meta.notes as IssueNote[]) || parsed.notes || null,
    logs: (meta.logs as string) || parsed.logs || null,
    dependencies: (meta.dependencies as number[]) || null,
    platformEnvironmentId: parseOptionalPositiveInt(meta.platformEnvironmentId),
    buildId,
    productId: parseOptionalPositiveInt(meta.productId) ?? 0,
    createdAt: meta.createdAt ? new Date(String(meta.createdAt)) : new Date(),
    reporterEmail: reporterEmail ?? null,
  };
}

function toLightweightIssue(issue: Issue): Partial<Issue> {
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    kind: issue.kind,
    page: issue.page,
    platformEnvironmentId: issue.platformEnvironmentId,
    buildId: issue.buildId,
    createdAt: issue.createdAt,
    reporterEmail: issue.reporterEmail ?? null,
  };
}

async function reporterEmailsByIssueIds(issueIds: number[]): Promise<Map<number, string | null>> {
  const ids = Array.from(new Set(issueIds.filter((id) => Number.isInteger(id) && id > 0)));
  const map = new Map<number, string | null>();
  if (ids.length === 0) return map;

  const rows = await db
    .select({
      issueId: documentStoreDocuments.documentId,
      email: users.email,
    })
    .from(documentStoreDocuments)
    .leftJoin(users, eq(documentStoreDocuments.ownerUserId, users.id))
    .where(and(
      eq(documentStoreDocuments.documentType, "issue"),
      inArray(documentStoreDocuments.documentId, ids.map(String)),
    ));

  for (const row of rows) {
    const id = Number(row.issueId);
    if (!Number.isInteger(id) || id <= 0) continue;
    map.set(id, typeof row.email === "string" && row.email.trim() ? row.email.trim() : null);
  }
  return map;
}

function issueMetadata(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    title: issue.title,
    description: issue.description,
    reproSteps: issue.reproSteps,
    status: issue.status,
    kind: issue.kind,
    page: issue.page,
    screenshot: issue.screenshot,
    dependencies: issue.dependencies,
    platformEnvironmentId: issue.platformEnvironmentId,
    buildId: issue.buildId,
    productId: issue.productId,
    createdAt: issue.createdAt instanceof Date ? issue.createdAt.toISOString() : String(issue.createdAt),
  };
}

interface ReportedIssueOwner {
  userId: string;
  accountId: string;
  vaultId: string | null;
}

function requireAdminIssuePermission(principal: Principal, permission: "system:read" | "system:write"): void {
  if (principal.actorType !== "user" || !principal.userId || !principalHasPermission(principal, permission)) {
    throw Object.assign(new Error(`Permission required: ${permission}`), { statusCode: 403 });
  }
}

function adminOwnerPrincipal(
  principal: Principal,
  user: typeof users.$inferSelect,
  owner: ReportedIssueOwner,
): Principal {
  const restored = createUserPrincipalFromUser(user, owner.accountId);
  return {
    ...restored,
    activeVaultId: owner.vaultId,
    visibleVaultIds: owner.vaultId ? [owner.vaultId] : [],
    impersonation: {
      impersonatedByActorType: principal.actorType,
      impersonatedByUserId: principal.userId,
      impersonatedByAccountId: principal.accountId,
      reason: "admin reported-Issue triage",
    },
  };
}

export class FileIssueStorage {
  async getIssues(options?: { status?: string; excludeStatus?: string; lightweight?: boolean; platformEnvironmentId?: number }): Promise<Issue[] | Partial<Issue>[]> {
    const filters: Record<string, unknown> = {};
    if (options?.status) {
      filters.status = options.status;
    }

    const docs = await documentStorage.getDocumentsByType("issue", Object.keys(filters).length > 0 ? filters : undefined);
    let allIssues: Issue[] = [];

    for (const doc of docs) {
      try {
        const issue = docToIssue({ content: doc.content, metadata: (doc.metadata || {}) as Record<string, unknown> });
        if (options?.excludeStatus && issue.status === options.excludeStatus) continue;
        if (options?.platformEnvironmentId && issue.platformEnvironmentId !== options.platformEnvironmentId) continue;
        allIssues.push(issue);
      } catch (err) {
        log.error(`getIssues parse error docId=${doc.docId}`, err);
      }
    }

    allIssues.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const reporters = await reporterEmailsByIssueIds(allIssues.map((issue) => issue.id));
    allIssues = allIssues.map((issue) => ({
      ...issue,
      reporterEmail: reporters.get(issue.id) ?? null,
    }));

    log.log(`getIssues count=${allIssues.length} status=${options?.status || "all"} lightweight=${!!options?.lightweight}`);

    if (options?.lightweight) {
      return allIssues.map(toLightweightIssue);
    }

    return allIssues;
  }

  async getIssue(id: number): Promise<Issue | undefined> {
    const doc = await documentStorage.getDocument("issue", String(id));
    if (!doc) {
      log.log(`getIssue id=${id} not-found`);
      return undefined;
    }
    try {
      log.log(`getIssue id=${id} found`);
      const issue = docToIssue({ content: doc.content, metadata: (doc.metadata || {}) as Record<string, unknown> });
      const reporters = await reporterEmailsByIssueIds([issue.id]);
      return {
        ...issue,
        reporterEmail: reporters.get(issue.id) ?? null,
      };
    } catch (err) {
      log.error(`getIssue id=${id} parse error`, err);
      return undefined;
    }
  }

  /** Admin queue projection: own Issues plus every explicitly reported Issue. */
  async getIssuesForAdmin(
    principal: Principal,
    options?: { status?: string; excludeStatus?: string; lightweight?: boolean; platformEnvironmentId?: number },
  ): Promise<Issue[] | Partial<Issue>[]> {
    requireAdminIssuePermission(principal, "system:read");
    const conditions = [
      eq(documentStoreDocuments.documentType, "issue"),
      sql`${documentStoreDocuments.metadata}->>'kind' = 'reported'`,
    ];
    if (options?.status) conditions.push(sql`${documentStoreDocuments.metadata}->>'status' = ${options.status}`);
    const docs = await db
      .select({ content: documentStoreDocuments.content, metadata: documentStoreDocuments.metadata })
      .from(documentStoreDocuments)
      .where(and(...conditions))
      .orderBy(sql`${documentStoreDocuments.createdAt} DESC`)
      .limit(500);

    const ownIssues = await this.getIssues(options);
    const byId = new Map<number, Issue>();
    for (const issue of ownIssues) byId.set(Number(issue.id), issue as Issue);
    for (const doc of docs) {
      try {
        const issue = docToIssue({ content: doc.content, metadata: (doc.metadata || {}) as Record<string, unknown> });
        if (options?.excludeStatus && issue.status === options.excludeStatus) continue;
        if (options?.platformEnvironmentId && issue.platformEnvironmentId !== options.platformEnvironmentId) continue;
        byId.set(issue.id, issue);
      } catch (error) {
        log.error("admin reported Issue projection parse failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    let issues = Array.from(byId.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const reporters = await reporterEmailsByIssueIds(issues.map((issue) => issue.id));
    issues = issues.map((issue) => ({
      ...issue,
      reporterEmail: reporters.get(issue.id) ?? issue.reporterEmail ?? null,
    }));
    if (!options?.lightweight) return issues;
    return issues.map(toLightweightIssue);
  }

  async getIssueForAdmin(principal: Principal, id: number): Promise<Issue | undefined> {
    return this.withAdminIssueOwner(principal, id, "system:read", () => this.getIssue(id));
  }

  async updateIssueForAdmin(principal: Principal, id: number, updates: Partial<InsertIssue>): Promise<Issue | undefined> {
    return this.withAdminIssueOwner(principal, id, "system:write", () => this.updateIssue(id, updates));
  }

  async addNoteForAdmin(
    principal: Principal,
    id: number,
    text: string,
    author: "user" | "agent" = "agent",
  ): Promise<Issue | undefined> {
    return this.withAdminIssueOwner(principal, id, "system:write", () => this.addNote(id, text, author));
  }

  async resolveWithEvidenceForAdmin(
    principal: Principal,
    id: number,
    evidenceNote: string,
  ): Promise<Issue | undefined> {
    return this.withAdminIssueOwner(principal, id, "system:write", () => this.resolveWithEvidence(id, evidenceNote));
  }

  async readAttachmentForAdmin(
    principal: Principal,
    filename: string,
  ): Promise<Awaited<ReturnType<typeof documentStorage.getDocument>>> {
    requireAdminIssuePermission(principal, "system:read");
    const [issueRow] = await db
      .select({ issueId: documentStoreDocuments.documentId })
      .from(documentStoreDocuments)
      .where(and(
        eq(documentStoreDocuments.documentType, "issue"),
        sql`${documentStoreDocuments.metadata}->>'kind' = 'reported'`,
        sql`${documentStoreDocuments.metadata}->>'screenshot' = ${`/api/issues/screenshots/${filename}`}`,
      ))
      .limit(1);
    const issueId = Number(issueRow?.issueId);
    if (!Number.isInteger(issueId) || issueId <= 0) return null;
    return (await this.withAdminIssueOwner(
      principal,
      issueId,
      "system:read",
      () => documentStorage.getDocument("issue_attachment" as any, filename),
    )) ?? null;
  }

  async deleteIssueForAdmin(principal: Principal, id: number): Promise<boolean> {
    return (await this.withAdminIssueOwner(principal, id, "system:write", async () => {
      const issue = await this.getIssue(id);
      if (!issue) return false;
      const filename = issue.screenshot?.match(/issue-\d+\.png$/)?.[0];
      if (filename) await documentStorage.deleteDocument("issue_attachment" as any, filename);
      return this.deleteIssue(id);
    })) ?? false;
  }

  private async withAdminIssueOwner<T>(
    principal: Principal,
    id: number,
    permission: "system:read" | "system:write",
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    requireAdminIssuePermission(principal, permission);
    if (await this.getIssue(id)) return operation();

    const [row] = await db
      .select({ userId: documentStoreDocuments.ownerUserId, accountId: documentStoreDocuments.accountId, vaultId: documentStoreDocuments.vaultId })
      .from(documentStoreDocuments)
      .where(and(
        eq(documentStoreDocuments.documentType, "issue"),
        eq(documentStoreDocuments.documentId, String(id)),
        sql`${documentStoreDocuments.metadata}->>'kind' = 'reported'`,
        eq(documentStoreDocuments.scope, "user"),
        sql`${documentStoreDocuments.ownerUserId} IS NOT NULL`,
        sql`${documentStoreDocuments.accountId} IS NOT NULL`,
      ))
      .limit(1);
    if (!row?.userId || !row.accountId) return undefined;
    const [ownerUser] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (!ownerUser) return undefined;
    return runWithPrincipal(
      adminOwnerPrincipal(principal, ownerUser, { userId: row.userId, accountId: row.accountId, vaultId: row.vaultId }),
      operation,
    );
  }

  async createIssue(issue: InsertIssue): Promise<Issue> {
    const title = normalizeOptionalText(issue.title);
    if (!title) {
      throw new IssueCreateValidationError("Issue title is required");
    }

    const reproSteps = normalizeReproSteps(issue.reproSteps);
    if (!reproSteps) {
      throw new IssueCreateValidationError(
        "Issue reproSteps is required. Do not file title-only shells.",
      );
    }

    // Resolve env/build from caller when provided; otherwise fill from runtime identity.
    let platformEnvironmentId = parseOptionalPositiveInt(issue.platformEnvironmentId);
    let buildId = normalizeOptionalText(issue.buildId);

    if (platformEnvironmentId == null || buildId == null) {
      try {
        const { getRuntimeIdentity } = await import("../runtime-identity");
        const runtime = await getRuntimeIdentity();
        if (platformEnvironmentId == null) {
          platformEnvironmentId = parseOptionalPositiveInt(runtime.platformEnvironmentId);
        }
        if (buildId == null) {
          // Railway does not inject a deployment ID into the application runtime.
          // The served Git commit is the stable build identity available on every deploy.
          buildId = normalizeOptionalText(runtime.gitCommit);
        }
      } catch (err) {
        log.warn("createIssue runtime identity lookup failed", err);
      }
    }

    if (platformEnvironmentId == null) {
      throw new IssueCreateValidationError(
        "Issue platformEnvironmentId is required. Pass it explicitly or ensure runtime identity resolves a Platforms Environment.",
      );
    }
    if (buildId == null) {
      throw new IssueCreateValidationError(
        "Issue buildId is required. Pass the provider deployment/build id explicitly or ensure runtime identity resolves one.",
      );
    }

    let productId = parseOptionalPositiveInt(issue.productId);
    if (productId == null) {
      const { products } = await import("@shared/models/platforms");
      const { combineWithVisibleScope } = await import("../scoped-storage");
      const principal = requireCurrentPrincipal();
      const webNamePredicate = sql`lower(${products.name}) = 'web'`;
      // Prefer the reporter's own visible Web product (correct per-account default).
      const [ownWeb] = await db.select({ id: products.id }).from(products).where(combineWithVisibleScope(principal, { scope: products.scope, ownerUserId: products.ownerUserId, accountId: products.accountId }, webNamePredicate)).orderBy(products.id).limit(1);
      productId = ownWeb?.id ?? null;
      // Report Issue is Core feedback available to every authenticated user; a reporter
      // without their own Web product still files against the canonical Web product by name.
      if (productId == null) {
        const [canonicalWeb] = await db.select({ id: products.id }).from(products).where(webNamePredicate).orderBy(products.id).limit(1);
        productId = canonicalWeb?.id ?? null;
      }
    }
    if (productId == null) throw new IssueCreateValidationError("Issue productId is required and no canonical Web Product is available");

    const id = Date.now() + Math.floor(Math.random() * 1000);
    const now = new Date();
    const full: Issue = {
      id,
      title,
      description: typeof issue.description === "string" ? issue.description : "",
      reproSteps,
      status: issue.status || "open",
      kind: issueKindEnum.parse(issue.kind || "tracked"),
      page: issue.page || null,
      screenshot: issue.screenshot || null,
      spec: issue.spec || null,
      feedback: issue.feedback || null,
      notes: issue.notes || null,
      logs: issue.logs || null,
      dependencies: issue.dependencies || null,
      platformEnvironmentId,
      buildId,
      productId,
      createdAt: now,
    };

    const content = issueToContent(full);
    const metadata = issueMetadata(full);

    await documentStorage.upsertDocument(
      "issue",
      String(id),
      `issues/${id}.md`,
      full.title,
      content,
      metadata
    );

    log.log(
      `createIssue id=${id} title="${full.title}" status=${full.status} env=${full.platformEnvironmentId} build=${full.buildId}`,
    );
    return full;
  }

  private async updateIssueLocked(id: number, updates: Partial<InsertIssue>): Promise<Issue | undefined> {
    const existing = await this.getIssue(id);
    if (!existing) {
      log.log(`updateIssue id=${id} not-found`);
      return undefined;
    }

    const effectiveUpdates: Partial<InsertIssue> = { ...updates };
    if (effectiveUpdates.feedback && effectiveUpdates.status === undefined) {
      effectiveUpdates.status = "open";
    }
    if (effectiveUpdates.status !== undefined) {
      effectiveUpdates.status = issueStatusEnum.parse(effectiveUpdates.status);
    }
    if (effectiveUpdates.status && effectiveUpdates.status !== existing.status) {
      const notes = Array.isArray(effectiveUpdates.notes)
        ? effectiveUpdates.notes as IssueNote[]
        : Array.isArray(existing.notes)
          ? existing.notes as IssueNote[]
          : [];
      effectiveUpdates.notes = [
        ...notes,
        {
          id: `status-${Date.now()}`,
          author: "agent",
          content: "",
          timestamp: new Date().toISOString(),
          statusChange: {
            from: existing.status as IssueStatus,
            to: effectiveUpdates.status as IssueStatus,
          },
        },
      ];
    }

    if (effectiveUpdates.reproSteps !== undefined) {
      const nextRepro = normalizeReproSteps(effectiveUpdates.reproSteps);
      if (!nextRepro) {
        throw new IssueCreateValidationError(
          "Issue reproSteps is required.",
        );
      }
      effectiveUpdates.reproSteps = nextRepro;
    }
    if (effectiveUpdates.platformEnvironmentId !== undefined) {
      const nextEnv = parseOptionalPositiveInt(effectiveUpdates.platformEnvironmentId);
      if (nextEnv == null) {
        throw new IssueCreateValidationError("Issue platformEnvironmentId must be a positive integer when set.");
      }
      effectiveUpdates.platformEnvironmentId = nextEnv;
    }
    if (effectiveUpdates.buildId !== undefined) {
      const nextBuild = normalizeOptionalText(effectiveUpdates.buildId);
      if (nextBuild == null) {
        throw new IssueCreateValidationError("Issue buildId must be a non-empty string when set.");
      }
      effectiveUpdates.buildId = nextBuild;
    }

    const nextKind = effectiveUpdates.kind !== undefined
      ? issueKindEnum.parse(effectiveUpdates.kind)
      : existing.kind;
    const updated: Issue = {
      ...existing,
      ...effectiveUpdates,
      id: existing.id,
      createdAt: existing.createdAt,
      kind: nextKind,
      reproSteps: (effectiveUpdates.reproSteps as string | undefined) ?? existing.reproSteps,
      platformEnvironmentId:
        (effectiveUpdates.platformEnvironmentId as number | undefined) ?? existing.platformEnvironmentId,
      buildId: (effectiveUpdates.buildId as string | undefined) ?? existing.buildId,
      reporterEmail: existing.reporterEmail ?? null,
    };
    const content = issueToContent(updated);
    const metadata = issueMetadata(updated);

    await documentStorage.upsertDocument(
      "issue",
      String(id),
      `issues/${id}.md`,
      updated.title,
      content,
      metadata
    );

    log.log(`updateIssue id=${id} fields=${Object.keys(effectiveUpdates).join(",")}`);
    return updated;
  }

  async updateIssue(id: number, updates: Partial<InsertIssue>): Promise<Issue | undefined> {
    return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.ISSUE, String(id));
      return this.updateIssueLocked(id, updates);
    }));
  }

  async resolveWithEvidence(id: number, evidenceNote: string): Promise<Issue | undefined> {
    const note = evidenceNote.trim();
    if (!note || note.length > 2_000) {
      throw new Error("Issue resolution evidence must be 1-2000 characters");
    }

    return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.ISSUE, String(id));
      const existing = await this.getIssue(id);
      if (!existing) return undefined;
      if (existing.status === "resolved") return existing;

      const timestamp = new Date().toISOString();
      const existingNotes = Array.isArray(existing.notes)
        ? existing.notes as IssueNote[]
        : [];
      return this.updateIssueLocked(id, {
        status: "resolved",
        notes: [
          ...existingNotes,
          {
            id: `evidence-${Date.now()}`,
            author: "agent",
            content: note,
            timestamp,
          },
        ],
      });
    }));
  }

  async addNote(id: number, text: string, author: "user" | "agent" = "agent"): Promise<Issue | undefined> {
    const content = typeof text === "string" ? text.trim() : "";
    if (!content || content.length > 5_000) {
      throw new Error("Issue note text must be 1-5000 characters");
    }

    return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.ISSUE, String(id));
      const existing = await this.getIssue(id);
      if (!existing) return undefined;

      const existingNotes = Array.isArray(existing.notes)
        ? existing.notes as IssueNote[]
        : [];
      // Append-only: each call adds a new immutable entry; existing entries are never rewritten.
      const entry: IssueNote = {
        id: `note-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        author,
        content,
        timestamp: new Date().toISOString(),
      };
      return this.updateIssueLocked(id, {
        notes: [...existingNotes, entry],
      });
    }));
  }

  async deleteIssue(id: number): Promise<boolean> {
    const result = await documentStorage.deleteDocument("issue", String(id));
    log.log(`deleteIssue id=${id} success=${result}`);
    return result;
  }

  async writeIssueWithId(issue: Issue): Promise<void> {
    const content = issueToContent(issue);
    const metadata = issueMetadata(issue);

    await documentStorage.upsertDocument(
      "issue",
      String(issue.id),
      `issues/${issue.id}.md`,
      issue.title,
      content,
      metadata
    );
    log.log(`writeIssueWithId id=${issue.id} title="${issue.title}"`);
  }
}

export const fileIssueStorage = new FileIssueStorage();
