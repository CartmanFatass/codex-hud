// Tab-only UI entry: mounts HUD's own footer (with native t/s). Headless workers never load this entry.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
export default async function hudWorkerUi(pi) {
  const root = new URL('../../../', pathToFileURL(realpathSync(new URL(import.meta.url))));
  const { withDistLock } = await import(new URL('scripts/dist-lock.mjs', root).href);
  const { installWorkerUi } = await withDistLock(() => import(new URL('dist/harness/pi/worker/tab-ui.js', root).href), root);
  installWorkerUi(pi, { CustomEditor, visibleWidth, truncateToWidth });
}
