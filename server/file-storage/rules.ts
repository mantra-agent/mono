import { BaseDocumentStore, principalCacheKey } from "./base";
import { createLogger } from "../log";
import { TTLCache } from "../utils/ttl-cache";

const parseLog = createLogger("StoreRules");

export interface Rule {
  id: string;
  rule: string;
  source: "correction" | "reflection" | "manual";
  scope: "always" | "contextual";
  context: string;
  confidence: number;
  reinforcements: number;
  violations: number;
  principleRef: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function docToRule(doc: { content: string; metadata: Record<string, unknown> }): Rule {
  const meta = doc.metadata;
  return {
    id: String(meta.id || ""),
    rule: String(meta.rule || ""),
    source: (meta.source as Rule["source"]) || "manual",
    scope: (meta.scope as Rule["scope"]) || "contextual",
    context: String(meta.context || ""),
    confidence: Number(meta.confidence ?? 0.5),
    reinforcements: Number(meta.reinforcements ?? 0),
    violations: Number(meta.violations ?? 0),
    principleRef: String(meta.principleRef || ""),
    tags: (meta.tags as string[]) || [],
    createdAt: String(meta.createdAt || new Date().toISOString()),
    updatedAt: String(meta.updatedAt || new Date().toISOString()),
  };
}

export class FileRuleStorage extends BaseDocumentStore<Rule> {
  private readonly _allCache = new TTLCache<Rule[]>("Rules", 60_000);

  constructor() {
    super({
      docType: "rule",
      logPrefix: "StoreRules",
      pathPrefix: "rules",
      getTitle: (r) => r.rule,
      docToEntity: docToRule,
    });
  }

  private invalidateRuleCache(): void {
    this._allCache.invalidateAll();
  }

  async getAll(): Promise<Rule[]> {
    return this._allCache.getOrFetch(principalCacheKey("rules"), () => super.getAll());
  }

  async create(input: {
    rule: string;
    source?: Rule["source"];
    scope?: Rule["scope"];
    context?: string;
    confidence?: number;
    principleRef?: string;
    tags?: string[];
  }): Promise<Rule> {
    const now = this.nowISO();
    const entry: Rule = {
      id: this.newId(),
      rule: input.rule,
      source: input.source || "manual",
      scope: input.scope || "contextual",
      context: input.context || "",
      confidence: input.confidence ?? 0.5,
      reinforcements: 0,
      violations: 0,
      principleRef: input.principleRef || "",
      tags: input.tags || [],
      createdAt: now,
      updatedAt: now,
    };

    await this.persistAndSync(entry, "create", " source=" + entry.source + " scope=" + entry.scope);
    this.invalidateRuleCache();
    return entry;
  }

  async update(id: string, updates: Partial<Omit<Rule, "id" | "createdAt">>): Promise<Rule | null> {
    const result = await this.updateEntity(id, updates);
    this.invalidateRuleCache();
    return result;
  }

  async delete(id: string): Promise<boolean> {
    const result = await super.delete(id);
    if (result) this.invalidateRuleCache();
    return result;
  }

  async reinforce(id: string): Promise<Rule | null> {
    this.log.log("reinforce id=" + id);
    const existing = await this.getById(id);
    if (!existing) return null;
    return this.update(id, {
      reinforcements: existing.reinforcements + 1,
      confidence: Math.min(1, existing.confidence + 0.05),
    });
  }

  async recordViolation(id: string): Promise<Rule | null> {
    this.log.log("recordViolation id=" + id);
    const existing = await this.getById(id);
    if (!existing) return null;
    return this.update(id, {
      violations: existing.violations + 1,
      confidence: Math.max(0, existing.confidence - 0.1),
    });
  }
}

export const fileRuleStorage = new FileRuleStorage();
