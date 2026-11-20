import { herdrId, herdrResult, isRecord, runHerdr } from '../roles/herdr-run.js';

/** One lease per picker opening. Herdr reports whether `--on` changed zoom atomically, so
 * an existing zoom never becomes ours, even if another client zooms just as we open. */
export function modelPickerZoom(env: NodeJS.ProcessEnv, repaint: () => void, run = runHerdr) {
  const pane = env.HERDR_PANE_ID;
  type Opening = { zoomed: boolean; ownsZoom: Promise<boolean> };
  let current: Opening | undefined, restoring: Promise<void> | undefined;
  const zoom = async (mode: '--on' | '--off') => {
    if (!herdrId(pane)) return;
    try {
      const reply = await run(['pane', 'zoom', mode, pane], env, { budgetMs: 1000 });
      const result = reply.ok ? herdrResult(reply.stdout)?.zoom : undefined;
      if (isRecord(result) && result.pane_id === pane && typeof result.zoom_changed === 'boolean') return result;
    } catch { /* Zoom is optional; keep the narrow picker on any transport failure. */ }
  };
  return {
    get zoomed() { return current?.zoomed === true; },
    get restoring() { return restoring !== undefined; },
    open() {
      if (current || !herdrId(pane)) return;
      const opening: Opening = { zoomed: false, ownsZoom: Promise.resolve(restoring).then(async () => {
        if (current !== opening) return false;
        const result = await zoom('--on');
        const zoomed = result?.zoomed === true && result.focused_pane_id === pane;
        if (current === opening && zoomed) {
          opening.zoomed = true;
          repaint();
        }
        return zoomed && result.zoom_changed === true;
      }) };
      current = opening;
    },
    close(): Promise<void> {
      if (!current) return restoring ?? Promise.resolve();
      const opening = current;
      current = undefined;
      // A close during --on must wait for its reply, and a reopen must wait for this restore.
      const task = opening.ownsZoom.then(async (owned) => { if (owned) await zoom('--off'); }).finally(() => {
        if (restoring === task) restoring = undefined;
      });
      restoring = task;
      return task;
    },
  };
}
