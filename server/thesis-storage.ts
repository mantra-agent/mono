import { db, pool } from "./db";
import { eq, desc, and, inArray, type SQL } from "drizzle-orm";
import {
  theses,
  thesisEvidence,
  thesisPredictions,
  type Thesis,
  type InsertThesis,
  type ThesisEvidence,
  type InsertThesisEvidence,
  type ThesisPrediction,
  type InsertThesisPrediction,
  type ThesisStatus,
  type PredictionOutcome,
  type ThesisConviction,
} from "@shared/schema";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const log = createLogger("ThesisStorage");
const thesisScopeColumns = { scope: theses.scope, ownerUserId: theses.ownerUserId, accountId: theses.accountId, vaultId: theses.vaultId };
function visibleThesis(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), thesisScopeColumns, predicate); }
function writableThesis(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), thesisScopeColumns, predicate); }
async function visibleThesisIds(predicate?: SQL): Promise<string[]> {
  const rows = await db.select({ id: theses.id }).from(theses).where(visibleThesis(predicate));
  return rows.map((row) => row.id);
}
async function writableThesisIds(predicate?: SQL): Promise<string[]> {
  const rows = await db.select({ id: theses.id }).from(theses).where(writableThesis(predicate));
  return rows.map((row) => row.id);
}

let schemaMigrated = false;

