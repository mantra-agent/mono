import { documentStorage } from "../memory/document-storage";
import { tagRegistry } from "./tags";
import { generateId } from "./utils";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import type { DocType } from "@shared/models/memory";

type Logger = ReturnType<typeof createLogger>;

export function principalCacheKey(label: string): string {
  const principal = getCurrentPrincipalOrSystem();
  return [
    label,
    principal.actorType,
    principal.userId || "none",
    principal.accountId || "none",
  ].join(":");
}


const entityLocks = new Map<string, Promise<unknown>>();

export function withEntityLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = entityLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  entityLocks.set(key, next);
  next.finally(() => {
    if (entityLocks.get(key) === next) entityLocks.delete(key);
  });
  return next;
}

interface BaseEntity {
  id: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface DocumentStoreConfig<T extends BaseEntity> {
  docType: DocType;
  logPrefix: string;
  pathPrefix: string;
  getTitle: (entity: T) => string;
  docToEntity: (doc: { content: string; metadata: Record<string, unknown> }) => T;
}

export abstract class BaseDocumentStore<T extends BaseEntity> {
  protected readonly log: Logger;
  private readonly config: DocumentStoreConfig<T>;

  constructor(config: DocumentStoreConfig<T>) {
    this.config = config;
    this.log = createLogger(config.logPrefix);
  }

  protected get docType(): DocType {
    return this.config.docType;
  }

  async getAll(): Promise<T[]> {
    const docs = await documentStorage.getDocumentsByType(this.config.docType);
    const entities: T[] = [];
    for (const doc of docs) {
      try {
        entities.push(this.config.docToEntity({ content: doc.content, metadata: (doc.metadata || {}) as Record<string, unknown> }));
      } catch (err) {
        const parseError = err instanceof Error ? err.message : String(err);
        this.log.error("getAll parse error", { docId: doc.id, docType: this.config.docType, error: parseError });
        throw err;
      }
    }
    entities.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    this.log.log("getAll count=" + entities.length);
    return entities;
  }

  async getById(id: string): Promise<T | null> {
    const doc = await documentStorage.getDocument(this.config.docType, id);
    if (!doc) {
      this.log.log("getById not-found id=" + id);
      return null;
    }
    try {
      const result = this.config.docToEntity({ content: doc.content, metadata: (doc.metadata || {}) as Record<string, unknown> });
      this.log.log("getById found id=" + id);
      return result;
    } catch (err) {
      const parseError = err instanceof Error ? err.message : String(err);
      this.log.error("getById parse error", { id, docType: this.config.docType, error: parseError });
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await documentStorage.deleteDocument(this.config.docType, id);
    if (!deleted) {
      this.log.log("delete not-found id=" + id);
      return false;
    }
    this.log.log("delete id=" + id);
    try {
      await tagRegistry.removeEntityTags(this.config.docType as any, id);
    } catch (err) {
      const tagError = err instanceof Error ? err.message : String(err);
      this.log.error("delete tag cleanup error", { id, docType: this.config.docType, error: tagError });
      throw err;
    }
    return true;
  }

  protected async persistAndSync(entity: T, logAction: string, logExtra: string = ""): Promise<void> {
    const content = JSON.stringify(entity, null, 2);
    const metadata: Record<string, unknown> = { ...(entity as any) };

    await documentStorage.upsertDocument(
      this.config.docType,
      entity.id,
      `${this.config.pathPrefix}/${entity.id}.json`,
      this.config.getTitle(entity),
      content,
      metadata
    );

    this.log.log(logAction + " id=" + entity.id + logExtra);

    try {
      await tagRegistry.syncEntityTags(this.config.docType as any, entity.id, this.config.getTitle(entity), entity.tags);
    } catch (err) {
      const tagError = err instanceof Error ? err.message : String(err);
      this.log.error(logAction + " tag sync error", { id: entity.id, docType: this.config.docType, error: tagError });
      throw err;
    }
  }

  protected async updateEntity(id: string, updates: Partial<Omit<T, "id" | "createdAt">>): Promise<T | null> {
    const lockKey = `${this.docType}:${id}`;
    return withEntityLock(lockKey, async () => {
      const existing = await this.getById(id);
      if (!existing) {
        this.log.log("update not-found id=" + id);
        return null;
      }

      const updated: T = {
        ...existing,
        ...updates,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };

      const content = JSON.stringify(updated, null, 2);
      const metadata: Record<string, unknown> = { ...(updated as any) };
      const persisted = await documentStorage.updateDocument(this.config.docType, id, {
        path: `${this.config.pathPrefix}/${id}.json`,
        title: this.config.getTitle(updated),
        content,
        metadata,
      });
      if (!persisted) {
        this.log.log("update not-writable id=" + id);
        return null;
      }
      this.log.log("update id=" + id + " fields=" + Object.keys(updates).join(","));
      try {
        await tagRegistry.syncEntityTags(this.config.docType as any, updated.id, this.config.getTitle(updated), updated.tags);
      } catch (err) {
        const tagError = err instanceof Error ? err.message : String(err);
        this.log.error("update tag sync error", { id: updated.id, docType: this.config.docType, error: tagError });
        throw err;
      }
      return updated;
    });
  }

  protected newId(): string {
    return generateId();
  }

  protected nowISO(): string {
    return new Date().toISOString();
  }
}
