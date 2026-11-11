/** Release-independent display entry: the owned footer, the Work segment and /hud. */
import { pathToFileURL } from 'node:url';
import { loadBinding } from '../binding.mjs';
// Static host imports let pi's loader resolve its own peer aliases (including a
// standalone/bundled host); native lazy imports escape that resolver for .mjs.
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
export default async function hud(pi) {
  const binding = loadBinding(new URL('../binding.json', import.meta.url));
  const { installPiPackage } = await import(pathToFileURL(binding.release + '/dist/harness/pi/package-entry.js').href);
  installPiPackage(
    pi,
    binding,
    {
      async footerHost() {
        return { CustomEditor, visibleWidth, truncateToWidth };
      },
    },
    'display'
  );
}
