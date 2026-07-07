// Use createLogger for logging ONLY
import { db, pool } from "./db";
import { eq, and, desc, asc } from "drizzle-orm";
import {
  decisions,
  decisionUpdates,
  decisionLinks,
  type Decision,
  type InsertDecision,
  type DecisionUpdate,
  type InsertDecisionUpdate,
  type DecisionLink,
  type InsertDecisionLink,
  type DecisionLinkTargetType,
  type DecisionStatus,
  type DecisionTrafficLight,
} from "@shared/schema";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
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

export class DecisionsStorage {
  private async requireWritableDecision(decisionId: string): Promise<Decision> {
    const [decision] = await db.select().from(decisions)
      .where(combineWithWritableScope(getCurrentPrincipalOrSystem(), decisionScopeColumns, eq(decisions.id, decisionId)))
      .limit(1);
    if (!decision) throw new Error(`Decision ${decisionId} not found or not writable`);
    return decision;
  }

  async listDecisions(opts?: { status?: DecisionStatus }): Promise<Decision[]> {
    return autoHeal(async () => {
      const rows = opts?.status
        ? await db.select().from(decisions).where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), decisionScopeColumns, eq(decisions.status, opts.status))).orderBy(desc(decisions.updatedAt))
        : await db.select().from(decisions).where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), decisionScopeColumns)).orderBy(desc(decisions.updatedAt));
      log.debug(`listDecisions status=${opts?.status ?? "all"} count=${rows.length}`);
      return rows;
    });
  }

  async getDecision(id: string): Promise<Decision | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(decisions).where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), decisionScopeColumns, eq(decisions.id, id)));
      return row;
    });
  }

  async createDecision(data: InsertDecision): Promise<Decision> {
    return autoHeal(async () => {
      const [row] = await db.insert(decisions).values({ ...data, ...ownedInsertValues(getCurrentPrincipalOrSystem(), decisionScopeColumns) }).returning();
      log.debug(`createDecision id=${row.id} title="${row.title}"`);
      return row;
    });
  }

  async updateDecision(id: string, updates: DecisionUpdatePatch): Promise<Decision | undefined> {
    return autoHeal(async () => {
      const patch: Record<string, unknown> = { ...updates, updatedAt: new Date() };
      const [row] = await db.update(decisions).set(patch).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), decisionScopeColumns, eq(decisions.id, id))).returning();
      log.debug(`updateDecision id=${id} found=${!!row} fields=${Object.keys(updates).join(",")}`);
      return row;
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
      }).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), decisionScopeColumns, eq(decisions.id, id))).returning();
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
      }).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), decisionScopeColumns, eq(decisions.id, id))).returning();
      return row;
    });
  }

  async deleteDecision(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const result = await db.delete(decisions).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), decisionScopeColumns, eq(decisions.id, id))).returning();
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
      await this.requireWritableDecision(data.decisionId);
      const [row] = await db.insert(decisionUpdates).values(data).returning();
      await db.update(decisions).set({ updatedAt: new Date() }).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), decisionScopeColumns, eq(decisions.id, data.decisionId)));
      return row;
    });
  }

  async editUpdate(id: string, content: string): Promise<DecisionUpdate | undefined> {
    return autoHeal(async () => {
      const [existing] = await db.select().from(decisionUpdates).where(eq(decisionUpdates.id, id)).limit(1);
      if (!existing) return undefined;
      await this.requireWritableDecision(existing.decisionId);
      const [row] = await db.update(decisionUpdates).set({ content }).where(eq(decisionUpdates.id, id)).returning();
      await db.update(decisions).set({ updatedAt: new Date() }).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), decisionScopeColumns, eq(decisions.id, existing.decisionId)));
      return row;
    });
  }

  async deleteUpdate(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const [existing] = await db.select().from(decisionUpdates).where(eq(decisionUpdates.id, id)).limit(1);
      if (!existing) return false;
      await this.requireWritableDecision(existing.decisionId);
      const result = await db.delete(decisionUpdates).where(eq(decisionUpdates.id, id)).returning();
      return result.length > 0;
    });
  }

  async listLinks(decisionId: string): Promise<DecisionLink[]> {
    return autoHeal(async () => {
      const decision = await this.getDecision(decisionId);
      if (!decision) return [];
      return db.select().from(decisionLinks).where(eq(decisionLinks.decisionId, decisionId)).orderBy(asc(decisionLinks.createdAt));
    });
  }

  async listLinksForTarget(targetType: DecisionLinkTargetType, targetId: string): Promise<DecisionLink[]> {
    return autoHeal(async () => {
      const links = await db.select().from(decisionLinks).where(and(eq(decisionLinks.targetType, targetType), eq(decisionLinks.targetId, targetId)));
      const visible: DecisionLink[] = [];
      for (const link of links) if (await this.getDecision(link.decisionId)) visible.push(link);
      return visible;
    });
  }

  async addLink(data: InsertDecisionLink): Promise<DecisionLink> {
    return autoHeal(async () => {
      await this.requireWritableDecision(data.decisionId);
      const [row] = await db.insert(decisionLinks).values(data).onConflictDoNothing().returning();
      if (row) return row;
      const [existing] = await db.select().from(decisionLinks).where(and(
        eq(decisionLinks.decisionId, data.decisionId),
        eq(decisionLinks.targetType, data.targetType),
        eq(decisionLinks.targetId, data.targetId),
      ));
      return existing;
    });
  }

  async deleteLink(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const [existing] = await db.select().from(decisionLinks).where(eq(decisionLinks.id, id)).limit(1);
      if (!existing) return false;
      await this.requireWritableDecision(existing.decisionId);
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
    `CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_decisions_scope_owner ON decisions(scope, owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_decisions_account ON decisions(account_id)`,
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
