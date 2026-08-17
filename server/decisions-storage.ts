// Use createLogger for logging ONLY
import { db, pool, runWithDatabaseTransaction } from "./db";
import { eq, and, desc, asc } from "drizzle-orm";
import { filePrincipleStorage } from "./file-storage/principles";
import { peopleStorage } from "./people-storage";
import {
  decisions,
  decisionUpdates,
  decisionLinks,
  decisionLinkTargetTypes,
  type Decision,
  type InsertDecision,
  type DecisionUpdate,
  type InsertDecisionUpdate,
  type DecisionLinkTargetType,
  type DecisionStatus,
  type DecisionTrafficLight,
} from "@shared/schema";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";
import type { Principal } from "./principal";
import { createAddressLink, listAddressLinks, retireAddressLink } from "./life-addressing-storage";
import { normalizeProtocolAddress, type AddressLink } from "@shared/life-addressing";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const log = createLogger("DecisionsStorage");

const decisionScopeColumns = {
  scope: decisions.scope,
  ownerUserId: decisions.ownerUserId,
  accountId: decisions.accountId,
};

let schemaMigrated = false;

async function autoHeal<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if ((code === "42703" || code === "42P01") && !schemaMigrated) {
      log.debug(`auto-heal: migrating schema after column/relation error (${message})`);
      await migrateDecisionsSchema();
      schemaMigrated = true;
      try {
        return await operation();
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log.warn(`auto-heal: retry failed after migration (${retryMsg})`);
        throw retryErr;
      }
    }
    throw err;
  }
}

export type DecisionUpdatePatch = Partial<Omit<InsertDecision, "trafficLight" | "status">> & {
  trafficLight?: DecisionTrafficLight | null;
  status?: DecisionStatus;
};

export const DECISION_LINK_PREDICATES = ["relates_to", "governs", "guided_by", "governed_by", "decided_by", "evidence_for", "triggered_by", "produced"] as const;
export type DecisionLinkPredicate = typeof DECISION_LINK_PREDICATES[number];

export interface DecisionAddressLink {
  id: string;
  decisionId: string;
  targetType: string;
  targetId: string;
  targetAddress: string;
  predicate: DecisionLinkPredicate;
  createdAt: Date;
  source: "address_link" | "compatibility";
}

export interface AddDecisionLinkInput {
  decisionId: string;
  targetAddress?: string;
  targetType?: string;
  targetId?: string;
  predicate?: DecisionLinkPredicate;
}

export interface RecordJudgmentInput {
  title: string;
  description?: string;
  answerPayload?: Record<string, unknown>;
  reasoning?: string;
  sourceSessionId?: string;
  sourceToolCallId?: string;
  ownerPersonRole?: "self" | "partner";
  principleRevisionIds?: string[];
  triggeredByAddress?: string;
  status?: DecisionStatus;
  resolvedAt?: Date;
}

export interface RecordJudgmentResult {
  decision: Decision;
  outcome: "created" | "replayed";
}

function decisionLinkCompatibilityEnabled(): boolean {
  return process.env.DECISION_LINKS_COMPATIBILITY_ENABLED !== "false";
}

function decisionTargetAddress(input: AddDecisionLinkInput): string {
  const candidate = input.targetAddress ?? (input.targetType && input.targetId ? `@${input.targetType}:${input.targetId}` : "");
  const normalized = normalizeProtocolAddress(candidate);
  if (normalized.outcome !== "valid") throw Object.assign(new Error("Decision link target must be a canonical address"), { status: 400 });
  return normalized.address;
}

function decisionAddressLink(decisionId: string, link: AddressLink): DecisionAddressLink | null {
  const target = normalizeProtocolAddress(link.targetAddress);
  if (target.outcome !== "valid" || !(DECISION_LINK_PREDICATES as readonly string[]).includes(link.predicate)) return null;
  return {
    id: link.id,
    decisionId,
    targetType: target.type,
    targetId: target.id,
    targetAddress: target.address,
    predicate: link.predicate as DecisionLinkPredicate,
    createdAt: new Date(link.createdAt),
    source: "address_link",
  };
}

async function indexDecision(principal: Principal, decision: Decision): Promise<void> {
  const { indexDecisionReferences } = await import("./decision-reference-index");
  await indexDecisionReferences(principal, decision);
}

