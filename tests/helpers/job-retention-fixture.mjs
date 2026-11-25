import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeFixtureFile } from './thin-mcp-files.mjs';
import { cleanupFixture, stopChild } from './process-cleanup.mjs';
import { reapStubOptions } from './reap-stub.mjs';
import { until as waitUntil } from './until.mjs';

export const hour = 3600000;
const watcher = resolve('packages/hud-mcp/bin/hud-watch.mjs');
export function fixture(t, degradedMs) {
  const root = fs.mkdtempSync(join(tmpdir(), 'job-retention-'));
  const home = join(root, 'hud'), bin = join(root, 'bin'), jobs = join(home, 'jobs');
  const children = [];
  cleanupFixture(t, { root, hudHome: home }, async () => {
    let firstError;
    const killMs = t.signal?.aborted ? 200 : 1000;
    for (const { child, exited, stderr } of children) {
      try {
        const { forced } = await stopChild(child, exited, { killMs });
        if (!forced && !t.signal?.aborted) assert.equal(stderr(), '');
      } catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
  });
  const pi = join(root, 'pi'), defaultPi = join(root, 'home', '.pi', 'agent');
  fs.mkdirSync(jobs, { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(join(root, 'home'));
  fs.writeFileSync(join(bin, 'hud-reap'), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.HUD_HOME + '/reaps', process.argv[2] + '\\n');
`, { mode: 0o700 });
  let next = 0;
  function job(status, receipt = {}, tab = false, name = `j${(++next).toString(16).padStart(16, '0')}`) {
    const dir = join(jobs, name);
    fs.mkdirSync(dir);
    writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ job: name, dispatch_exit_code: 0, ...receipt }));
    if (status) writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify(status.pid ? { version: 1, slot: 'primary', task_dir: dir, ...status } : status));
    if (tab) writeFixtureFile(join(dir, 'SESSION.txt'), 'TAB=synthetic-tab\n');
    writeFixtureFile(join(dir, 'report.md'), 'Synthetic report.');
    return dir;
  }
  function start(probe = '', agentDir = pi) {
    const preload = probe ? ['--import', 'data:text/javascript,' + encodeURIComponent(probe)] : [];
    const env = { ...process.env, HOME: join(root, 'home'), HUD_HOME: home, PI_CODING_AGENT_DIR: agentDir,
      HERDR_SOCKET_PATH: join(root, 'absent.sock'), PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: reapStubOptions(bin), HUD_WATCH_CLI_CHECK_MS: '1000' };
    if (degradedMs === undefined) delete env.HUD_WATCH_DEGRADED_MS;
    else env.HUD_WATCH_DEGRADED_MS = String(degradedMs);
    const child = spawn(process.execPath, [...preload, watcher], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    children.push({ child, exited, stderr: () => stderr });
    return { child, exited, stderr: () => stderr };
  }
  return { home, jobs, pi, defaultPi, job, start, log: () => fs.readFileSync(join(home, 'watch.log'), 'utf8') };
}
export function realSession(dir, layout = 'sessions', header = { type: 'session', cwd: '/synthetic/work.space/repo' }) {
  const sessions = join(dir, layout);
  fs.mkdirSync(sessions, { recursive: true });
  if (layout.startsWith('.dispatch/')) writeFixtureFile(join(dir, '.dispatch', 'current.json'), '{}\n');
  const source = join(sessions, 'synthetic-session.jsonl');
  const bytes = Buffer.from(JSON.stringify(header) + '\r\n{"type":"message","text":"合成 session"}\n');
  writeFixtureFile(source, bytes);
  return { source, bytes };
}
export const expired = () => ({ state: 'closed', ended_at: new Date(Date.now() - 25 * hour).toISOString() });
export const destination = (pi) => join(pi, 'sessions', '--synthetic-work.space-repo--', 'synthetic-session.jsonl');

export const until = (check, signalOrLimit) => waitUntil(check, signalOrLimit, 'watcher condition did not settle');
