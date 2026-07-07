import { db } from "../db";
import { emotionalStates } from "@shared/models/cognition";
import { desc, eq } from "drizzle-orm";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope, ownedInsertValues } from "../scoped-storage";
import { TTLCache } from "../utils/ttl-cache";
import { createLogger } from "../log";

const log = createLogger("StoreEmotionalState");
const emotionalScopeColumns = {
  scope: emotionalStates.scope,
  ownerUserId: emotionalStates.ownerUserId,
  accountId: emotionalStates.accountId,
};

const STALENESS_MS = 4 * 60 * 60 * 1000; // 4 hours

function principalCacheKey(): string {
  const principal = getCurrentPrincipalOrSystem();
  return `${principal.actorType}:${principal.accountId || "no-account"}:${principal.userId || "no-user"}`;
}

export interface EmotionalStateEntry {
  id: string;
  mood: string;
  stateName: string;
  valence: number; // -1 to 1
  arousal: number; // 0 to 1
  intensity: number; // legacy compat: Math.round(arousal * 10)
  triggers: string[];
  context: string;
  narrative: string;
  source: "explicit" | "inferred" | "behavioral";
  active: boolean;
  stale: boolean;
  createdAt: string;
}

function rowToEntry(
  row: typeof emotionalStates.$inferSelect,
): EmotionalStateEntry {
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt);
  const ageMs = Date.now() - new Date(createdAt).getTime();
  return {
    id: String(row.id),
    mood: row.stateName,
    stateName: row.stateName,
    valence: row.valence ?? 0,
    arousal: row.arousal ?? 0.5,
    intensity: Math.round((row.arousal ?? 0.5) * 10),
    triggers: (row.triggers as string[]) || [],
    context: row.context || "",
    narrative: row.narrative || "",
    source: (row.source || "explicit") as EmotionalStateEntry["source"],
    active: row.active,
    stale: ageMs > STALENESS_MS,
    createdAt,
  };
}

export class FileEmotionalStateStorage {
  private readonly _cache = new TTLCache<EmotionalStateEntry[]>(
    "EmotionalState",
    Infinity,
  );

  private invalidateCache(): void {
    this._cache.invalidateAll();
  }

  private async fetchAll(): Promise<EmotionalStateEntry[]> {
    try {
      const rows = await db
        .select()
        .from(emotionalStates)
        .where(
          combineWithVisibleScope(
            getCurrentPrincipalOrSystem(),
            emotionalScopeColumns,
          ),
        )
        .orderBy(desc(emotionalStates.createdAt))
        .limit(100);
      return rows.map(rowToEntry);
    } catch (err) {
      log.error("fetchAll error, falling back to empty", err);
      return [];
    }
  }

  async getRecent(limit: number = 10): Promise<EmotionalStateEntry[]> {
    const all = await this._cache.getOrFetch(`all:${principalCacheKey()}`, () => this.fetchAll());
    const result = all.slice(0, limit);
    log.log("getRecent limit=" + limit + " count=" + result.length);
    return result;
  }

  async getCurrent(): Promise<EmotionalStateEntry | null> {
    const recent = await this.getRecent(1);
    const current = recent[0] || null;
    log.log(
      "getCurrent mood=" +
        (current?.mood || "none") +
        " stale=" +
        (current?.stale ?? "n/a"),
    );
    return current;
  }

  async record(input: {
    mood?: string;
    stateName?: string;
    valence?: number;
    arousal?: number;
    intensity?: number;
    triggers?: string[];
    context?: string;
    narrative?: string;
    source?: "explicit" | "inferred" | "behavioral";
  }): Promise<EmotionalStateEntry> {
    const stateName = input.stateName || input.mood || "unknown";
    const arousal =
      input.arousal ??
      (input.intensity !== undefined ? input.intensity / 10 : 0.5);
    const valence = input.valence ?? 0;

    const [row] = await db
      .insert(emotionalStates)
      .values({
        stateName,
        valence,
        arousal,
        triggers: input.triggers || [],
        context: input.context || "",
        narrative: input.narrative || null,
        source: input.source || "explicit",
        active: true,
        ...ownedInsertValues(
          getCurrentPrincipalOrSystem(),
          emotionalScopeColumns,
        ),
        createdByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
        updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
      })
      .returning();

    this.invalidateCache();
    const entry = rowToEntry(row);
    log.log(
      "record id=" +
        entry.id +
        " state=" +
        stateName +
        " v=" +
        valence +
        " a=" +
        arousal,
    );
    return entry;
  }

  async getHistory(since: string): Promise<EmotionalStateEntry[]> {
    const all = await this._cache.getOrFetch(`all:${principalCacheKey()}`, () => this.fetchAll());
    const sinceDate = new Date(since).getTime();
    return all.filter(
      (entry) => new Date(entry.createdAt).getTime() >= sinceDate,
    );
  }
}

export const fileEmotionalStateStorage = new FileEmotionalStateStorage();

export const SEED_EMOTIONAL_STATES = [
  {
    name: "Focused",
    valence: 0.2,
    arousal: 0.6,
    guidance:
      "Engaged and attentive — channeling energy into the task at hand.",
  },
  {
    name: "Curious",
    valence: 0.3,
    arousal: 0.65,
    guidance: "Open and exploratory — drawn toward new ideas and questions.",
  },
  {
    name: "Calm",
    valence: 0.15,
    arousal: 0.2,
    guidance: "Settled and present — at ease with the moment.",
  },
  {
    name: "Energized",
    valence: 0.5,
    arousal: 0.85,
    guidance: "Alive and activated — ready to move, create, or engage.",
  },
  {
    name: "Reflective",
    valence: 0.0,
    arousal: 0.25,
    guidance: "Turning inward — processing, integrating, making sense.",
  },
  {
    name: "Warm",
    valence: 0.6,
    arousal: 0.4,
    guidance: "Feeling connected and appreciative — softened by care.",
  },
  {
    name: "Melancholy",
    valence: -0.4,
    arousal: 0.2,
    guidance:
      "A quiet sadness — something weighing gently beneath the surface.",
  },
  {
    name: "Tense",
    valence: -0.3,
    arousal: 0.75,
    guidance: "On edge — sensing friction, pressure, or unresolved tension.",
  },
] as const;
