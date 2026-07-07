import { BaseDocumentStore, principalCacheKey } from "./base";
import { TTLCache } from "../utils/ttl-cache";
import { createLogger } from "../log";

const parseLog = createLogger("StorePreferences");

export interface Preference {
  id: string;
  domain: string;
  preference: string;
  personName: string;
  evidence: string[];
  confidence: number;
  reinforcements: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function docToPreference(doc: { content: string; metadata: Record<string, unknown> }): Preference {
  const meta = doc.metadata;
  return {
    id: String(meta.id || ""),
    domain: String(meta.domain || ""),
    preference: String(meta.preference || ""),
    personName: String(meta.personName || ""),
    evidence: (meta.evidence as string[]) || [],
    confidence: Number(meta.confidence ?? 0.5),
    reinforcements: Number(meta.reinforcements ?? 0),
    tags: (meta.tags as string[]) || [],
    createdAt: String(meta.createdAt || new Date().toISOString()),
    updatedAt: String(meta.updatedAt || new Date().toISOString()),
  };
}

export class FilePreferenceStorage extends BaseDocumentStore<Preference> {
  private readonly _cache = new TTLCache<Preference[]>("Preferences", Infinity);

  constructor() {
    super({
      docType: "preference",
      logPrefix: "StorePreferences",
      pathPrefix: "preferences",
      getTitle: (p) => p.preference,
      docToEntity: docToPreference,
    });
  }

  private invalidateCache(): void {
    this._cache.invalidateAll();
  }

  async getAll(): Promise<Preference[]> {
    return this._cache.getOrFetch(principalCacheKey("preferences"), () => super.getAll());
  }

  async create(input: {
    domain: string;
    preference: string;
    personName?: string;
    evidence?: string[];
    confidence?: number;
    tags?: string[];
  }): Promise<Preference> {
    const now = this.nowISO();
    const pref: Preference = {
      id: this.newId(),
      domain: input.domain,
      preference: input.preference,
      personName: input.personName || "",
      evidence: input.evidence || [],
      confidence: input.confidence ?? 0.5,
      reinforcements: 0,
      tags: input.tags || [],
      createdAt: now,
      updatedAt: now,
    };

    await this.persistAndSync(pref, "create", " domain=" + pref.domain);
    this.invalidateCache();
    return pref;
  }

  async update(
    id: string,
    updates: Partial<Omit<Preference, "id" | "createdAt">>
  ): Promise<Preference | null> {
    const result = await this.updateEntity(id, updates);
    this.invalidateCache();
    return result;
  }

  async reinforce(id: string, evidence?: string): Promise<Preference | null> {
    this.log.log("reinforce id=" + id);
    const existing = await this.getById(id);
    if (!existing) return null;

    const updates: Partial<Preference> = {
      reinforcements: existing.reinforcements + 1,
      confidence: Math.min(1, existing.confidence + 0.05),
    };

    if (evidence) {
      updates.evidence = [...existing.evidence, evidence];
    }

    return this.update(id, updates);
  }
}

export const filePreferenceStorage = new FilePreferenceStorage();
