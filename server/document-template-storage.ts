import { and, asc, eq, or, sql } from "drizzle-orm";
import {
  documentTemplates,
  isDocumentTemplateBindingKey,
  skillTemplateBindings,
  type DocumentTemplate,
  type DocumentTemplateBindingKey,
  type DocumentTemplateCreate,
  type DocumentTemplateStatus,
  type DocumentTemplateUpdate,
  type ResolvedDocumentTemplate,
  type SkillTemplateBinding,
} from "@shared/models/document-templates";
import { libraryPages } from "@shared/models/info";
import { skills } from "@shared/models/skills";
import type { Principal } from "./principal";
import { ADVISORY_LOCK_NS, acquireAdvisoryTransactionLock, db } from "./db";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";
import { libraryPageIsLive } from "./library-trash";
import {
  assertVisible,
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";

const log = createLogger("DocumentTemplates");

const templateScopeColumns = {
  scope: documentTemplates.scope,
  ownerUserId: documentTemplates.ownerUserId,
  accountId: documentTemplates.accountId,
};

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

function userPrincipal(principal?: Principal): Principal & { actorType: "user"; userId: string; accountId: string } {
  if (principal?.actorType === "user" && principal.userId && principal.accountId) {
    return principal as Principal & { actorType: "user"; userId: string; accountId: string };
  }
  return requireCurrentUserPrincipal();
}

function mapTemplate(row: typeof documentTemplates.$inferSelect): DocumentTemplate {
  return {
    id: row.id,
    name: row.name,
    pageId: row.pageId,
    status: row.status as DocumentTemplateStatus,
    scope: row.scope as "global" | "user",
    ownerUserId: row.ownerUserId ?? null,
    accountId: row.accountId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapBinding(row: typeof skillTemplateBindings.$inferSelect): SkillTemplateBinding {
  return {
    id: row.id,
    skillId: row.skillId,
    key: row.key as DocumentTemplateBindingKey,
    templateId: row.templateId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeId(value: unknown): string {
  if (typeof value !== "string") throw new Error("Template id must be a string");
  const id = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!id) throw new Error("Template id is required");
  if (!/^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/.test(id)) {
    throw new Error("Template id must be lowercase letters, numbers, and hyphens");
  }
  return id;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Template name must be a string");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Template name is required");
  return name;
}

function normalizePageId(value: unknown): string {
  if (typeof value !== "string") throw new Error("Template pageId must be a string");
  const pageId = value.trim();
  if (!pageId) throw new Error("Template pageId is required");
  return pageId;
}

function normalizeStatus(value: unknown): DocumentTemplateStatus {
  if (value === undefined || value === null || value === "") return "active";
  if (value === "active" || value === "deprecated") return value;
  throw new Error("Template status must be active or deprecated");
}

function uniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505");
}

async function assertPageVisible(
  principal: Principal,
  pageId: string,
): Promise<{ id: string; title: string; plainTextContent: string }> {
  const [page] = await db
    .select({
      id: libraryPages.id,
      title: libraryPages.title,
      plainTextContent: libraryPages.plainTextContent,
      scope: libraryPages.scope,
      ownerUserId: libraryPages.ownerUserId,
      accountId: libraryPages.accountId,
      vaultId: libraryPages.vaultId,
    })
    .from(libraryPages)
    .where(
      combineWithVisibleScope(
        principal,
        libraryScopeColumns,
        and(eq(libraryPages.id, pageId), libraryPageIsLive()),
      ),
    )
    .limit(1);
  if (!page) throw new Error("Library page not found or not visible");
  assertVisible(principal, page, "Library page");
  return { id: page.id, title: page.title, plainTextContent: page.plainTextContent ?? "" };
}

export class DocumentTemplateStorage {
  private mutationLockKey(principal: Principal & { userId: string; accountId: string }): string {
    return `${principal.userId}:${principal.accountId}`;
  }

  /** List global + account templates visible to the principal. */
  async list(query?: string, principal?: Principal): Promise<DocumentTemplate[]> {
    const current = userPrincipal(principal);
    const needle = query?.trim();
    const search = needle
      ? sql`(
          ${documentTemplates.id} ILIKE ${"%" + needle.replaceAll("%", "\\%") + "%"}
          OR ${documentTemplates.name} ILIKE ${"%" + needle.replaceAll("%", "\\%") + "%"}
        )`
      : undefined;
    const rows = await db
      .select()
      .from(documentTemplates)
      .where(
        combineWithVisibleScope(
          current,
          templateScopeColumns,
          search
            ? and(search, or(eq(documentTemplates.status, "active"), eq(documentTemplates.status, "deprecated")))
            : undefined,
        ),
      )
      .orderBy(asc(documentTemplates.name), asc(documentTemplates.id));

    const byId = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const existing = byId.get(row.id);
      if (!existing) {
        byId.set(row.id, row);
        continue;
      }
      if (row.scope === "user" && existing.scope === "global") {
        byId.set(row.id, row);
      }
    }
    return [...byId.values()].map(mapTemplate);
  }

  async get(id: string, principal?: Principal): Promise<DocumentTemplate | null> {
    const current = userPrincipal(principal);
    const normalized = normalizeId(id);
    const [accountRow] = await db
      .select()
      .from(documentTemplates)
      .where(
        and(
          eq(documentTemplates.id, normalized),
          eq(documentTemplates.scope, "user"),
          eq(documentTemplates.accountId, current.accountId),
        ),
      )
      .limit(1);
    if (accountRow) return mapTemplate(accountRow);

    const [globalRow] = await db
      .select()
      .from(documentTemplates)
      .where(and(eq(documentTemplates.id, normalized), eq(documentTemplates.scope, "global")))
      .limit(1);
    return globalRow ? mapTemplate(globalRow) : null;
  }

  /**
   * Create an account-scoped template. Reusing a global id is the overlay
   * (copy-on-write the row, point pageId at a different page).
   */
  async create(input: DocumentTemplateCreate, principal?: Principal): Promise<DocumentTemplate> {
    const current = userPrincipal(principal);
    const id = normalizeId(input.id);
    const name = normalizeName(input.name);
    const pageId = normalizePageId(input.pageId);
    const status = normalizeStatus(input.status);
    await assertPageVisible(current, pageId);

    try {
      return await db.transaction(async (tx) => {
        await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.DOCUMENT_TEMPLATE, this.mutationLockKey(current));
        const [created] = await tx
          .insert(documentTemplates)
          .values({
            id,
            name,
            pageId,
            status,
            createdByUserId: current.userId,
            ...ownedInsertValues(current, templateScopeColumns),
            scope: "user",
            ownerUserId: current.userId,
            accountId: current.accountId,
          })
          .returning();
        return mapTemplate(created);
      });
    } catch (error) {
      if (uniqueConflict(error)) throw new Error(`A template with id "${id}" already exists for this account`);
      throw error;
    }
  }

  /**
   * Update name/page/status. Global rows are not writable by ordinary users —
   * updating a global id creates or patches the account overlay.
   */
  async update(id: string, input: DocumentTemplateUpdate, principal?: Principal): Promise<DocumentTemplate | null> {
    const current = userPrincipal(principal);
    const normalized = normalizeId(id);
    const patch: Partial<typeof documentTemplates.$inferInsert> = { updatedAt: new Date() };
    if (typeof input.name === "string" && input.name.trim()) patch.name = normalizeName(input.name);
    if (typeof input.pageId === "string" && input.pageId.trim()) {
      const pageId = normalizePageId(input.pageId);
      await assertPageVisible(current, pageId);
      patch.pageId = pageId;
    }
    if (input.status !== undefined) patch.status = normalizeStatus(input.status);
    if (Object.keys(patch).length === 1) throw new Error("Template update requires at least one field");

    return db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.DOCUMENT_TEMPLATE, this.mutationLockKey(current));

      const [writable] = await tx
        .select()
        .from(documentTemplates)
        .where(
          combineWithWritableScope(
            current,
            templateScopeColumns,
            and(eq(documentTemplates.id, normalized), eq(documentTemplates.scope, "user")),
          ),
        )
        .limit(1);

      if (writable) {
        const [updated] = await tx
          .update(documentTemplates)
          .set(patch)
          .where(
            and(
              eq(documentTemplates.id, normalized),
              eq(documentTemplates.scope, "user"),
              eq(documentTemplates.accountId, current.accountId),
            ),
          )
          .returning();
        return updated ? mapTemplate(updated) : null;
      }

      const [globalRow] = await tx
        .select()
        .from(documentTemplates)
        .where(and(eq(documentTemplates.id, normalized), eq(documentTemplates.scope, "global")))
        .limit(1);
      if (!globalRow) return null;

      const [created] = await tx
        .insert(documentTemplates)
        .values({
          id: globalRow.id,
          name: typeof patch.name === "string" ? patch.name : globalRow.name,
          pageId: typeof patch.pageId === "string" ? patch.pageId : globalRow.pageId,
          status: typeof patch.status === "string" ? patch.status : globalRow.status,
          scope: "user",
          ownerUserId: current.userId,
          accountId: current.accountId,
          createdByUserId: current.userId,
        })
        .onConflictDoNothing()
        .returning();

      if (created) return mapTemplate(created);

      const [updated] = await tx
        .update(documentTemplates)
        .set(patch)
        .where(
          and(
            eq(documentTemplates.id, normalized),
            eq(documentTemplates.scope, "user"),
            eq(documentTemplates.accountId, current.accountId),
          ),
        )
        .returning();
      return updated ? mapTemplate(updated) : null;
    });
  }

  async bind(skillId: string, key: string, templateId: string, principal?: Principal): Promise<SkillTemplateBinding> {
    const current = userPrincipal(principal);
    if (!isDocumentTemplateBindingKey(key)) {
      throw new Error(`Unknown template binding key "${key}". Closed set: spec, daily, weekly`);
    }
    const normalizedTemplateId = normalizeId(templateId);

    const [skill] = await db
      .select({
        id: skills.id,
        scope: skills.scope,
        ownerUserId: skills.ownerUserId,
        accountId: skills.accountId,
      })
      .from(skills)
      .where(eq(skills.id, skillId))
      .limit(1);
    if (!skill) throw new Error("Skill not found");
    if (skill.scope !== "global") {
      if (skill.ownerUserId !== current.userId && skill.accountId !== current.accountId) {
        throw new Error("Skill not found");
      }
    }

    const template = await this.get(normalizedTemplateId, current);
    if (!template) throw new Error(`Template "${normalizedTemplateId}" not found`);
    await assertPageVisible(current, template.pageId);

    const [row] = await db
      .insert(skillTemplateBindings)
      .values({
        skillId: skill.id,
        key,
        templateId: normalizedTemplateId,
      })
      .onConflictDoUpdate({
        target: [skillTemplateBindings.skillId, skillTemplateBindings.key],
        set: { templateId: normalizedTemplateId, updatedAt: new Date() },
      })
      .returning();
    return mapBinding(row);
  }

  async listBindingsForSkill(skillId: string): Promise<SkillTemplateBinding[]> {
    const rows = await db.select().from(skillTemplateBindings).where(eq(skillTemplateBindings.skillId, skillId));
    return rows.map(mapBinding);
  }

  /** Reverse index: visible skills that bind this template id. Expand-only projection. */
  async listBindingsForTemplate(
    templateId: string,
    principal?: Principal,
  ): Promise<Array<{ id: string; name: string }>> {
    const current = userPrincipal(principal);
    const normalized = normalizeId(templateId);
    const skillScopeColumns = {
      scope: skills.scope,
      ownerUserId: skills.ownerUserId,
      accountId: skills.accountId,
      vaultId: skills.vaultId,
      instanceId: skills.instanceId,
    };
    const rows = await db
      .select({ id: skills.id, name: skills.name })
      .from(skillTemplateBindings)
      .innerJoin(skills, eq(skills.id, skillTemplateBindings.skillId))
      .where(
        and(
          eq(skillTemplateBindings.templateId, normalized),
          combineWithVisibleScope(current, skillScopeColumns),
          or(eq(skills.scope, "global"), eq(skills.scope, "user")),
        ),
      )
      .orderBy(asc(skills.name), asc(skills.id));
    const byId = new Map<string, { id: string; name: string }>();
    for (const row of rows) {
      if (!byId.has(row.id)) byId.set(row.id, { id: row.id, name: row.name });
    }
    return [...byId.values()];
  }

  /**
   * Resolve skill key → template id → visible page markdown.
   * Fail closed: missing binding/row/invisible page returns null (caller stamps Residual).
   */
  async resolve(skillNameOrId: string, key: string, principal?: Principal): Promise<ResolvedDocumentTemplate | null> {
    try {
      const current = userPrincipal(principal);
      if (!isDocumentTemplateBindingKey(key)) {
        log.warn("templates.resolve unknown key", { key });
        return null;
      }

      let skillId: string | null = null;
      let skillName: string | null = null;
      const [byId] = await db
        .select({ id: skills.id, name: skills.name })
        .from(skills)
        .where(eq(skills.id, skillNameOrId))
        .limit(1);
      if (byId) {
        skillId = byId.id;
        skillName = byId.name;
      } else {
        const [userSkill] = await db
          .select({ id: skills.id, name: skills.name })
          .from(skills)
          .where(and(eq(skills.name, skillNameOrId), eq(skills.scope, "user"), eq(skills.ownerUserId, current.userId)))
          .limit(1);
        if (userSkill) {
          skillId = userSkill.id;
          skillName = userSkill.name;
        } else {
          const [globalSkill] = await db
            .select({ id: skills.id, name: skills.name })
            .from(skills)
            .where(and(eq(skills.name, skillNameOrId), eq(skills.scope, "global")))
            .limit(1);
          if (globalSkill) {
            skillId = globalSkill.id;
            skillName = globalSkill.name;
          }
        }
      }
      if (!skillId || !skillName) {
        log.warn("templates.resolve skill missing", { skillNameOrId });
        return null;
      }

      const [binding] = await db
        .select()
        .from(skillTemplateBindings)
        .where(and(eq(skillTemplateBindings.skillId, skillId), eq(skillTemplateBindings.key, key)))
        .limit(1);
      if (!binding) {
        if (skillName) {
          const [globalSkill] = await db
            .select({ id: skills.id })
            .from(skills)
            .where(and(eq(skills.name, skillName), eq(skills.scope, "global")))
            .limit(1);
          if (globalSkill && globalSkill.id !== skillId) {
            const [globalBinding] = await db
              .select()
              .from(skillTemplateBindings)
              .where(and(eq(skillTemplateBindings.skillId, globalSkill.id), eq(skillTemplateBindings.key, key)))
              .limit(1);
            if (globalBinding) {
              return this.resolveTemplateRow(globalBinding.templateId, current);
            }
          }
        }
        log.warn("templates.resolve missing binding", { skillId, key });
        return null;
      }

      return this.resolveTemplateRow(binding.templateId, current);
    } catch (error) {
      log.warn("templates.resolve failed", {
        errorName: error instanceof Error ? error.name : typeof error,
        skillNameOrId,
        key,
      });
      return null;
    }
  }

  private async resolveTemplateRow(
    templateId: string,
    principal: Principal & { userId: string; accountId: string },
  ): Promise<ResolvedDocumentTemplate | null> {
    const template = await this.get(templateId, principal);
    if (!template || template.status === "deprecated") return null;
    try {
      const page = await assertPageVisible(principal, template.pageId);
      return {
        template,
        pageId: page.id,
        pageTitle: page.title,
        templateMarkdown: page.plainTextContent,
        source: template.scope === "user" ? "account" : "global",
      };
    } catch {
      return null;
    }
  }
}

export const documentTemplateStorage = new DocumentTemplateStorage();
