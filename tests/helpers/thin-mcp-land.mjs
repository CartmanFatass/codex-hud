import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { cleanupFixture } from './process-cleanup.mjs';
import { writeFixtureFile } from './thin-mcp-files.mjs';
import { procStat } from '../../dist/utils/proc.js';
import { fakeCliWithChild, fixture, until } from './thin-mcp-harness.mjs';

export const job = 'j0000000000000123';
export const jobDir = (f, id = job) => join(f.home, 'jobs', id);
export function bindSourceTab(t, f) {
  const worker = fakeCliWithChild(t, f);
  writeFixtureFile(join(jobDir(f), 'SESSION.txt'), `TAB=w4E:t1\nLEFT=w4E:p1\nPRIMARY=source-agent\n` +
    `DIRECT_EXEC=1\nLAUNCH_ID=source-launch\nTERMINAL_ID=source-terminal\nPID=${worker.pid}\n` +
    `PID_START=${procStat(worker.pid).start}\nHERDR_SOCKET_PATH=${f.env.HERDR_SOCKET_PATH}\n`);
  return worker;
}
export function assertLandingRecord(f, ticket, replayBase, landed) {
  const body = f.git(f.main, 'show', `base:${ticket}`);
  const record = body.match(/^- Landed in this commit \(replay base ([0-9a-f]+)\); gate 1\/1 passed\.$/m);
  assert.ok(record, body);
  assert.equal(record[1], replayBase);
  assert.equal(f.git(f.main, 'log', '--first-parent', '--format=%H', '-S', record[0], `${record[1]}..base`, '--', ticket), landed);
}
export function settle(f, id, text) {
  writeFixtureFile(join(jobDir(f, id), 'report.md'), text);
  writeFixtureFile(join(jobDir(f, id), 'STATUS.json'), JSON.stringify({ state: 'closed', settled_at: new Date().toISOString() }));
}
export async function repair(f, flow, index) {
  await until(() => {
    const state = f.flowState(flow);
    assert.notEqual(state.state, 'failed', JSON.stringify(state));
    return state.repairs?.[index]?.outcome === 'waiting for worker';
  }, 20000);
  return f.flowState(flow).repairs[index].job;
}
export async function checkout(t, gate, { after = ['test "$WRAPPED" = yes && pwd > after-ran'], timeout_s, mcpEntry, probe, crossProject = false } = {}) {
  const f = await fixture(t, { mcpEntry, probe });
  const home = f.env.HUD_HOME, main = crossProject ? join(f.root, 'project') : f.root;
  const root = join(`${main}-wt`, 'sample-000123'), branch = 'wt/sample-000123';
  if (crossProject) fs.mkdirSync(main);
  cleanupFixture(t, { root: `${main}-wt` });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(main, 'init', '-qb', 'base');
  git(main, 'config', 'user.name', 'Synthetic'); git(main, 'config', 'user.email', 'sample@example.invalid');
  fs.mkdirSync(join(main, '.hud'));
  fs.writeFileSync(join(main, '.hud/project.json'), JSON.stringify({ worktree: { disposable: ['dist/**'] },
    land: { base: 'base', gate, after, push: true, wrapper: 'wrap', timeout_s } }));
  fs.writeFileSync(join(main, 'wrap'), '#!/bin/sh\nunset NODE_TEST_CONTEXT\nexport WRAPPED=yes\nexec "$@"\n', { mode: 0o700 });
  fs.writeFileSync(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: main }] }));
  fs.writeFileSync(join(main, '.gitignore'), 'dist/\n');
  fs.writeFileSync(join(main, 'tracked'), 'start\n');
  git(main, 'add', '.gitignore', '.hud', 'tracked', 'wrap'); git(main, 'commit', '-qm', 'start');
  const base_head = git(main, 'rev-parse', 'HEAD');
  const remote = join(main, 'remote.git');
  git(main, 'init', '--bare', '-q', remote); git(main, 'remote', 'add', 'origin', remote); git(main, 'push', '-q', 'origin', 'base');
  git(main, 'worktree', 'add', '-qb', branch, root, base_head);
  for (const text of ['first', 'second']) { fs.appendFileSync(join(root, 'tracked'), `${text}\n`); git(root, 'commit', '-qam', text); }
  fs.mkdirSync(join(root, 'dist')); fs.writeFileSync(join(root, 'dist/output'), 'ignored build output');
  const dir = join(home, 'jobs', job); fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job, cwd: root, project_root: main, role: 'imp', herdr_pane: f.env.HERDR_PANE_ID,
    created_at: now, dispatch_exit_code: 0, worktree: { main_root: main, root, base_head, branch } }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed', ended_at: now }));
  const flowState = flow => JSON.parse(fs.readFileSync(join(home, 'flows', `${flow}.json`)));
  return { ...f, home, main, git, branch, worktree: root, remote, base_head, flowState };
}
