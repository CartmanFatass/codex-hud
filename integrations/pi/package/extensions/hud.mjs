/** Release-independent delegation entry: the six role tools. No resources start before session_start. */
import { pathToFileURL } from 'node:url';
import { loadBinding } from '../binding.mjs';
export default async function hud(pi) {
  const binding = loadBinding(new URL('../binding.json', import.meta.url));
  const { installPiPackage } = await import(pathToFileURL(binding.release + '/dist/harness/pi/package-entry.js').href);
  installPiPackage(pi, binding, {}, 'delegate');
}
