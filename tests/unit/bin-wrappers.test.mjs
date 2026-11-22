import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const bin = 'packages/hud-mcp/bin';
const wrappers = ['herdr-request', 'hud-ask', 'hud-check', 'hud-cli', 'hud-jev', 'hud-lease', 'hud-notify',
  'hud-progress', 'hud-sonic', 'hud-watch', 'sonic-jobs', 'sonic-run', 'watch-runtime', 'worker-tools'];
function release(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud wrapper test '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('installed bin paths and executable bits survive the move to dist', () => {
  const bootstraps = ['generation', 'agy-events', 'hud-mcp', 'land-runner', 'surface'];
  assert.deepEqual(fs.readdirSync(bin).filter(file => file.endsWith('.mjs')).sort(),
    [...wrappers, ...bootstraps].map(name => `${name}.mjs`).sort());
  for (const name of wrappers) assert.ok(fs.readFileSync(join(bin, `${name}.mjs`), 'utf8').trimEnd().split('\n').length <= 6, name);
  for (const name of ['hud-check', 'hud-mcp', 'hud-watch']) fs.accessSync(join(bin, `${name}.mjs`), fs.constants.X_OK);
});

test('MCP refuses an unsupported Node before loading any dist modules', t => {
  const root = release(t);
  for (const path of [bin, 'scripts/dist-lock.mjs']) fs.cpSync(path, join(root, path), { recursive: true });
  const preload = 'data:text/javascript,' + encodeURIComponent("Object.defineProperty(process.versions,'node',{value:'22.0.0'})");
  const cli = spawnSync(process.execPath, ['--import', preload, join(root, bin, 'hud-mcp.mjs')], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, 'hud-mcp requires Node >=24.0.0 (running 22.0.0).\n');
});

test('notify exports its library without running; CLI forwards the prompt and helper exit status', async t => {
  const root = release(t), capture = join(root, 'prompt');
  const api = await import('../../packages/hud-mcp/bin/hud-notify.mjs');
  for (const name of ['ensureQueueWatcher', 'hasAgyEvents', 'notify', 'notifyAgy', 'paneInfo', 'registerPiWatcher', 'taskDelivery', 'watching'])
    assert.equal(typeof api[name], 'function', name);
  fs.writeFileSync(join(root, 'herdr'), '#!/bin/sh\nif [ "$1" = agent ]; then printf "%s\\n" "$@" > "$CAPTURE"; fi\nexit 19\n', { mode: 0o700 });
  const cli = spawnSync(process.execPath, [join(bin, 'hud-notify.mjs'), root, 'pane-1', 'synthetic', 'hello world'],
    { env: { ...process.env, CAPTURE: capture, PATH: root }, encoding: 'utf8' });
  assert.equal(cli.status, 19, cli.stderr);
  assert.equal(fs.readFileSync(capture, 'utf8'), 'agent\nprompt\npane-1\nhello world\n');
});

test('sparse worker binding needs no adjacent bins; paths resolve in a release with spaces', async t => {
  const root = release(t), worker = join(bin, 'worker-tools.mjs');
  for (const path of ['scripts/dist-lock.mjs', worker]) fs.cpSync(path, join(root, path));
  fs.symlinkSync(resolve('dist'), join(root, 'dist'));
  const api = await import(pathToFileURL(join(root, worker)));
  assert.ok((await api.listWorkerTools()).some(({ name }) => name === 'hud_report'));
  fs.cpSync('package.json', join(root, 'package.json'));
  const module = join(root, 'dist copy', 'mcp', 'paths.js');
  fs.mkdirSync(dirname(module), { recursive: true });
  fs.copyFileSync('dist/mcp/paths.js', module);
  const { REPO_ROOT, BUNDLED_ROOT, binScript } = await import(pathToFileURL(module));
  assert.equal(resolve(REPO_ROOT), root);
  assert.equal(BUNDLED_ROOT, join(root, 'packages/hud-mcp'));
  assert.equal(binScript('hud-watch'), join(root, bin, 'hud-watch.mjs'));
});
