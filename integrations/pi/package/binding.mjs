/** Load the local checkout binding once, before registering the extension. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export function loadBinding(url) {
  let binding;
  try {
    binding = JSON.parse(fs.readFileSync(url, 'utf8'));
  } catch {
    throw Error('invalid_pi_binding');
  }
  if (!binding || !['release', 'hudHome', 'node'].every((key) => typeof binding[key] === 'string' && binding[key]))
    throw Error('invalid_pi_binding');
  if (!fs.statSync(binding.hudHome).isDirectory() || !fs.statSync(binding.node).isFile())
    throw Error('invalid_pi_binding');
  for (const entry of ['dist/harness/pi/package-entry.js', 'bin/hud', 'packages/hud-mcp/bin/hud-mcp.mjs'])
    if (!fs.statSync(join(binding.release, entry)).isFile()) throw Error('invalid_pi_binding');
  return Object.freeze(binding);
}

export async function loadRuntime(binding) {
  const url = (file) => pathToFileURL(join(binding.release, file)).href;
  const { withDistLock } = await import(url('scripts/dist-lock.mjs'));
  return withDistLock(() => import(url('dist/harness/pi/package-entry.js')), binding.release);
}