async function autoHeal<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if ((code === "42703" || code === "42P01") && !schemaMigrated) {
      log.debug(`auto-heal: migrating schema after column/relation error (${message})`);
      await migrateThesisSchema();
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

// ── Thesis CRUD ────────────────────────────────────────────────────
export class ThesisStorage {
  async list(opts?: { status?: ThesisStatus }): Promise<Thesis[]> {
    return autoHeal(async () => {
      const rows = opts?.status
        ? await db.select().from(theses).where(visibleThesis(eq(theses.status, opts.status))).orderBy(desc(theses.updatedAt))
        : await db.select().from(theses).where(visibleThesis()).orderBy(desc(theses.updatedAt));
      log.debug(`list status=${opts?.status ?? "all"} count=${rows.length}`);
      return rows;
    });
  }

  async get(id: string): Promise<Thesis | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(theses).where(visibleThesis(eq(theses.id, id)));
      return row;
    });
  }

  async create(data: InsertThesis): Promise<Thesis> {
    return autoHeal(async () => {
      const [row] = await db.insert(theses).values({ ...data, ...ownedInsertValues(getCurrentPrincipalOrSystem(), thesisScopeColumns) }).returning();
      log.debug(`create id=${row.id} title="${row.title}"`);
      return row;
    });
  }

  async update(id: string, updates: Partial<InsertThesis>): Promise<Thesis | undefined> {
    return autoHeal(async () => {
      const patch: Record<string, unknown> = { ...updates, updatedAt: new Date() };
      const [row] = await db.update(theses).set(patch).where(writableThesis(eq(theses.id, id))).returning();
      log.debug(`update id=${id} found=${!!row} fields=${Object.keys(updates).join(",")}`);
      return row;
    });
  }

  async delete(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const result = await db.delete(theses).where(writableThesis(eq(theses.id, id))).returning();
      log.debug(`delete id=${id} deleted=${result.length > 0}`);
      return result.length > 0;
    });
  }

  // ── Evidence ───────────────────────────────────────────────────────
  async listEvidence(thesisId: string): Promise<ThesisEvidence[]> {
    return autoHeal(async () => {
      const thesis = await this.get(thesisId);
      if (!thesis) return [];
      return db.select().from(thesisEvidence)
        .where(eq(thesisEvidence.thesisId, thesisId))
        .orderBy(thesisEvidence.position);
    });
  }

  async addEvidence(data: InsertThesisEvidence): Promise<ThesisEvidence> {
    return autoHeal(async () => {
      const [thesis] = await db.select().from(theses).where(writableThesis(eq(theses.id, data.thesisId)));
      if (!thesis) throw Object.assign(new Error("Thesis not found"), { status: 404 });
      const [row] = await db.insert(thesisEvidence).values(data).returning();
      await this.touchThesis(data.thesisId);
      log.debug(`addEvidence thesis=${data.thesisId} id=${row.id}`);
      return row;
    });
  }

  async updateEvidence(id: string, updates: Partial<Pick<InsertThesisEvidence, "content" | "sourceUrl" | "position">>): Promise<ThesisEvidence | undefined> {
    return autoHeal(async () => {
      const ids = await writableThesisIds();
      if (ids.length === 0) return undefined;
      const [existing] = await db.select().from(thesisEvidence)
        .where(and(eq(thesisEvidence.id, id), inArray(thesisEvidence.thesisId, ids)));
      if (!existing) return undefined;
      const [row] = await db.update(thesisEvidence).set(updates)
        .where(and(eq(thesisEvidence.id, id), inArray(thesisEvidence.thesisId, ids))).returning();
      if (row) await this.touchThesis(row.thesisId);
      return row;
    });
  }

  async removeEvidence(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const ids = await writableThesisIds();
      if (ids.length === 0) return false;
      const [existing] = await db.select().from(thesisEvidence)
        .where(and(eq(thesisEvidence.id, id), inArray(thesisEvidence.thesisId, ids)));
      if (!existing) return false;
      const result = await db.delete(thesisEvidence)
        .where(and(eq(thesisEvidence.id, id), inArray(thesisEvidence.thesisId, ids))).returning();
      if (result.length > 0) await this.touchThesis(result[0].thesisId);
      return result.length > 0;
    });
  }

  // ── Predictions ────────────────────────────────────────────────────
  async listPredictions(thesisId: string): Promise<ThesisPrediction[]> {
    return autoHeal(async () => {
      const thesis = await this.get(thesisId);
      if (!thesis) return [];
      return db.select().from(thesisPredictions)
        .where(eq(thesisPredictions.thesisId, thesisId))
        .orderBy(thesisPredictions.createdAt);
    });
  }

  async addPrediction(data: InsertThesisPrediction): Promise<ThesisPrediction> {
    return autoHeal(async () => {
      const [thesis] = await db.select().from(theses).where(writableThesis(eq(theses.id, data.thesisId)));
      if (!thesis) throw Object.assign(new Error("Thesis not found"), { status: 404 });
      const [row] = await db.insert(thesisPredictions).values(data).returning();
      await this.touchThesis(data.thesisId);
      log.debug(`addPrediction thesis=${data.thesisId} id=${row.id}`);
      return row;
    });
  }

  async resolvePrediction(id: string, outcome: PredictionOutcome, resolutionNotes?: string): Promise<ThesisPrediction | undefined> {
    return autoHeal(async () => {
      const ids = await writableThesisIds();
      if (ids.length === 0) return undefined;
      const [existing] = await db.select().from(thesisPredictions)
        .where(and(eq(thesisPredictions.id, id), inArray(thesisPredictions.thesisId, ids)));
      if (!existing) return undefined;
      const resolvedAt = outcome === "pending" ? null : new Date();
      const patch: Record<string, unknown> = { outcome, resolvedAt };
      if (resolutionNotes !== undefined) patch.resolutionNotes = resolutionNotes;
      const [row] = await db.update(thesisPredictions)
        .set(patch)
        .where(and(eq(thesisPredictions.id, id), inArray(thesisPredictions.thesisId, ids)))
        .returning();
      if (row) await this.touchThesis(row.thesisId);
      return row;
    });
  }

  async updatePrediction(id: string, updates: Partial<Pick<InsertThesisPrediction, "claim" | "deadline" | "conviction" | "resolutionNotes">>): Promise<ThesisPrediction | undefined> {
    return autoHeal(async () => {
      const ids = await writableThesisIds();
      if (ids.length === 0) return undefined;
      const [existing] = await db.select().from(thesisPredictions)
        .where(and(eq(thesisPredictions.id, id), inArray(thesisPredictions.thesisId, ids)));
      if (!existing) return undefined;
      const [row] = await db.update(thesisPredictions)
        .set(updates)
        .where(and(eq(thesisPredictions.id, id), inArray(thesisPredictions.thesisId, ids)))
        .returning();
      if (row) await this.touchThesis(row.thesisId);
      return row;
    });
  }

  async removePrediction(id: string): Promise<boolean> {
    return autoHeal(async () => {
      const ids = await writableThesisIds();
      if (ids.length === 0) return false;
      const [existing] = await db.select().from(thesisPredictions)
        .where(and(eq(thesisPredictions.id, id), inArray(thesisPredictions.thesisId, ids)));
      if (!existing) return false;
      const result = await db.delete(thesisPredictions)
        .where(and(eq(thesisPredictions.id, id), inArray(thesisPredictions.thesisId, ids))).returning();
      if (result.length > 0) await this.touchThesis(result[0].thesisId);
      return result.length > 0;
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────
  private async touchThesis(thesisId: string): Promise<void> {
    await db.update(theses).set({ updatedAt: new Date() }).where(writableThesis(eq(theses.id, thesisId)));
  }

  // ── Calibration ─────────────────────────────────────────────────────
  async computeBrierScore(thesisId?: string): Promise<{
    overall: number | null;
    byThesis: Record<string, { score: number; resolved: number; correct: number }>;
    totalResolved: number;
    totalPending: number;
    overdue: number;
  }> {
    return autoHeal(async () => {
      const CONVICTION_PROBABILITY = { high: 0.9, low: 0.3 } as const;

      // Get all predictions (optionally filtered by thesis)
      let rows: ThesisPrediction[];
      if (thesisId) {
        const ids = await visibleThesisIds(eq(theses.id, thesisId));
        rows = ids.length > 0
          ? await db.select().from(thesisPredictions).where(inArray(thesisPredictions.thesisId, ids))
          : [];
      } else {
        const ids = await visibleThesisIds();
        rows = ids.length > 0
          ? await db.select().from(thesisPredictions).where(inArray(thesisPredictions.thesisId, ids))
          : [];
      }

      const resolved = rows.filter(p => p.outcome === "correct" || p.outcome === "incorrect");
      const pending = rows.filter(p => p.outcome === "pending");
      const overdue = pending.filter(p => p.deadline && new Date(p.deadline) < new Date());

      // Overall Brier score
      let overall: number | null = null;
      if (resolved.length > 0) {
        const sum = resolved.reduce((acc, p) => {
          const conviction = (p as { conviction?: string }).conviction as string || "low";
          const prob = CONVICTION_PROBABILITY[conviction as keyof typeof CONVICTION_PROBABILITY] ?? 0.3;
          const actual = p.outcome === "correct" ? 1 : 0;
          return acc + Math.pow(prob - actual, 2);
        }, 0);
        overall = sum / resolved.length;
      }

      // Per-thesis breakdown
      const byThesis: Record<string, { score: number; resolved: number; correct: number }> = {};
      const grouped = new Map<string, ThesisPrediction[]>();
      for (const r of resolved) {
        const arr = grouped.get(r.thesisId) || [];
        arr.push(r);
        grouped.set(r.thesisId, arr);
      }
      for (const [tid, preds] of grouped) {
        const sum = preds.reduce((acc, p) => {
          const conviction = (p as { conviction?: string }).conviction as string || "low";
          const prob = CONVICTION_PROBABILITY[conviction as keyof typeof CONVICTION_PROBABILITY] ?? 0.3;
          const actual = p.outcome === "correct" ? 1 : 0;
          return acc + Math.pow(prob - actual, 2);
        }, 0);
        byThesis[tid] = {
          score: sum / preds.length,
          resolved: preds.length,
          correct: preds.filter(p => p.outcome === "correct").length,
        };
      }

      return { overall, byThesis, totalResolved: resolved.length, totalPending: pending.length, overdue: overdue.length };
    });
  }
}

export const thesisStorage = new ThesisStorage();

// ── Schema Migration ───────────────────────────────────────────────
export async function migrateThesisSchema(): Promise<void> {
  const migrations = [
    `CREATE TABLE IF NOT EXISTS theses (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       title text NOT NULL,
       statement text NOT NULL DEFAULT '',
       tags text[] NOT NULL DEFAULT '{}'::text[],
       status text NOT NULL DEFAULT 'draft',
       conviction text NOT NULL DEFAULT 'low',
       successor_id text,
       created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_theses_status ON theses(status)`,
    `CREATE TABLE IF NOT EXISTS thesis_evidence (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       thesis_id text NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
       content text NOT NULL,
       source_url text NOT NULL DEFAULT '',
       position integer NOT NULL DEFAULT 0,
       created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_thesis_evidence_thesis ON thesis_evidence(thesis_id)`,
    `CREATE TABLE IF NOT EXISTS thesis_predictions (
       id text PRIMARY KEY DEFAULT gen_random_uuid(),
       thesis_id text NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
       claim text NOT NULL,
       deadline date,
       outcome text NOT NULL DEFAULT 'pending',
       resolved_at timestamptz,
       created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_thesis_predictions_thesis ON thesis_predictions(thesis_id)`,
    // Phase 1 Landscape Model: add conviction + resolution_notes to predictions
    `ALTER TABLE thesis_predictions ADD COLUMN IF NOT EXISTS conviction text NOT NULL DEFAULT 'low'`,
    `ALTER TABLE thesis_predictions ADD COLUMN IF NOT EXISTS resolution_notes text`,
    `ALTER TABLE theses ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user'`,
    `ALTER TABLE theses ADD COLUMN IF NOT EXISTS owner_user_id text`,
    `ALTER TABLE theses ADD COLUMN IF NOT EXISTS account_id text`,
    `CREATE INDEX IF NOT EXISTS idx_theses_scope_owner ON theses(scope, owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_theses_account ON theses(account_id)`,
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
