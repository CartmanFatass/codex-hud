/** Shared request-key and job-key serialization. */


// Only calls touching the same request key or job wait on one another.
export const locks = new Map<string, Promise<unknown>>();
export async function keyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}
