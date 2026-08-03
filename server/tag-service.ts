import type { PoolClient, QueryResultRow } from "pg";
import type {
  CoOccurrenceEdge,
  CreateTagInput,
  EntityType,
  Tag,
  TagIndex,
  TagSearchResult,
  TagUsageEntry,
  TagWithUsage,
  UpdateTagInput,
} from "@shared/schema";
import type { Principal } from "./principal";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { pool } from "./db";
import { createLogger } from "./log";
import { getSetting } from "./system-settings";

const log = createLogger("TagService");
const LEGACY_TAG_INDEX_KEY = "system.tags.index";
const LEGACY_ADOPTION_KEY = "legacy-json-v1";

interface ScopedIdentity {
  accountId: string;
  userId: string;
}

interface TagRow extends QueryResultRow {
  id: string;
  slug: string;
  label: string;
  color: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  usage_count: string | number;
}

interface AssignmentRow extends QueryResultRow {
  object_type: string;
  object_id: string;
  object_title: string;
  created_at: Date | string;
}

interface LegacyTagIndex {
  tags?: Record<string, Partial<Tag>>;
  usages?: Record<string, TagUsageEntry[]>;
}

export function normalizeTagSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeTagLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireUserIdentity(principal: Principal): ScopedIdentity {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Canonical Tags require an authenticated user principal");
  }
  return { accountId: principal.accountId, userId: principal.userId };
}

