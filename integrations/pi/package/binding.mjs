/** Small pin check at extension load, never on a tick/command. Bundle verified at activation. */
import * as fs from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
function safe(file, directory = false) {
  if (typeof file !== 'string' || !isAbsolute(file) || resolve(file) !== file || /[\x00-\x1f\x7f]/.test(file))
    throw Error('unsafe_pi_pin');
  for (let p = file; ; p = dirname(p)) {
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink() || (p === file && (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)))
      throw Error('unsafe_pi_pin');
    if (s.mode & 0o022 && !(s.isDirectory() && s.mode & 0o1000)) throw Error('unsafe_pi_pin');
    if (p === dirname(p)) break;
  }
}
export function loadBinding(url) {
  const file = fileURLToPath(url);
  safe(file);
  if (fs.statSync(file).size > 16384) throw Error('pi_binding_limit');
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    b.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(b.digest) ||
    typeof b.release !== 'string' ||
    !b.release.endsWith('/releases/' + b.digest) ||
    typeof b.releaseVersion !== 'string'
  )
    throw Error('invalid_pi_binding');
  safe(b.release, true);
  safe(b.node);
  safe(b.hudHome, true);
  const home = fs.statSync(b.hudHome);
  if (home.uid !== process.getuid() || home.mode & 0o077) throw Error('unsafe_hud_home');
  const manifest = b.release + '/RUNTIME-MANIFEST.json';
  safe(manifest);
  if (
    fs.statSync(manifest).size > 4 * 1024 * 1024 ||
    createHash('sha256').update(fs.readFileSync(manifest)).digest('hex') !== b.digest
  )
    throw Error('pi_release_pin_changed');
  for (const entry of ['dist/harness/pi/package-entry.js', 'bin/hud', 'packages/hud-mcp/bin/hud-mcp.mjs'])
    safe(b.release + '/' + entry);
  return Object.freeze(b);
}
