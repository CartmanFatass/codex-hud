import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBuildLock } from './dist-lock.mjs';

const target = 'x86_64-unknown-linux-gnu';
export const nativeFiles = ['hud-statusline', 'source.sha256'];
const digest = (data) => createHash('sha256').update(data).digest('hex');
function reuse(dir, sourceHash) {
  try {
    const [path, stamp] = nativeFiles.map(name => join(dir, name));
    const [key, hash] = fs.readFileSync(stamp, 'utf8').split('\n');
    if (key !== sourceHash || !(fs.statSync(path).mode & 0o111)) return undefined;
    const bytes = fs.readFileSync(path);
    if (digest(bytes) === hash) return bytes;
  } catch { /* Local build artifact is optional. */ }
}

/** Content-keyed outside the dist staging areas; an incremental TS build does not start Cargo. */
export function buildNative(root, cache) {
  if (process.platform !== 'linux' || process.arch !== 'x64') return undefined;
  const source = join(root, 'native');
  if (!fs.existsSync(join(source, 'Cargo.toml'))) return undefined;
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(new URL(import.meta.url)));
  function inputs(rel = '') {
    const dir = join(source, rel);
    for (const name of fs.readdirSync(dir).sort()) {
      if (!rel && name === 'target') continue; // A developer's direct cargo build.
      const key = join(rel, name), file = join(source, key), stat = fs.lstatSync(file);
      if (stat.isDirectory()) inputs(key);
      else if (stat.isFile()) {
        hash.update(`${key}\0${stat.size}\0`);
        hash.update(fs.readFileSync(file));
      }
    }
  }
  inputs();
  const key = hash.digest('hex'), ready = join(cache, 'ready');
  if (reuse(ready, key)) return ready;
  // A gate starts in a new checkout. Reuse the landed artifact only when the candidate sources match exactly.
  let bytes = reuse(join(root, 'dist/native'), key);
  if (!bytes && process.env.HUD_NATIVE_REUSE_DIR) bytes = reuse(process.env.HUD_NATIVE_REUSE_DIR, key);
  if (!bytes) {
    if (spawnSync('cargo', ['--version'], { cwd: source, stdio: 'ignore' }).status !== 0) return undefined;
    const flags = [`--remap-path-prefix=${root}=/hud-source`];
    const result = spawnSync('cargo', ['build', '--offline', '--locked', '--release', '--target', target,
      '--target-dir', join(cache, 'cargo')], {
      cwd: source, stdio: 'inherit', env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') },
    });
    if (result.status !== 0) throw new Error('native statusline build failed');
    bytes = fs.readFileSync(join(cache, 'cargo', target, 'release', nativeFiles[0]));
  }
  fs.mkdirSync(ready, { recursive: true });
  const [binary, stamp] = nativeFiles.map(name => join(ready, name));
  fs.writeFileSync(binary, bytes, { mode: 0o755 });
  fs.chmodSync(binary, 0o755);
  fs.writeFileSync(stamp, `${key}\n${digest(bytes)}\n`);
  return ready;
}

// The release packager needs the same artifact without building TypeScript (dist is excluded).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const lock = await acquireBuildLock('build');
  try {
    const ready = buildNative(root, join(root, '.tsbuild/native'));
    if (ready) process.stdout.write(`${join(ready, nativeFiles[0])}\n`);
  } finally { lock.close(); }
}
