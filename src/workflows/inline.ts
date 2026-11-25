/** In-process host lifecycle. Retirement yields the run; user stop is persisted separately. */
const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
export function hostInline(id: string, drive: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const done = Promise.resolve().then(() => drive(controller.signal)).finally(() => running.delete(id));
  running.set(id, { controller, done });
  return done;
}
export const inlinePending = () => running.size > 0;
export async function retireInline() {
  for (const entry of running.values()) entry.controller.abort();
  await Promise.allSettled([...running.values()].map(e => e.done));
}
