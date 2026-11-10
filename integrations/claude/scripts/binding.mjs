import * as fs from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export function safe(file, directory = false) {
  if (!isAbsolute(file) || resolve(file) !== file || /[\x00-\x1f\x7f]/.test(file)) throw Error('unsafe_pin');
  for (let p = file; ; p = dirname(p)) {
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink() || (p === file && (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)))
      throw Error('unsafe_pin');
    if (s.mode & 0o022 && !(s.isDirectory() && s.mode & 0o1000)) throw Error('unsafe_pin');
    if (p === dirname(p)) break;
  }
}
export function loadPin(url) {
  const file = fileURLToPath(url);
  safe(file);
  if (fs.statSync(file).size > 16384) throw Error('binding_limit');
  let p;
  try {
    p = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('invalid_binding');
  }
  if (
    p.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(p.digest) ||
    typeof p.release !== 'string' ||
    !p.release.endsWith('/releases/' + p.digest)
  )
    throw Error('invalid_binding');
  safe(p.release, true);
  safe(p.node);
  safe(p.hudHome, true);
  if (fs.statSync(p.hudHome).uid !== process.getuid() || fs.statSync(p.hudHome).mode & 0o077)
    throw Error('unsafe_hud_home');
  const manifest = p.release + '/RUNTIME-MANIFEST.json';
  safe(manifest);
  if (
    fs.statSync(manifest).size > 4 * 1024 * 1024 ||
    createHash('sha256').update(fs.readFileSync(manifest)).digest('hex') !== p.digest
  )
    throw Error('release_pin_changed');
  for (const entry of [
    'dist/integrations/claude/hook.js',
    'dist/integrations/claude/mcp.js',
    'bin/hud',
    'packages/hud-mcp/bin/hud-mcp.mjs',
  ])
    safe(p.release + '/' + entry);
  // Inventory availability is a preview/apply concern, never an MCP/panel/rollback prerequisite.
  if (
    p.parityInventory !== null &&
    (typeof p.parityInventory !== 'string' ||
      !isAbsolute(p.parityInventory) ||
      resolve(p.parityInventory) !== p.parityInventory ||
      /[\x00-\x1f\x7f]/.test(p.parityInventory))
  )
    throw Error('invalid_parity_inventory_path');
  return Object.freeze(p);
}
