// Run from any directory after `npm run build`. Exit 1 means bugs reproduced.
// All fixtures are synthetic and confined to a temporary directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { createParseQueue } from '../../dist/utils/parse-queue.js';
import { SessionFinder } from '../../dist/collectors/session-finder.js';
import { FileWatcher, createSessionWatcher, createShellSnapshotWatcher } from '../../dist/collectors/file-watcher.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-review-'));
const watchers = [];
let bugs = 0;
function check(name, actual, expected) {
  try { assert.deepEqual(actual, expected); console.log(`OK: ${name}`); }
  catch { bugs++; console.log(`BUG: ${name}\n  expected=${JSON.stringify(expected)}\n  actual=${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = '2026-09-21T12:00:00.000Z';
const meta = id => JSON.stringify({ timestamp: stamp, type: 'session_meta', payload: { id, cwd: dir, timestamp: stamp } }) + '\n';
const call = id => JSON.stringify({ timestamp: stamp, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: '{}' } }) + '\n';

try {
  const partial = path.join(dir, 'partial.jsonl');
  fs.writeFileSync(partial, meta('A'));
  const parser = new RolloutParser(); parser.setRolloutPath(partial); await parser.parse();
  const record = call('split');
  fs.appendFileSync(partial, record.slice(0, 60)); await parser.parse();
  fs.appendFileSync(partial, record.slice(60));
  check('partial JSONL append loses an event', (await parser.parse()).toolActivity.totalCalls, 1);

  const a = path.join(dir, 'a.jsonl'), b = path.join(dir, 'b.jsonl');
  fs.writeFileSync(a, meta('A') + call('old'));
  fs.writeFileSync(b, meta('B') + call('new'));
  const race = new RolloutParser(); race.setRolloutPath(a);
  const pending = race.parse(); race.setRolloutPath(b); await pending;
  check('in-flight session switch restores old cache', (await race.parse()).session?.id, 'B');

  const replacement = new RolloutParser(); replacement.setRolloutPath(a); await replacement.parse();
  fs.writeFileSync(path.join(dir, 'replacement'), meta('B') + call('new'));
  fs.renameSync(path.join(dir, 'replacement'), a);
  check('equal-size rename-over keeps old session', (await replacement.parse()).session?.id, 'B');

  let invocations = 0;
  const queue = createParseQueue(async () => {
    if (++invocations === 1) throw new Error('synthetic transient read failure');
    return 'recovered';
  });
  await queue().catch(() => {});
  check('parse queue cannot recover from rejection', await queue().catch(() => 'rejected'), 'recovered');

  // Fault injection removes the path at the read boundary for either reader.
  // Use a child so an uncaught asynchronous exception cannot stop this review.
  const removed = path.join(dir, 'removed.jsonl'); fs.writeFileSync(removed, '{}\n');
  const parserUrl = new URL('../../dist/collectors/rollout.js', import.meta.url).href;
  const childCode = `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {parseRolloutFile} from ${JSON.stringify(parserUrl)};
    const original = fs.createReadStream;
    fs.createReadStream = function(p, o) { fs.unlinkSync(p); return original(p, o); };
    const originalOpen = fs.promises.open;
    fs.promises.open = async function(p, ...args) {
      fs.unlinkSync(p);
      return originalOpen.call(this, p, ...args);
    };
    syncBuiltinESMExports();
    try { await parseRolloutFile(${JSON.stringify(removed)}); }
    catch { /* A rejected read is recoverable by the caller. */ }
    if (fs.existsSync(${JSON.stringify(removed)})) process.exitCode = 2;
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], { encoding: 'utf8', timeout: 5000 });
  if (child.error) throw child.error;
  check('deleted rollout throws outside Promise error handling', child.status, 0);
  if (child.status) console.log(child.stderr.split('\n').find(line => line.includes('ENOENT')) ?? child.stderr);

  process.env.CODEX_HOME = dir; delete process.env.CODEX_SESSIONS_PATH;
  const now = new Date();
  const date = [String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')];
  const day = path.join(dir, 'sessions', ...date), snapshots = path.join(dir, 'shell_snapshots');
  fs.mkdirSync(day, { recursive: true }); fs.mkdirSync(snapshots);
  const sessionEvents = [], shellEvents = [], controlEvents = [];
  const sessionWatcher = createSessionWatcher(), shellWatcher = createShellSnapshotWatcher();
  const control = new FileWatcher([day, snapshots], { usePolling: true });
  for (const [watcher, events] of [[sessionWatcher, sessionEvents], [shellWatcher, shellEvents], [control, controlEvents]]) {
    watchers.push(watcher); watcher.onChange((...event) => events.push(event)); watcher.start();
    // Wait for chokidar readiness, accessing its runtime field only in this probe.
    await new Promise(resolve => watcher.watcher.once('ready', resolve));
  }
  fs.writeFileSync(path.join(day, 'rollout-probe.jsonl'), '{}\n');
  fs.writeFileSync(path.join(snapshots, 'probe.sh'), '# probe\n');
  for (let i = 0; i < 60 && controlEvents.length < 2; i++) await sleep(100);
  await sleep(1200);
  assert.ok(controlEvents.length >= 2, 'Directory watcher control must observe both files');
  check('glob session/snapshot watchers receive no events', [sessionEvents.length > 0, shellEvents.length > 0], [true, true]);
  await Promise.all(watchers.map(watcher => watcher.stop()));

  const old = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fresh = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const cwd = path.join(dir, 'new-project'); fs.mkdirSync(cwd);
  for (const [id, root] of [[old, '/old-project'], [fresh, cwd]]) {
    fs.writeFileSync(path.join(day, `rollout-${date.join('-')}T12-00-00-${id}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source: 'cli' } }) + '\n');
  }
  fs.writeFileSync(path.join(snapshots, `${old}.1.sh`), "export TMUX_PANE='%70'\n");
  process.env.CODEX_HUD_MAIN_PANE = '%70';
  const finder = new SessionFinder(cwd, undefined, new Date());
  check('reused pane ID selects a stale snapshot from another project', finder.check()?.sessionId, fresh);
} finally {
  await Promise.all(watchers.map(watcher => watcher.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${bugs} reproducible bugs`);
process.exitCode = bugs ? 1 : 0;
