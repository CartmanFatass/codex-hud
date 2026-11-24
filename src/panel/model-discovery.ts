import { discoverModelLists, readModelListCache } from '../roles/model-discovery.js';

/** Refresh the model catalog for Control's picker, not model-generated panel text. */
export function createPanelModelDiscovery(home: string, isClosed: () => boolean) {
  let lastControlShown = false;
  let active: AbortController | null = null;
  const refresh = (force: boolean) => {
    if (isClosed() || active || (!force && readModelListCache(home, Date.now()))) return;
    const controller = active = new AbortController();
    void discoverModelLists(home, process.env, Date.now(), { signal: controller.signal })
      .catch(() => undefined)
      .finally(() => { active = null; });
  };
  return {
    refresh,
    sync(shown: boolean) {
      if (shown && !lastControlShown) refresh(false);
      lastControlShown = shown;
    },
    dispose: () => active?.abort(),
  };
}