export class DecisionsStorage {
  private async requireWritableDecision(decisionId: string): Promise<Decision> {
    const [decision] = await db.select().from(decisions)
      .where(combineWithWritableScope(requireCurrentUserPrincipal(), decisionScopeColumns, eq(decisions.id, decisionId)))
      .limit(1);
    if (!decision) throw new Error(`Decision ${decisionId} not found or not writable`);
    return decision;
  }

  async listDecisions(opts?: { status?: DecisionStatus }): Promise<Decision[]> {
    return autoHeal(async () => {
      const rows = opts?.status
        ? await db.select().from(decisions).where(combineWithVisibleScope(requireCurrentUserPrincipal(), decisionScopeColumns, eq(decisions.status, opts.status))).orderBy(desc(decisions.updatedAt))
        : await db.select().from(decisions).where(combineWithVisibleScope(requireCurrentUserPrincipal(), decisionScopeColumns)).orderBy(desc(decisions.updatedAt));
      log.debug(`listDecisions status=${opts?.status ?? "all"} count=${rows.length}`);
      return rows;
    });
  }

  async getDecision(id: string): Promise<Decision | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(decisions).where(combineWithVisibleScope(requireCurrentUserPrincipal(), decisionScopeColumns, eq(decisions.id, id)));
      return row;
    });
  }

  async createDecision(data: InsertDecision): Promise<Decision> {
    return autoHeal(async () => {
      const principal = requireCurrentUserPrincipal();
      return db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
        const [row] = await tx.insert(decisions).values({ ...data, ...ownedInsertValues(principal, decisionScopeColumns) }).returning();
        await indexDecision(principal, row);
        log.debug(`createDecision id=${row.id} title="${row.title}"`);
        return row;
      }));
    });
  }

  async recordJudgment(input: RecordJudgmentInput): Promise<RecordJudgmentResult> {
    return autoHeal(async () => {
      const principal = requireCurrentUserPrincipal();
      return db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
        if (input.sourceSessionId && input.sourceToolCallId && principal.accountId) {
          const [existing] = await db.select().from(decisions).where(and(
            eq(decisions.accountId, principal.accountId),
            eq(decisions.sourceSessionId, input.sourceSessionId),
            eq(decisions.sourceToolCallId, input.sourceToolCallId),
            combineWithVisibleScope(principal, decisionScopeColumns),
          )).limit(1);
          if (existing) return { decision: existing, outcome: "replayed" as const };
        }

        const principles = await filePrincipleStorage.getPrinciples();
        const byCurrentRevisionId = new Map(principles.map((p) => [p.currentRevisionId, p]));
        const byPrincipleId = new Map(principles.map((p) => [p.id, p]));
        // Callers may pass current revision ids, principle ids (from context chips /
        // "principle id:" labels), or historical revision ids. Resolve all three to
        // the visible current principle so governed_by always pins the live revision.
        const selectedPrinciples: typeof principles = [];
        const seenPrincipleIds = new Set<string>();
        for (const rawId of [...new Set(input.principleRevisionIds ?? [])]) {
          const trimmedId = typeof rawId === "string" ? rawId.trim() : "";
          // Context once emitted @principle:undefined when Layer1 omitted currentRevisionId.
          // Skip those inert tokens rather than failing the whole judgment.
          if (!trimmedId || trimmedId === "undefined" || trimmedId === "null") continue;
          let principle = byCurrentRevisionId.get(trimmedId) ?? byPrincipleId.get(trimmedId) ?? null;
          if (!principle) {
            principle = await filePrincipleStorage.resolvePrincipleFromAnyId(trimmedId);
          }
          if (!principle) {
            throw Object.assign(
              new Error(`Principle revision is not current or visible: ${trimmedId}`),
              { status: 400 },
            );
          }
          if (seenPrincipleIds.has(principle.id)) continue;
          seenPrincipleIds.add(principle.id);
          selectedPrinciples.push(principle);
        }
        const people = input.ownerPersonRole ? await peopleStorage.listPeople() : [];
        const targetCabinetLevel = input.ownerPersonRole === "self" ? "agent" : "user";
        const ownerPerson = input.ownerPersonRole
          ? people.find((person) => person.cabinetLevel === targetCabinetLevel)
          : undefined;
        const resolvedAt = input.resolvedAt ?? new Date();
        const status = input.status ?? "closed";
        // Insert in the ambient transaction — do not call createDecision (nested autoHeal/tx).
        const [decision] = await tx.insert(decisions).values({
          title: input.title.trim(),
          description: input.description?.trim() ?? "",
          status,
          closedAt: status === "closed" ? resolvedAt : null,
          resolvedAt,
          ownerPersonId: ownerPerson?.id ?? null,
          sourceSessionId: input.sourceSessionId ?? null,
          sourceToolCallId: input.sourceToolCallId ?? null,
          answerPayload: input.answerPayload ?? null,
          reasoning: input.reasoning?.trim() || null,
          ...ownedInsertValues(principal, decisionScopeColumns),
        }).returning();
        await indexDecision(principal, decision);
        log.info(JSON.stringify({
          event: "decision.judgment.created",
          decisionId: decision.id,
          sourceSessionId: input.sourceSessionId ?? null,
          sourceToolCallId: input.sourceToolCallId ?? null,
          ownerPersonId: ownerPerson?.id ?? null,
          principleCount: selectedPrinciples.length,
          hasTriggeredBy: Boolean(input.triggeredByAddress),
        }));

        const sourceAddress = `@decision:${decision.id}`;
        const sessionProvenance = input.sourceSessionId ? `@session:${input.sourceSessionId}` : undefined;

        if (ownerPerson) {
          const targetAddress = `@person:${ownerPerson.id}`;
          await createAddressLink(principal, {
            sourceAddress,
            targetAddress,
            predicate: "decided_by",
            provenanceAddress: sessionProvenance,
            createdBy: "decision.judgment",
            idempotencyKey: `decision:${decision.id}:decided_by:${targetAddress}`,
          });
        }
        for (const principle of selectedPrinciples) {
          // Address the governing revision directly; principle adapter resolves revision IDs.
          const targetAddress = `@principle:${principle.currentRevisionId}`;
          await createAddressLink(principal, {
            sourceAddress,
            targetAddress,
            predicate: "governed_by",
            provenanceAddress: `@principle:${principle.id}`,
            createdBy: "decision.judgment",
            idempotencyKey: `decision:${decision.id}:governed_by:${targetAddress}`,
          });
        }
        if (input.triggeredByAddress) {
          await createAddressLink(principal, {
            sourceAddress,
            targetAddress: input.triggeredByAddress,
            predicate: "triggered_by",
            provenanceAddress: sessionProvenance,
            createdBy: "decision.judgment",
            idempotencyKey: `decision:${decision.id}:triggered_by:${input.triggeredByAddress}`,
          });
        }
        return { decision, outcome: "created" as const };
      }));
    });
  }

  async updateDecision(id: string, updates: DecisionUpdatePatch): Promise<Decision | undefined> {
    return autoHeal(async () => {
      const principal = requireCurrentUserPrincipal();
      return db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
        const patch: Record<string, unknown> = { ...updates, updatedAt: new Date() };
        const [row] = await tx.update(decisions).set(patch).where(combineWithWritableScope(principal, decisionScopeColumns, eq(decisions.id, id))).returning();
        if (row) await indexDecision(principal, row);
        log.debug(`updateDecision id=${id} found=${!!row} fields=${Object.keys(updates).join(",")}`);
        return row;
      }));
    });
  }

  async lockDecision(id: string): Promise<Decision | undefined> {
    return autoHeal(async () => {
      const existing = await this.getDecision(id);
      if (!existing) return undefined;
      const [row] = await db.update(decisions).set({
        status: "closed",
        closedAt: existing.closedAt ?? new Date(),
        trafficLight: existing.trafficLight ?? "green",
        updatedAt: new Date(),
      }).where(combineWithWritableScope(requireCurrentUserPrincipal(), decisionScopeColumns, eq(decisions.id, id))).returning();
      return row;
    });
  }

  async reopenDecision(id: string): Promise<Decision | undefined> {
    return autoHeal(async () => {
      const [row] = await db.update(decisions).set({
        status: "open",
        closedAt: null,
        trafficLight: null,
        updatedAt: new Date(),
      }).where(combineWithWritableScope(requireCurrentUserPrincipal(), decisionScopeColumns, eq(decisions.id, id))).returning();
      return row;
    });
  }

  async deleteDecision(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const result = await db.delete(decisions).where(combineWithWritableScope(requireCurrentUserPrincipal(), decisionScopeColumns, eq(decisions.id, id))).returning();
      return result.length > 0;
    });
  }

  async listUpdates(decisionId: string): Promise<DecisionUpdate[]> {
    return autoHeal(async () => {
      const decision = await this.getDecision(decisionId);
      if (!decision) return [];
      return db.select().from(decisionUpdates).where(eq(decisionUpdates.decisionId, decisionId)).orderBy(desc(decisionUpdates.createdAt));
    });
  }

  async addUpdate(data: InsertDecisionUpdate): Promise<DecisionUpdate> {
    return autoHeal(async () => {
      const principal = requireCurrentUserPrincipal();
      return db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
        await this.requireWritableDecision(data.decisionId);
        const [row] = await tx.insert(decisionUpdates).values(data).returning();
        const [decision] = await tx.update(decisions).set({ updatedAt: new Date() })
          .where(combineWithWritableScope(principal, decisionScopeColumns, eq(decisions.id, data.decisionId))).returning();
        if (decision) await indexDecision(principal, decision);
        return row;
      }));
    });
  }

  async editUpdate(id: string, content: string): Promise<DecisionUpdate | undefined> {
    return autoHeal(async () => {
      const principal = requireCurrentUserPrincipal();
      return db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
        const [existing] = await tx.select().from(decisionUpdates).where(eq(decisionUpdates.id, id)).limit(1);
        if (!existing) return undefined;
        await this.requireWritableDecision(existing.decisionId);
        const [row] = await tx.update(decisionUpdates).set({ content }).where(eq(decisionUpdates.id, id)).returning();
        const [decision] = await tx.update(decisions).set({ updatedAt: new Date() })
          .where(combineWithWritableScope(principal, decisionScopeColumns, eq(decisions.id, existing.decisionId))).returning();
        if (decision) await indexDecision(principal, decision);
        return row;
      }));
    });
  }

  async deleteUpdate(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const principal = requireCurrentUserPrincipal();
      return db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
        const [existing] = await tx.select().from(decisionUpdates).where(eq(decisionUpdates.id, id)).limit(1);
        if (!existing) return false;
        await this.requireWritableDecision(existing.decisionId);
        const result = await tx.delete(decisionUpdates).where(eq(decisionUpdates.id, id)).returning();
        const [decision] = await tx.update(decisions).set({ updatedAt: new Date() })
          .where(combineWithWritableScope(principal, decisionScopeColumns, eq(decisions.id, existing.decisionId))).returning();
        if (decision) await indexDecision(principal, decision);
        return result.length > 0;
      }));
    });
  }

  async listLinks(decisionId: string): Promise<DecisionAddressLink[]> {
    return autoHeal(async () => {
      const decision = await this.getDecision(decisionId);
      if (!decision) return [];
      const canonicalPage = await listAddressLinks(requireCurrentUserPrincipal(), {
        sourceAddress: `@decision:${decisionId}`,
        lifecycle: "active",
        limit: 500,
      });
      const canonical = canonicalPage.items.flatMap(link => {
        const projected = decisionAddressLink(decisionId, link);
        return projected ? [projected] : [];
      });
      if (!decisionLinkCompatibilityEnabled()) return canonical;

      const seen = new Set(canonical.map(link => `${link.targetAddress}:${link.predicate}`));
      const legacy = await db.select().from(decisionLinks)
        .where(eq(decisionLinks.decisionId, decisionId)).orderBy(asc(decisionLinks.createdAt));
      let migrated = 0;
      let unresolved = 0;
      for (const link of legacy) {
        const target = normalizeProtocolAddress(`@${link.targetType}:${link.targetId}`);
        if (target.outcome !== "valid" || seen.has(`${target.address}:relates_to`)) continue;
        try {
          const created = await createAddressLink(requireCurrentUserPrincipal(), {
            sourceAddress: `@decision:${decisionId}`,
            targetAddress: target.address,
            predicate: "relates_to",
            createdBy: "decision_legacy_migration",
            idempotencyKey: `decision:${decisionId}:relates_to:${target.address}`,
          });
          const projected = decisionAddressLink(decisionId, created);
          if (projected) {
            canonical.push(projected);
            seen.add(`${projected.targetAddress}:${projected.predicate}`);
            await pool.query("UPDATE decision_links SET address_link_id = $1 WHERE id = $2 AND address_link_id IS NULL", [created.id, link.id]);
            migrated += 1;
            continue;
          }
        } catch {
          unresolved += 1;
        }
        canonical.push({
          id: link.id,
          decisionId,
          targetType: target.type,
          targetId: target.id,
          targetAddress: target.address,
          predicate: "relates_to",
          createdAt: link.createdAt,
          source: "compatibility",
        });
      }
      if (migrated > 0) {
        log.info(JSON.stringify({ event: "decision_links.shadow_migration", migrated, unresolved, legacyCount: legacy.length }));
      } else if (unresolved > 0) {
        log.warn(JSON.stringify({ event: "decision_links.shadow_migration_degraded", migrated, unresolved, legacyCount: legacy.length }));
      }
      return canonical;
    });
  }

  async listLinksForTarget(targetType: DecisionLinkTargetType, targetId: string): Promise<DecisionAddressLink[]> {
    return autoHeal(async () => {
      const targetAddress = decisionTargetAddress({ decisionId: "lookup", targetType, targetId });
      const canonicalPage = await listAddressLinks(requireCurrentUserPrincipal(), {
        targetAddress,
        lifecycle: "active",
        limit: 500,
      });
      const canonical: DecisionAddressLink[] = [];
      for (const link of canonicalPage.items) {
        const source = normalizeProtocolAddress(link.sourceAddress);
        if (source.outcome !== "valid" || source.type !== "decision") continue;
        const projected = decisionAddressLink(source.id, link);
        if (projected) canonical.push(projected);
      }
      if (!decisionLinkCompatibilityEnabled()) return canonical;
      const seen = new Set(canonical.map(link => link.decisionId));
      const legacy = await db.select().from(decisionLinks)
        .where(and(eq(decisionLinks.targetType, targetType), eq(decisionLinks.targetId, targetId)));
      for (const link of legacy) {
        if (seen.has(link.decisionId) || !(await this.getDecision(link.decisionId))) continue;
        canonical.push({
          id: link.id,
          decisionId: link.decisionId,
          targetType,
          targetId,
          targetAddress,
          predicate: "relates_to",
          createdAt: link.createdAt,
          source: "compatibility",
        });
      }
      return canonical;
    });
  }

  async addLink(data: AddDecisionLinkInput): Promise<DecisionAddressLink> {
    return autoHeal(async () => {
      const principal = requireCurrentUserPrincipal();
      await this.requireWritableDecision(data.decisionId);
      const targetAddress = decisionTargetAddress(data);
      const predicate = data.predicate ?? "relates_to";
      if (!(DECISION_LINK_PREDICATES as readonly string[]).includes(predicate)) {
        throw Object.assign(new Error(`Decision link predicate must be one of: ${DECISION_LINK_PREDICATES.join(", ")}`), { status: 400 });
      }
      const created = await createAddressLink(principal, {
        sourceAddress: `@decision:${data.decisionId}`,
        targetAddress,
        predicate,
        createdBy: "decision",
        idempotencyKey: `decision:${data.decisionId}:${predicate}:${targetAddress}`,
      });
      const projected = decisionAddressLink(data.decisionId, created);
      if (!projected) throw new Error("Decision address link projection failed");

      if (decisionLinkCompatibilityEnabled()) {
        const target = normalizeProtocolAddress(targetAddress);
        if (target.outcome === "valid" && (decisionLinkTargetTypes as readonly string[]).includes(target.type)) {
          await db.insert(decisionLinks).values({
            decisionId: data.decisionId,
            targetType: target.type as DecisionLinkTargetType,
            targetId: target.id,
          }).onConflictDoNothing();
        }
      }
      return projected;
    });
  }

  async deleteLink(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const principal = requireCurrentUserPrincipal();
      try {
        const retired = await retireAddressLink(principal, id);
        const source = normalizeProtocolAddress(retired.sourceAddress);
        const target = normalizeProtocolAddress(retired.targetAddress);
        if (decisionLinkCompatibilityEnabled() && source.outcome === "valid" && source.type === "decision" && target.outcome === "valid") {
          await db.delete(decisionLinks).where(and(
            eq(decisionLinks.decisionId, source.id),
            eq(decisionLinks.targetType, target.type),
            eq(decisionLinks.targetId, target.id),
          ));
        }
        return true;
      } catch (error) {
        if ((error as { status?: number }).status !== 404 || !decisionLinkCompatibilityEnabled()) throw error;
      }

      const [legacy] = await db.select().from(decisionLinks).where(eq(decisionLinks.id, id)).limit(1);
      if (!legacy) return false;
      await this.requireWritableDecision(legacy.decisionId);
      const result = await db.delete(decisionLinks).where(eq(decisionLinks.id, id)).returning();
      return result.length > 0;
    });
  }
}

