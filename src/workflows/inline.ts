/** In-process host lifecycle, including MCP task handoff/shutdown. A step can
 * hand cancellation back to the ordinary job before its launch finishes. */
const running = new Map<string, { controller?: AbortController; done: Promise<void> }>();
export function hostInline(id: string, drive: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const done = Promise.resolve().then(() => drive(controller.signal)).finally(() => running.delete(id));
  running.set(id, { controller, done });
  return done;
}
export function handOffInline(id: string) {
  const entry = running.get(id);
  if (entry) delete entry.controller;
}
export const inlinePending = () => running.size > 0;
export function abortInline(id: string) {
  const controller = running.get(id)?.controller;
  controller?.abort();
  return !!controller;
}
export async function shutdownInline() {
  for (const entry of running.values()) entry.controller?.abort();
  await Promise.allSettled([...running.values()].map(e => e.done));
}
