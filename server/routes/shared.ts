export { pathExists } from "../fs-utils";

const responseCache = new Map<string, { data: unknown; expires: number; pending?: Promise<unknown> }>();

export async function getCached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = responseCache.get(key);
  if (cached && cached.expires > now) {
    return cached.data as T;
  }
  if (cached?.pending) {
    return cached.pending as Promise<T>;
  }
  const pending = fetcher().then((data) => {
    responseCache.set(key, { data, expires: Date.now() + ttlMs });
    return data;
  }).catch((err) => {
    const entry = responseCache.get(key);
    if (entry?.pending === pending) {
      responseCache.delete(key);
    }
    throw err;
  });
  responseCache.set(key, { ...(cached || { data: null, expires: 0 }), pending });
  return pending;
}
