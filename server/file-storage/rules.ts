import { BaseDocumentStore, principalCacheKey } from "./base";
import { TTLCache } from "../utils/ttl-cache";

export interface Rule {
  id: string;
  rule: string;
  source: "correction" | "reflection" | "manual";
  scope: "always" | "contextual";
  context: string;
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
    tags: (meta.tags as string[]) || [],
    createdAt: String(meta.createdAt || new Date().toISOString()),
    updatedAt: String(meta.updatedAt || new Date().toISOString()),
  };
}

export class FileRuleStorage extends BaseDocumentStore<Rule> {
  private readonly allCache = new TTLCache<Rule[]>("Rules", 60_000);

  constructor() {
    super({
      docType: "rule",
      logPrefix: "StoreRules",
      pathPrefix: "rules",
      getTitle: (rule) => rule.rule,
      docToEntity: docToRule,
    });
  }

  private invalidateRuleCache(): void {
    this.allCache.invalidateAll();
  }

  async getAll(): Promise<Rule[]> {
    return this.allCache.getOrFetch(principalCacheKey("rules"), () => super.getAll());
  }

  async create(input: {
    rule: string;
    source?: Rule["source"];
    scope?: Rule["scope"];
    context?: string;
    tags?: string[];
  }): Promise<Rule> {
    const rule = input.rule.trim();
    if (!rule) throw new Error("Rule text is required");
    const scope = input.scope || (input.context ? "contextual" : "always");
    const context = input.context?.trim() || "";
    if (scope === "contextual" && !context) {
      throw new Error("Context is required for a contextual Rule");
    }

    const now = this.nowISO();
    const entry: Rule = {
      id: this.newId(),
      rule,
      source: input.source || "manual",
      scope,
      context: scope === "always" ? "" : context,
      tags: input.tags || [],
      createdAt: now,
      updatedAt: now,
    };

    await this.persistAndSync(entry, "create", ` source=${entry.source} scope=${entry.scope}`);
    this.invalidateRuleCache();
    return entry;
  }

  async restoreFromMigration(
    id: string,
    input: {
      rule: string;
      source: Rule["source"];
      scope: Rule["scope"];
      context?: string;
      tags: string[];
    },
  ): Promise<Rule> {
    const existingById = await this.getById(id);
    if (existingById) return existingById;

    const existingByText = (await this.getAll()).find(
      (candidate) => candidate.rule.trim().toLowerCase() === input.rule.trim().toLowerCase(),
    );
    if (existingByText) return existingByText;

    const rule = input.rule.trim();
    const context = input.context?.trim() || "";
    if (!rule) throw new Error("Rule text is required");
    if (input.scope === "contextual" && !context) {
      throw new Error("Context is required for a contextual Rule");
    }

    const now = this.nowISO();
    const restored: Rule = {
      id,
      rule,
      source: input.source,
      scope: input.scope,
      context: input.scope === "always" ? "" : context,
      tags: input.tags,
      createdAt: now,
      updatedAt: now,
    };
    await this.persistAndSync(restored, "restoreFromMigration", ` scope=${restored.scope}`);
    this.invalidateRuleCache();
    return restored;
  }

  async update(id: string, updates: Partial<Omit<Rule, "id" | "createdAt">>): Promise<Rule | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    const nextScope = updates.scope ?? existing.scope;
    const nextContext = nextScope === "always"
      ? ""
      : (updates.context ?? existing.context).trim();
    if (nextScope === "contextual" && !nextContext) {
      throw new Error("Context is required for a contextual Rule");
    }
    const normalized = {
      ...updates,
      ...(typeof updates.rule === "string" ? { rule: updates.rule.trim() } : {}),
      scope: nextScope,
      context: nextContext,
    };
    if (normalized.rule === "") throw new Error("Rule text is required");
    const result = await this.updateEntity(id, normalized);
    this.invalidateRuleCache();
    return result;
  }

  async delete(id: string): Promise<boolean> {
    const result = await super.delete(id);
    if (result) this.invalidateRuleCache();
    return result;
  }
}

export const fileRuleStorage = new FileRuleStorage();
