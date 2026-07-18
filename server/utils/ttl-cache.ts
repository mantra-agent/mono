import { createLogger } from "../log";

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttlMs: number;
}

export class TTLCache<T> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly keyGenerations = new Map<string, number>();
  private globalGeneration = 0;
  private readonly log;
  private readonly name: string;

  constructor(name: string, private readonly defaultTtlMs: number) {
    this.name = name;
    this.log = createLogger(`TTLCache:${name}`);
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    const elapsed = Date.now() - entry.cachedAt;
    if (elapsed >= entry.ttlMs) {
      this.cache.delete(key);
      this.log.verbose(() => `EXPIRED key=${key} age=${Math.round(elapsed / 1000)}s ttl=${Math.round(entry.ttlMs / 1000)}s`);
      return undefined;
    }
    this.log.verbose(() => `HIT key=${key} ttlRemaining=${Math.round((entry.ttlMs - elapsed) / 1000)}s`);
    return entry.data;
  }

  set(key: string, data: T, ttlMs?: number): void {
    this.cache.set(key, { data, cachedAt: Date.now(), ttlMs: ttlMs ?? this.defaultTtlMs });
  }

  async getOrFetch(key: string, fetcher: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const existing = this.inFlight.get(key);
    if (existing) {
      this.log.verbose(() => `COALESCE key=${key} — awaiting in-flight fetch`);
      return existing;
    }

    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    const globalGeneration = this.globalGeneration;
    const keyGeneration = this.keyGenerations.get(key) || 0;
    const promise = fetcher().then(data => {
      if (this.globalGeneration === globalGeneration && (this.keyGenerations.get(key) || 0) === keyGeneration) {
        this.set(key, data, effectiveTtl);
        this.log.verbose(() => `MISS key=${key} — fetched and cached ttl=${Math.round(effectiveTtl / 1000)}s`);
      } else {
        this.log.verbose(() => `STALE key=${key} — fetch completed after invalidation; result not cached`);
      }
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      return data;
    }).catch(err => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      throw err;
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  invalidate(key: string): void {
    const had = this.cache.delete(key);
    const hadInFlight = this.inFlight.delete(key);
    this.keyGenerations.set(key, (this.keyGenerations.get(key) || 0) + 1);
    if (had || hadInFlight) {
      this.log.verbose(() => `INVALIDATED key=${key}`);
    }
  }

  invalidateAll(): void {
    const count = this.cache.size;
    this.globalGeneration++;
    this.cache.clear();
    this.inFlight.clear();
    this.keyGenerations.clear();
    if (count > 0) {
      this.log.verbose(() => `INVALIDATED_ALL count=${count}`);
    }
  }

  evictOldest(): boolean {
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      this.cache.delete(firstKey);
      return true;
    }
    return false;
  }

  get size(): number {
    return this.cache.size;
  }
}