export const decisionsStorage = new DecisionsStorage();

export async function migrateDecisionsSchema(): Promise<void> {
  const migrations = [
    `CREATE TABLE IF NOT EXISTS decisions (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       title text NOT NULL,
       description text NOT NULL DEFAULT '',
       status text NOT NULL DEFAULT 'open',
       traffic_light text,
       data_content jsonb,
       data_plain_text text NOT NULL DEFAULT '',
       scenarios_content jsonb,
       scenarios_plain_text text NOT NULL DEFAULT '',
       plan_content jsonb,
       plan_plain_text text NOT NULL DEFAULT '',
       closed_at timestamp,
       scope text NOT NULL DEFAULT 'user',
       owner_user_id text,
       account_id text,
       created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    // Heal earlier dev schema: add description + traffic_light if missing, drop legacy health if present
    `ALTER TABLE decisions ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT ''`,
    `ALTER TABLE decisions ADD COLUMN IF NOT EXISTS traffic_light text`,
    `ALTER TABLE decisions DROP COLUMN IF EXISTS health`,
    `ALTER TABLE decisions ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user'`,
    `ALTER TABLE decisions ADD COLUMN IF NOT EXISTS owner_user_id text`,
    `ALTER TABLE decisions ADD COLUMN IF NOT EXISTS account_id text`,
    // Judgment provenance (mirrors migrations/0119_judgment_provenance.sql; this repo has no
    // SQL migration runner, so these columns must self-heal here on boot).
    `ALTER TABLE decisions ADD COLUMN IF NOT EXISTS owner_person_id text`,
    `ALTER TABLE decisions ADD COLUMN IF NOT EXISTS source_session_id text`,
    `ALTER TABLE decisions ADD COLUMN IF NOT EXISTS source_tool_call_id text`,
    `ALTER TABLE decisions ADD COLUMN IF NOT EXISTS answer_payload jsonb`,
    `ALTER TABLE decisions ADD COLUMN IF NOT EXISTS reasoning text`,
    `ALTER TABLE decisions ADD COLUMN IF NOT EXISTS resolved_at timestamp with time zone`,
    `CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_decisions_scope_owner ON decisions(scope, owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_decisions_account ON decisions(account_id)`,
    `CREATE INDEX IF NOT EXISTS idx_decisions_owner_person ON decisions(owner_person_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_decisions_question_replay
       ON decisions(account_id, source_session_id, source_tool_call_id)
       WHERE account_id IS NOT NULL
         AND source_session_id IS NOT NULL
         AND source_tool_call_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS decision_updates (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       decision_id text NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
       content text NOT NULL DEFAULT '',
       created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `ALTER TABLE decision_updates DROP COLUMN IF EXISTS plain_text`,
    // legacy column was jsonb named content; only attempt change if it exists as jsonb
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='decision_updates' AND column_name='content' AND data_type='jsonb') THEN
         ALTER TABLE decision_updates ALTER COLUMN content TYPE text USING coalesce(content::text, '');
         ALTER TABLE decision_updates ALTER COLUMN content SET NOT NULL;
         ALTER TABLE decision_updates ALTER COLUMN content SET DEFAULT '';
       END IF;
     END $$`,
    `CREATE INDEX IF NOT EXISTS idx_decision_updates_decision ON decision_updates(decision_id)`,
    `CREATE TABLE IF NOT EXISTS decision_links (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       decision_id text NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
       target_type text NOT NULL,
       target_id text NOT NULL,
       created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_decision_links_decision ON decision_links(decision_id)`,
    `CREATE INDEX IF NOT EXISTS idx_decision_links_target ON decision_links(target_type, target_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_decision_links_decision_target ON decision_links(decision_id, target_type, target_id)`,
  ];
  for (const sqlStr of migrations) {
    try {
      await pool.query(sqlStr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("migration failed:", msg, "sql:", sqlStr.slice(0, 80));
    }
  }
  log.debug("schema migration complete");
}
