/** HUD delegation tools for main pi sessions. */
import { loadBinding, loadRuntime } from '../binding.mjs';
export default async function hud(pi) {
  const binding = loadBinding(new URL('../binding.json', import.meta.url));
  const { installPiPackage } = await loadRuntime(binding);
  installPiPackage(pi, binding, {}, 'delegate');
}