function rowToTag(row: TagRow): Tag {
  return {
    slug: row.slug,
    label: row.label,
    color: row.color,
    usageCount: Number(row.usage_count || 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class TagService {
  private principal(explicit?: Principal): Principal {
    return explicit || getCurrentPrincipalOrSystem();
  }

  private async withMutation<T>(
    operation: string,
    principal: Principal,
    mutate: (client: PoolClient, identity: ScopedIdentity) => Promise<T>,
  ): Promise<T> {
    const identity = requireUserIdentity(principal);
    const startedAt = Date.now();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tags:${identity.accountId}`]);
      const result = await mutate(client, identity);
      await client.query("COMMIT");
      log.info("canonical Tag mutation completed", {
        operation,
        accountId: identity.accountId,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      log.error("canonical Tag mutation failed", {
        operation,
        accountId: identity.accountId,
        error,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureLegacyAdopted(principal: Principal): Promise<void> {
    const identity = requireUserIdentity(principal);
    const migration = await pool.query(
      `SELECT status FROM tag_migrations WHERE account_id = $1 AND migration_key = $2`,
      [identity.accountId, LEGACY_ADOPTION_KEY],
    );
    if (migration.rowCount) return;

    const legacy = await getSetting<LegacyTagIndex>(LEGACY_TAG_INDEX_KEY);
    await this.withMutation("adopt_legacy_registry", principal, async (client, scoped) => {
      const existing = await client.query(
        `SELECT status FROM tag_migrations WHERE account_id = $1 AND migration_key = $2 FOR UPDATE`,
        [scoped.accountId, LEGACY_ADOPTION_KEY],
      );
      if (existing.rowCount) return;

      if (!legacy || !legacy.tags || Object.keys(legacy.tags).length === 0) {
        await this.recordMigration(client, scoped.accountId, "skipped", { reason: "empty" });
        return;
      }

      const ownership = await client.query<{ account_id: string; owner_user_id: string | null }>(
        `SELECT id AS account_id, owner_user_id FROM accounts ORDER BY created_at ASC`,
      );
      if (
        ownership.rows.length !== 1 ||
        ownership.rows[0].account_id !== scoped.accountId ||
        ownership.rows[0].owner_user_id !== scoped.userId
      ) {
        await this.recordMigration(client, scoped.accountId, "ambiguous", {
          reason: "legacy_registry_has_no_owner",
          accountCount: ownership.rows.length,
        });
        log.warn("legacy Tag registry adoption skipped because ownership is ambiguous", {
          accountId: scoped.accountId,
          accountCount: ownership.rows.length,
        });
        return;
      }

      let tagCount = 0;
      let assignmentCount = 0;
      for (const [legacySlug, legacyTag] of Object.entries(legacy.tags)) {
        const slug = normalizeTagSlug(legacyTag.slug || legacySlug);
        if (!slug) continue;
        const label = normalizeTagLabel(legacyTag.label || slug);
        const tagId = await this.upsertTagRow(client, scoped, slug, label, legacyTag.color ?? null);
        tagCount += 1;
        for (const usage of legacy.usages?.[legacySlug] || legacy.usages?.[slug] || []) {
          await this.insertAssignment(client, scoped, tagId, usage.entityType, usage.entityId, usage.entityTitle, "legacy_registry");
          assignmentCount += 1;
        }
      }
      await this.recordMigration(client, scoped.accountId, "completed", { tagCount, assignmentCount });
      log.info("legacy Tag registry adopted into canonical store", {
        accountId: scoped.accountId,
        tagCount,
        assignmentCount,
      });
    });
  }

  private async recordMigration(
    client: PoolClient,
    accountId: string,
    status: "completed" | "skipped" | "ambiguous",
    detail: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO tag_migrations(account_id, migration_key, status, detail)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (account_id, migration_key) DO NOTHING`,
      [accountId, LEGACY_ADOPTION_KEY, status, JSON.stringify(detail)],
    );
  }

  private async queryTagRows(identity: ScopedIdentity, slug?: string): Promise<TagRow[]> {
    const params: unknown[] = [identity.accountId, identity.userId];
    let slugClause = "";
    if (slug) {
      params.push(normalizeTagSlug(slug));
      slugClause = `AND t.slug = $3`;
    }
    const result = await pool.query<TagRow>(
      `SELECT t.id, t.slug, t.label, t.color, t.created_at, t.updated_at,
              COUNT(DISTINCT a.id)::int AS usage_count
       FROM tags t
       LEFT JOIN tag_assignments a ON a.tag_id = t.id AND a.account_id = t.account_id
       WHERE t.account_id = $1 AND t.owner_user_id = $2 ${slugClause}
       GROUP BY t.id
       ORDER BY t.label ASC`,
      params,
    );
    return result.rows;
  }

  async getIndex(principal = this.principal()): Promise<TagIndex> {
    await this.ensureLegacyAdopted(principal);
    const identity = requireUserIdentity(principal);
    const tags = await this.queryTagRows(identity);
    const index: TagIndex = { tags: {}, usages: {}, coOccurrences: [] };
    for (const row of tags) {
      const tag = rowToTag(row);
      index.tags[tag.slug] = tag;
      index.usages[tag.slug] = await this.getUsage(tag.slug, principal);
    }
    index.coOccurrences = this.buildCoOccurrences(index.usages);
    return index;
  }

  async listTags(principal = this.principal()): Promise<TagWithUsage[]> {
    await this.ensureLegacyAdopted(principal);
    const identity = requireUserIdentity(principal);
    const rows = await this.queryTagRows(identity);
    return Promise.all(rows.map(async row => ({ ...rowToTag(row), usages: await this.getUsage(row.slug, principal) })));
  }

  async getTag(slug: string, principal = this.principal()): Promise<TagWithUsage | null> {
    await this.ensureLegacyAdopted(principal);
    const identity = requireUserIdentity(principal);
    const [row] = await this.queryTagRows(identity, slug);
    if (!row) return null;
    const tag = rowToTag(row);
    return { ...tag, usages: await this.getUsage(tag.slug, principal) };
  }

  async searchTags(query: string, limit = 20, principal = this.principal()): Promise<TagSearchResult[]> {
    await this.ensureLegacyAdopted(principal);
    const identity = requireUserIdentity(principal);
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const normalizedQuery = query.trim().toLowerCase();
    const pattern = `%${normalizedQuery}%`;
    const prefix = `${normalizedQuery}%`;
    const result = await pool.query<TagRow & { usage_count: string }>(
      `SELECT t.id, t.slug, t.label, t.color, t.created_at, t.updated_at,
              COUNT(DISTINCT ta.id)::text AS usage_count
       FROM tags t
       LEFT JOIN tag_assignments ta ON ta.tag_id = t.id AND ta.account_id = t.account_id
       WHERE t.account_id = $1
         AND t.owner_user_id = $2
         AND (
           $3 = ''
           OR lower(t.slug) LIKE $4
           OR lower(t.label) LIKE $4
         )
       GROUP BY t.id
       ORDER BY
         CASE
           WHEN $3 = '' THEN 3
           WHEN lower(t.slug) = $3 OR lower(t.label) = $3 THEN 0
           WHEN lower(t.slug) LIKE $5 OR lower(t.label) LIKE $5 THEN 1
           ELSE 2
         END,
         COUNT(DISTINCT ta.id) DESC,
         t.label ASC
       LIMIT $6`,
      [identity.accountId, identity.userId, normalizedQuery, pattern, prefix, boundedLimit],
    );
    return result.rows.map(row => ({ ...rowToTag(row), usageCount: Number(row.usage_count) || 0 }));
  }

  async createTag(input: CreateTagInput, principal = this.principal()): Promise<Tag> {
    await this.ensureLegacyAdopted(principal);
    return this.withMutation("create", principal, async (client, identity) => {
      const slug = normalizeTagSlug(input.slug || input.label);
      const label = normalizeTagLabel(input.label);
      if (!slug || !label) throw new Error("Tag name must contain letters or numbers");
      await this.assertIdentityAvailable(client, identity.accountId, slug);
      const tagId = await this.upsertTagRow(client, identity, slug, label, input.color ?? null, false);
      const row = await this.fetchTagRow(client, identity, tagId);
      return rowToTag(row);
    });
  }

  async updateTag(slug: string, input: UpdateTagInput, principal = this.principal()): Promise<Tag | null> {
    await this.ensureLegacyAdopted(principal);
    return this.withMutation("update", principal, async (client, identity) => {
      const tag = await this.resolveTag(client, identity, slug);
      if (!tag) return null;
      const updates: string[] = [];
      const params: unknown[] = [];
      if (input.label !== undefined) {
        const label = normalizeTagLabel(input.label);
        const candidateSlug = normalizeTagSlug(label);
        if (!label || !candidateSlug) throw new Error("Tag name must contain letters or numbers");
        params.push(label);
        updates.push("label = $" + String(params.length));
        if (candidateSlug !== tag.slug) {
          await this.assertIdentityAvailable(client, identity.accountId, candidateSlug, tag.id);
          params.push(candidateSlug);
          updates.push("slug = $" + String(params.length));
        }
      }
      if (input.color !== undefined) {
        params.push(input.color || null);
        updates.push("color = $" + String(params.length));
      }
      if (updates.length) {
        params.push(tag.id, identity.accountId, identity.userId);
        const idIdx = params.length - 2;
        const accountIdx = params.length - 1;
        const ownerIdx = params.length;
        await client.query(
          "UPDATE tags SET " + updates.join(", ") + ", updated_at = NOW() WHERE id = $" + String(idIdx) + " AND account_id = $" + String(accountIdx) + " AND owner_user_id = $" + String(ownerIdx),
          params,
        );
      }
      return rowToTag(await this.fetchTagRow(client, identity, tag.id));
    });
  }

  async deleteTag(slug: string, principal = this.principal()): Promise<boolean> {
    await this.ensureLegacyAdopted(principal);
    return this.withMutation("delete", principal, async (client, identity) => {
      const tag = await this.resolveTag(client, identity, slug);
      if (!tag) return false;
      const result = await client.query(
        `DELETE FROM tags WHERE id = $1 AND account_id = $2 AND owner_user_id = $3`,
        [tag.id, identity.accountId, identity.userId],
      );
      return Boolean(result.rowCount);
    });
  }

  async resolveTagSlug(input: string, principal = this.principal()): Promise<string | null> {
    await this.ensureLegacyAdopted(principal);
    const identity = requireUserIdentity(principal);
    const client = await pool.connect();
    try {
      return (await this.resolveTag(client, identity, input))?.slug || null;
    } finally {
      client.release();
    }
  }

  async ensureTag(input: string, principal = this.principal()): Promise<string> {
    const normalized = normalizeTagSlug(input);
    if (!normalized) throw new Error("Tag must contain letters or numbers");
    const existing = await this.resolveTagSlug(normalized, principal);
    if (existing) return existing;
    const created = await this.createTag({ label: normalizeTagLabel(input), slug: normalized }, principal);
    return created.slug;
  }

  async assignTag(
    tagSlug: string,
    entityType: EntityType | string,
    entityId: string,
    entityTitle: string,
    principal = this.principal(),
    source: "explicit" | "legacy_array" | "legacy_registry" | "migration" = "explicit",
  ): Promise<void> {
    await this.ensureLegacyAdopted(principal);
    await this.withMutation("assign", principal, async (client, identity) => {
      let tag = await this.resolveTag(client, identity, tagSlug);
      if (!tag) {
        const slug = normalizeTagSlug(tagSlug);
        if (!slug) throw new Error("Tag must contain letters or numbers");
        const id = await this.upsertTagRow(client, identity, slug, normalizeTagLabel(tagSlug), null);
        tag = { id, slug };
      }
      await this.insertAssignment(client, identity, tag.id, entityType, entityId, entityTitle, source);
    });
  }

  async unassignTag(
    tagSlug: string,
    entityType: EntityType | string,
    entityId: string,
    principal = this.principal(),
  ): Promise<void> {
    await this.withMutation("unassign", principal, async (client, identity) => {
      const tag = await this.resolveTag(client, identity, tagSlug);
      if (!tag) return;
      await client.query(
        `DELETE FROM tag_assignments
         WHERE account_id = $1 AND owner_user_id = $2 AND tag_id = $3 AND object_type = $4 AND object_id = $5`,
        [identity.accountId, identity.userId, tag.id, entityType, entityId],
      );
    });
  }

  async getUsage(slug: string, principal = this.principal()): Promise<TagUsageEntry[]> {
    const identity = requireUserIdentity(principal);
    const result = await pool.query<AssignmentRow>(
      `SELECT a.object_type, a.object_id, a.object_title, a.created_at
       FROM tag_assignments a
       JOIN tags t ON t.id = a.tag_id AND t.account_id = a.account_id
       WHERE a.account_id = $1 AND a.owner_user_id = $2 AND t.slug = $3
       ORDER BY a.created_at DESC`,
      [identity.accountId, identity.userId, normalizeTagSlug(slug)],
    );
    return result.rows.map(row => ({
      entityType: row.object_type as EntityType,
      entityId: row.object_id,
      entityTitle: row.object_title,
      assignedAt: iso(row.created_at),
    }));
  }

  async removeEntity(
    entityType: EntityType | string,
    entityId: string,
    principal = this.principal(),
  ): Promise<void> {
    await this.withMutation("remove_entity", principal, async (client, identity) => {
      await client.query(
        `DELETE FROM tag_assignments WHERE account_id = $1 AND owner_user_id = $2 AND object_type = $3 AND object_id = $4`,
        [identity.accountId, identity.userId, entityType, entityId],
      );
    });
  }

  async replaceEntityTags(
    entityType: EntityType | string,
    entityId: string,
    entityTitle: string,
    tags: string[],
    principal = this.principal(),
  ): Promise<string[]> {
    await this.ensureLegacyAdopted(principal);
    return this.withMutation("replace_entity_tags", principal, async (client, identity) => {
      await client.query(
        `DELETE FROM tag_assignments WHERE account_id = $1 AND owner_user_id = $2 AND object_type = $3 AND object_id = $4`,
        [identity.accountId, identity.userId, entityType, entityId],
      );
      const slugs: string[] = [];
      for (const input of tags) {
        const slug = normalizeTagSlug(input);
        if (!slug || slugs.includes(slug)) continue;
        let tag = await this.resolveTag(client, identity, slug);
        if (!tag) {
          const id = await this.upsertTagRow(client, identity, slug, normalizeTagLabel(input), null);
          tag = { id, slug };
        }
        await this.insertAssignment(client, identity, tag.id, entityType, entityId, entityTitle, "legacy_array");
        slugs.push(tag.slug);
      }
      return slugs;
    });
  }

  async mergeTags(sourceSlug: string, targetSlug: string, principal = this.principal()): Promise<Tag | null> {
    await this.ensureLegacyAdopted(principal);
    return this.withMutation("merge", principal, async (client, identity) => {
      const source = await this.resolveTag(client, identity, sourceSlug);
      const target = await this.resolveTag(client, identity, targetSlug);
      if (!source || !target || source.id === target.id) return null;
      await client.query(
        `INSERT INTO tag_assignments(
           tag_id, account_id, owner_user_id, created_by_user_id, scope,
           object_type, object_id, object_title, source, created_at, updated_at
         )
         SELECT $1, account_id, owner_user_id, created_by_user_id, scope,
                object_type, object_id, object_title, source, created_at, NOW()
         FROM tag_assignments WHERE tag_id = $2 AND account_id = $3 AND owner_user_id = $4
         ON CONFLICT (account_id, tag_id, object_type, object_id)
         DO UPDATE SET object_title = EXCLUDED.object_title, updated_at = NOW()`,
        [target.id, source.id, identity.accountId, identity.userId],
      );
      await client.query(`DELETE FROM tags WHERE id = $1 AND account_id = $2 AND owner_user_id = $3`, [
        source.id,
        identity.accountId,
        identity.userId,
      ]);
      return rowToTag(await this.fetchTagRow(client, identity, target.id));
    });
  }

  async removeRetiredEntityTypeUsages(entityType: string, principal = this.principal()): Promise<void> {
    if (principal.actorType === "system") {
      const result = await pool.query(`DELETE FROM tag_assignments WHERE object_type = $1`, [entityType]);
      log.info("retired Tag assignments removed", { entityType, affectedRows: result.rowCount || 0 });
      return;
    }
    const identity = requireUserIdentity(principal);
    const result = await pool.query(
      `DELETE FROM tag_assignments WHERE account_id = $1 AND owner_user_id = $2 AND object_type = $3`,
      [identity.accountId, identity.userId, entityType],
    );
    log.info("retired Tag assignments removed", {
      entityType,
      accountId: identity.accountId,
      affectedRows: result.rowCount || 0,
    });
  }

  /**
   * Owner-agnostic Tag-assignment cleanup for entities that have been
   * PERMANENTLY destroyed. Safe only for globally-unique object ids that no
   * longer exist for any owner (e.g. hard-deleted Library pages): the target
   * row is gone for everyone, so any assignment pointing at it is definitively
   * orphaned. This intentionally bypasses per-principal scoping so that a system
   * auto-purge can clean the owning user's orphaned assignments, mirroring the
   * owner-agnostic destruction pattern in removeRetiredEntityTypeUsages.
   */
  async removeDestroyedEntities(entityType: EntityType | string, entityIds: string[]): Promise<void> {
    const ids = [...new Set(entityIds)].filter(Boolean);
    if (ids.length === 0) return;
    const result = await pool.query(
      `DELETE FROM tag_assignments WHERE object_type = $1 AND object_id = ANY($2::text[])`,
      [entityType, ids],
    );
    log.info("destroyed-entity Tag assignments removed", {
      entityType,
      requested: ids.length,
      affectedRows: result.rowCount || 0,
    });
  }

  private async assertIdentityAvailable(client: PoolClient, accountId: string, slug: string, tagId?: string): Promise<void> {
    const collision = await client.query(
      `SELECT 1 FROM tags WHERE account_id = $1 AND slug = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)
       LIMIT 1`,
      [accountId, slug, tagId || null],
    );
    if (collision.rowCount) throw new Error(`Tag identity already exists: ${slug}`);
  }

  private async upsertTagRow(
    client: PoolClient,
    identity: ScopedIdentity,
    slug: string,
    label: string,
    color: string | null = null,
    allowExisting = true,
  ): Promise<string> {
    if (allowExisting) {
      const existing = await this.resolveTag(client, identity, slug);
      if (existing) return existing.id;
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO tags(account_id, owner_user_id, created_by_user_id, scope, slug, label, description, color)
       VALUES ($1, $2, $2, 'user', $3, $4, '', $5)
       RETURNING id`,
      [identity.accountId, identity.userId, slug, label, color || null],
    );
    return result.rows[0].id;
  }

  private async resolveTag(
    client: PoolClient,
    identity: ScopedIdentity,
    input: string,
  ): Promise<{ id: string; slug: string } | null> {
    const normalized = normalizeTagSlug(input);
    if (!normalized) return null;
    const result = await client.query<{ id: string; slug: string }>(
      `SELECT t.id, t.slug FROM tags t
       WHERE t.account_id = $1 AND t.owner_user_id = $2 AND t.slug = $3
       LIMIT 1`,
      [identity.accountId, identity.userId, normalized],
    );
    return result.rows[0] || null;
  }

  private async insertAssignment(
    client: PoolClient,
    identity: ScopedIdentity,
    tagId: string,
    objectType: string,
    objectId: string,
    objectTitle: string,
    source: "explicit" | "legacy_array" | "legacy_registry" | "migration",
  ): Promise<void> {
    await client.query(
      `INSERT INTO tag_assignments(
         tag_id, account_id, owner_user_id, created_by_user_id, scope,
         object_type, object_id, object_title, source
       ) VALUES ($1, $2, $3, $3, 'user', $4, $5, $6, $7)
       ON CONFLICT (account_id, tag_id, object_type, object_id)
       DO UPDATE SET object_title = EXCLUDED.object_title, source = EXCLUDED.source, updated_at = NOW()`,
      [tagId, identity.accountId, identity.userId, objectType, objectId, objectTitle || "", source],
    );
  }

  private async fetchTagRow(client: PoolClient, identity: ScopedIdentity, tagId: string): Promise<TagRow> {
    const result = await client.query<TagRow>(
      `SELECT t.id, t.slug, t.label, t.color, t.created_at, t.updated_at,
              COUNT(DISTINCT a.id)::int AS usage_count
       FROM tags t
       LEFT JOIN tag_assignments a ON a.tag_id = t.id AND a.account_id = t.account_id
       WHERE t.id = $1 AND t.account_id = $2 AND t.owner_user_id = $3
       GROUP BY t.id`,
      [tagId, identity.accountId, identity.userId],
    );
    if (!result.rows[0]) throw new Error("Tag not found after mutation");
    return result.rows[0];
  }

  private buildCoOccurrences(usages: Record<string, TagUsageEntry[]>): CoOccurrenceEdge[] {
    const byObject = new Map<string, string[]>();
    for (const [slug, entries] of Object.entries(usages)) {
      for (const entry of entries) {
        const key = `${entry.entityType}:${entry.entityId}`;
        const slugs = byObject.get(key) || [];
        slugs.push(slug);
        byObject.set(key, slugs);
      }
    }
    const weights = new Map<string, number>();
    for (const slugs of byObject.values()) {
      const unique = [...new Set(slugs)].sort();
      for (let i = 0; i < unique.length; i += 1) {
        for (let j = i + 1; j < unique.length; j += 1) {
          const key = `${unique[i]}::${unique[j]}`;
          weights.set(key, (weights.get(key) || 0) + 1);
        }
      }
    }
    return [...weights.entries()].map(([key, weight]) => {
      const [source, target] = key.split("::");
      return { source, target, weight };
    });
  }
}

export const tagService = new TagService();
