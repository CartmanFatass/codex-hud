/** A1 fixture upgraded with real built worker bytes; no source checkout imports at runtime. */
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { fixture, rewriteManifest } from '../../scripts/runtime-package/test-fixture.mjs';
const repo = new URL('../../', import.meta.url);
export async function stagedWorker(t) {
  const f = fixture(t, 'worker');
  function copy(relative, source = new URL(relative, repo)) {
    const data = fs.readFileSync(source);
    const target = join(f.bundle, relative);
    fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, data, { mode: 0o600 });
    const entry = {
      path: relative,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      mode: '0600',
    };
    const i = f.manifest.entries.findIndex((e) => e.path === relative);
    if (i < 0) f.manifest.entries.push(entry);
    else f.manifest.entries[i] = entry;
  }
  function tree(relative, accept) {
    const dir = new URL(relative + '/', repo);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) tree(path, accept);
      else if (accept(path)) copy(path);
    }
  }
  tree('dist', (p) => p.endsWith('.js') || p.endsWith('.json'));
  tree('integrations/pi/roles', () => true);
  copy('integrations/pi/skills/helper-pane/SKILL.md');
  copy('integrations/pi/worker.ts');
  tree('node_modules/@iarna/toml', () => true);
  rewriteManifest(f, () => {});
  const releaseModule = await import(pathToFileURL(join(f.bundle, 'dist/roles/pi-owned/release.js')).href);
  const release = await releaseModule.loadWorkerRelease();
  return {
    ...f,
    release,
    copy,
    releaseModule,
    reaper: await import(pathToFileURL(join(f.bundle, 'dist/roles/pi-owned/reap-main.js')).href),
  };
}
