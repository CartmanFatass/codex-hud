// Core install links this entry; resolve the matching compiled release, not pi's cwd.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export default async function hudWorker(pi) {
  try {
    const root = new URL('../../../', pathToFileURL(realpathSync(new URL(import.meta.url))));
    const { withDistLock } = await import(new URL('scripts/dist-lock.mjs', root).href);
    const { installWorker } = await withDistLock(() => import(new URL('dist/harness/pi/worker/index.js', root).href), root);
    await installWorker(pi);
  } catch (error) {
    // Pi logs ordinary extension errors and continues. A bound worker must never run unconfigured.
    console.error('[hud-worker]', error.message);
    process.exit(2);
  }
}
