import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { readThinJobs, runningVerb } from '../../dist/collectors/thin-jobs.js';
import { expNativePath } from '../../dist/collectors/exp-native.js';
import { readExpData } from '../../dist/collectors/exp-store.js';
import { defaultExpConfig } from '../../dist/exp-config.js';
import { cliKinds } from '../../dist/roles/cli-kinds.js';
import { watchCommand } from '../../dist/cli/watch.js';
import { answerJobQuestion } from '../../dist/collectors/panel-actions.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { renderWorkCard, workStateInk } from '../../dist/render/work-card.js';
import { workInspectorRows } from '../../dist/render/work-inspector.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { stripAnsi, theme, visualLength } from '../../dist/render/colors.js';
import { PiRoleClient, PI_ROLE_TOOLS } from '../../dist/harness/pi/role-client.js';
import { procStat, reportSignature, turnToken } from '../../dist/mcp/cli-judge.js';
import { harnessDefaults, markExhausted, placeKey } from '../../dist/roles/roster.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { git, initRepo } from '../fixtures/managed-worktree.mjs';
test('CLI state trust defaults, owner overrides, roster facts and dispatch snapshots agree', async (t) => {
  const f = await fixture(t);
  const config = join(f.env.HUD_HOME, 'harnesses.json');
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  for (const agent of ['agy', 'claude', 'codex', 'grok']) {
    fs.writeFileSync(join(f.env.HUD_HOME, 'roles', `${agent}-check.json`), JSON.stringify({
      role: `${agent}-check`, instructions: 'implementer', can_continue: true,
      run: [{ harness: 'cli', agent }],
    }));
  }
  // The owner's existing model-only file still inherits the shipped trust levels.
  fs.writeFileSync(config, JSON.stringify({ agy: { model: 'synthetic/override' } }));
  const bundled = resolve('packages/hud-mcp');
  const defaults = harnessDefaults(f.env.HUD_HOME, bundled);
  assert.equal(defaults.agy.model, 'synthetic/override');
  let roster = (await f.call('hud_roster', { detail: true })).roles;
  for (const agent of ['agy', 'claude', 'codex', 'grok']) {
    const expected = agent === 'agy' ? 'advisory' : 'turn';
    assert.equal(defaults[agent].state_trust, expected);
    assert.equal(roster.find((r) => r.role === `${agent}-check`).state_trust, expected);
  }
  fs.writeFileSync(config, JSON.stringify({ agy: { model: 'synthetic/override', state_trust: 'turn' }, grok: { state_trust: 'advisory' } }));
  roster = (await f.call('hud_roster', { detail: true })).roles;
  assert.equal(roster.find((r) => r.role === 'agy-check').state_trust, 'turn');
  assert.equal(roster.find((r) => r.role === 'grok-check').state_trust, 'advisory');
  // Dispatch through the normal MCP path, rejecting the fake launch before any worker is started.
  fs.writeFileSync(join(f.env.HOME, 'fail-start'), '');
  const agy = await f.call('hud_create', { role: 'agy-check', request_key: 'trust-agy', task: 'Synthetic task.' });
  const grok = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'trust-grok', task: 'Synthetic task.' });
  const record = (job) => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  assert.equal(record(agy).cli.state_trust, 'turn');
  assert.equal(record(grok).cli.state_trust, 'advisory');
  fs.writeFileSync(config, JSON.stringify({ agy: { state_trust: 'advisory' }, grok: { state_trust: 'turn' } }));
  assert.equal(record(agy).cli.state_trust, 'turn');
  assert.equal(record(grok).cli.state_trust, 'advisory');
});

const workerFor = (f, id) =>
  readThinJobs(f.env.HUD_HOME, { project: null, pane: 'w4E:p1' })
    .flatMap((lane) => lane.workers)
    .find((worker) => worker.id === 'thin-job:' + id);
const cardText = (worker) =>
  renderWorkCard(projectWorkCard(worker, Date.now()), { ...initialMonitorState(), mainTab: 'home' }, 56)
    .map(stripAnsi)
    .join('\n');

const entry = resolve('packages/hud-mcp/bin/hud-mcp.mjs');
const withoutHint = ({ hint, ...result }) => result;
const withoutCallerLookups = (commands) => commands.filter(({ command, args }) =>
  !(command === 'herdr' && args[0] === 'pane' && args[1] === 'get' && args[2] === 'w4E:p1'));
async function fixture(t, inHerdr = true, probe = '', watcherTickMs, worker = false) {
  const root = fs.mkdtempSync(join(tmpdir(), 'thin-mcp-'));
  const bin = join(root, 'bin');
  fs.mkdirSync(bin);
  const log = join(root, 'commands.jsonl');
  const fake = `#!${process.execPath}
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
const command = basename(process.argv[1]), args = process.argv.slice(2);
if (command === 'pi') {
  const caps = join(process.env.HOME, 'pi-model-caps.json');
  if (!fs.existsSync(caps)) process.exit(1);
  const model = JSON.parse(fs.readFileSync(caps, 'utf8'))[args[args.indexOf('--model') + 1]];
  if (!model) process.exit(1);
  process.stdin.once('data', () => console.log(JSON.stringify({ id: 'hud-thinking', data: { model } })));
} else fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command, args }) + '\\n');
function waitToReply() {
  const end = Date.now() + 5000;
  while (Date.now() < end && !fs.existsSync(join(process.env.HOME, 'release-prompt-result'))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
if (command === 'pi-dispatch') {
  process.exit(99); // The MCP must never use this legacy launcher.
} else if (command === 'pi-role') {
  console.log(JSON.stringify(args.slice(2)));
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'start') {
  if (args[args.indexOf('--kind') + 1] === 'grok' && fs.existsSync(join(process.env.HOME, 'hold-grok-start'))) {
    waitToReply();
    console.error('synthetic delayed start failed');
    process.exit(1);
  }
  if (fs.existsSync(join(process.env.HOME, 'start-not-ready'))) {
    console.log(JSON.stringify({ error: { code: 'agent_not_ready', message: 'agent synthetic is blocked during startup and is not ready for prompts' } }));
    process.exit(1);
  }
  const kind = args[args.indexOf('--kind') + 1];
  const failure = ['fail-start-' + kind, 'fail-start'].map((name) => join(process.env.HOME, name)).find((file) => fs.existsSync(file));
  if (failure) { console.error(fs.readFileSync(failure, 'utf8') || 'synthetic start failed'); process.exit(1); }
  const at = args.indexOf('--task-dir');
  if (at >= 0) {
    const dir = args[at + 1];
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', exit_reason: null }));
    if (!fs.existsSync(join(process.env.HOME, 'defer-pi-report')))
      fs.writeFileSync(join(dir, 'report.md'), 'Synthetic implementation report.');
  }
  if (['cli-exit', 'cli-unknown', 'cli-gone', 'grace-quiet-gone', 'blocked-quiet-gone', 'exit-after-done'].some((name) => fs.existsSync(join(process.env.HOME, name)))) {
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    fs.writeFileSync(join(process.env.HOME, 'fake-agent-pid'), String(sleeper.pid));
  }
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'read') {
  const paneFile = join(process.env.HOME, 'pane-read');
  const dialog = join(process.env.HOME, 'trust-dialog');
  const text = fs.existsSync(paneFile)
    ? fs.readFileSync(paneFile, 'utf8')
    : fs.existsSync(dialog)
      ? (fs.readFileSync(dialog, 'utf8').trim() || 'Do you trust the contents of this directory?') + '\\n'
      : 'synthetic grok ready\\n';
  console.log(JSON.stringify({ result: { type: 'pane_read', read: { text, pane_id: args[2], workspace_id: 'w4E', tab_id: 'w4E:t2', source: 'recent', format: 'text', revision: 1, truncated: false } } }));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'process-info') {
  if (fs.existsSync(join(process.env.HOME, 'no-pid'))) {
    console.log(JSON.stringify({ result: { type: 'pane_process_info', process_info: { pane_id: args[args.indexOf('--pane') + 1], shell_pid: 1, foreground_processes: [] } } }));
    process.exit(0);
  }
  const pidFile = join(process.env.HOME, 'cli-pid');
  const fakePidFile = join(process.env.HOME, 'fake-agent-pid');
  const line = fs.readFileSync('/proc/self/status', 'utf8').split('\\n').find((row) => row.startsWith('PPid:'));
  const ppid = fs.existsSync(pidFile)
    ? Number(fs.readFileSync(pidFile, 'utf8').trim())
    : fs.existsSync(fakePidFile)
      ? Number(fs.readFileSync(fakePidFile, 'utf8').trim())
      : Number(line.split(':')[1]);
  console.log(JSON.stringify({ result: { type: 'pane_process_info', process_info: { pane_id: args[args.indexOf('--pane') + 1], shell_pid: 1, foreground_processes: [{ pid: ppid, name: 'grok' }] } } }));
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'get') {
  const goneId = args[2].replace(/-primary$/, '');
  if (fs.existsSync(join(process.env.HOME, 'herdr-errors')) || fs.existsSync(join(process.env.HOME, 'late-session-gone')) || fs.existsSync(join(process.env.HUD_HOME, 'jobs', goneId, 'agent-gone')) || ['cli-gone', 'cli-exit', 'cli-unknown'].some((name) => fs.existsSync(join(process.env.HOME, name)))) {
    console.error('agent_not_found');
    process.exit(1);
  }
  let session = { kind: 'id', value: 'synthetic-grok-session', source: 'synthetic', agent: 'grok' };
  const late = join(process.env.HOME, 'late-session');
  if (fs.existsSync(late)) {
    const n = Number(fs.readFileSync(late, 'utf8') || '0') + 1;
    fs.writeFileSync(late, String(n));
    if (n === 1) session = null;
  }
  console.log(JSON.stringify({ result: { type: 'agent_info', agent: { name: args[2], agent_status: 'working', agent_session: session } } }));
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'wait') {
  const until = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--until') until.push(args[i + 1]);
  const id = args[2].replace(/-primary$/, '');
  const dir = join(process.env.HUD_HOME, 'jobs', id);
  const home = process.env.HOME;
  const matched = (agent_status) => console.log(JSON.stringify({ result: { type: 'wait_matched', event: { event: 'pane_agent_status_changed', data: { agent_status, pane_id: 'w4E:p2', workspace_id: 'w4E' } } } }));
  const killFakeAgent = () => {
    const fakePidFile = join(home, 'fake-agent-pid');
    if (fs.existsSync(fakePidFile)) {
      const fpid = Number(fs.readFileSync(fakePidFile, 'utf8').trim());
      if (fpid > 0) {
        try { process.kill(fpid, 'SIGKILL'); } catch {}
        const end = Date.now() + 200;
        while (Date.now() < end) {
          try {
            const st = fs.readFileSync('/proc/' + fpid + '/stat', 'utf8');
            if (st.slice(st.lastIndexOf(')') + 1).trim().startsWith('Z ')) break;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          } catch {
            break;
          }
        }
      }
    }
  };
  if (fs.existsSync(join(home, 'herdr-errors'))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    console.error('herdr_error');
    process.exit(1);
  }
  const left = () => fs.existsSync(join(dir, 'agent-gone')) || fs.existsSync(join(dir, 'STATUS.json.stop-requested')) || fs.existsSync(join(dir, 'STATUS.json.close-requested'));
  const poll = (ms, check) => {
    const end = Date.now() + ms;
    let hit = null;
    while (Date.now() < end && !hit) {
      hit = check();
      if (!hit) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return hit;
  };
  const cap = Math.min(Number(args[args.indexOf('--timeout') + 1]) || 8000, 12000);
  if (fs.existsSync(join(home, 'cli-blocked'))) {
    const released = () => fs.existsSync(join(home, 'release-blocked'));
    if (until.includes('blocked') && !released()) { matched('blocked'); process.exit(0); }
    if (until.includes('working') && until.includes('done') && !until.includes('blocked')) {
      const blockedQuiet = join(home, 'blocked-quiet');
      if (fs.existsSync(blockedQuiet) && (until.includes('idle') || until.includes('unknown')) && !fs.existsSync(join(home, 'blocked-quiet-seen'))) {
        fs.writeFileSync(join(home, 'blocked-quiet-seen'), '');
        if (fs.existsSync(join(home, 'blocked-quiet-gone'))) { fs.writeFileSync(join(dir, 'agent-gone'), ''); killFakeAgent(); }
        matched(fs.readFileSync(blockedQuiet, 'utf8').trim() || 'idle');
        process.exit(0);
      }
      const hit = poll(cap, () => (released() ? 'working' : left() ? 'idle' : null));
      if (hit === 'working') { matched('working'); process.exit(0); }
      if (hit === 'idle') { matched('idle'); process.exit(0); }
      console.error('timeout');
      process.exit(1);
    }
  }
  if (until.includes('done') && until.includes('idle') && !until.includes('blocked') && !until.includes('working')) {
    if (fs.existsSync(join(home, 'phantom-working')) && !fs.existsSync(join(home, 'phantom-settled'))) {
      fs.writeFileSync(join(home, 'phantom-settled'), '');
      matched('done');
      process.exit(0);
    }
    matched('idle');
    process.exit(0);
  }
  if (until.includes('working') && until.includes('blocked') && !until.includes('done')) {
    if (fs.existsSync(join(home, 'exit-after-done'))) { fs.writeFileSync(join(dir, 'agent-gone'), ''); killFakeAgent(); }
    if (fs.existsSync(join(home, 'cli-exit'))) { killFakeAgent(); matched('idle'); process.exit(0); }
    if (fs.existsSync(join(home, 'cli-unknown'))) { killFakeAgent(); matched('unknown'); process.exit(0); }
    if (fs.existsSync(join(home, 'cli-gone'))) { killFakeAgent(); console.error('agent_not_found'); process.exit(1); }
    const hit = poll(cap, () => (left() ? 'idle' : fs.existsSync(join(home, 'wake-turn')) ? 'working' : null));
    if (hit === 'working') { matched('working'); process.exit(0); }
    if (hit === 'idle') { matched('idle'); process.exit(0); }
    console.error('timeout');
    process.exit(1);
  }
  if (args.includes('--timeout') && until.includes('working') && !until.includes('done') && !until.includes('blocked')) {
    const statusFile = join(dir, 'STATUS.json');
    if (fs.existsSync(statusFile)) fs.writeFileSync(join(home, 'seen-grace.json'), fs.readFileSync(statusFile));
    const graceQuiet = join(home, 'grace-quiet');
    if (fs.existsSync(graceQuiet) && !fs.existsSync(join(home, 'grace-quiet-seen'))) {
      fs.writeFileSync(join(home, 'grace-quiet-seen'), '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      if (fs.existsSync(join(home, 'grace-quiet-gone'))) { fs.writeFileSync(join(dir, 'agent-gone'), ''); killFakeAgent(); }
      matched(fs.readFileSync(graceQuiet, 'utf8').trim() || 'idle');
      process.exit(0);
    }
    if (!fs.existsSync(join(home, 'hold-grace'))) {
      if (fs.existsSync(join(home, 'report-while-working')) && !fs.existsSync(join(home, 'release-done'))) {
        matched('working');
        process.exit(0);
      }
      console.error('timeout');
      process.exit(1);
    }
    const log = process.env.FAKE_LOG;
    const mark = fs.existsSync(log) ? fs.statSync(log).size : 0;
    const hit = poll(cap, () => {
      if (left()) return 'idle';
      const extra = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(mark) : '';
      return extra.includes('"prompt"') && extra.includes(id) && !extra.includes('/quit') ? 'working' : null;
    });
    if (hit === 'working') { matched('working'); process.exit(0); }
    if (hit === 'idle') { matched('idle'); process.exit(0); }
    console.error('timeout');
    process.exit(1);
  }
  if (until.includes('done') && until.includes('blocked')) {
    const seenPrompt = fs.existsSync(process.env.FAKE_LOG) && fs.readFileSync(process.env.FAKE_LOG, 'utf8').includes('brief.md');
    if (fs.existsSync(join(home, 'startup-done')) && !seenPrompt) { matched('done'); process.exit(0); }
    if (fs.existsSync(join(home, 'phantom-working')) && !fs.existsSync(join(home, 'phantom-settled'))) { matched('done'); process.exit(0); }
    const quietHold = join(home, 'quiet-hold');
    if (fs.existsSync(quietHold) && (until.includes('idle') || until.includes('unknown'))) {
      matched(fs.readFileSync(quietHold, 'utf8').trim() || 'idle');
      process.exit(0);
    }
    if (fs.existsSync(join(home, 'cli-exit'))) { killFakeAgent(); matched('idle'); process.exit(0); }
    if (fs.existsSync(join(home, 'cli-unknown'))) { killFakeAgent(); matched('unknown'); process.exit(0); }
    if (fs.existsSync(join(home, 'cli-gone'))) { killFakeAgent(); console.error('agent_not_found'); process.exit(1); }
    if (fs.existsSync(join(home, 'report-while-working'))) {
      const stageFile = join(home, 'report-while-working-stage');
      const stage = fs.existsSync(stageFile) ? Number(fs.readFileSync(stageFile, 'utf8')) : 0;
      fs.writeFileSync(stageFile, String(stage + 1));
      if (stage === 0) {
        fs.writeFileSync(join(dir, 'report.md'), 'Synthetic mid-turn report.\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
        console.error('timeout');
        process.exit(1);
      }
      const hit = poll(cap, () => (left() ? 'idle' : fs.existsSync(join(home, 'release-done')) ? 'done' : null));
      if (hit === 'done') { matched('done'); process.exit(0); }
      if (hit === 'idle') { matched('idle'); process.exit(0); }
      console.error('timeout');
      process.exit(1);
    }
    if (fs.existsSync(join(home, 'hold-turn'))) {
      const hit = poll(cap, () => (left() ? 'idle' : fs.existsSync(join(home, 'release-turn')) ? 'done' : null));
      if (hit === 'idle') { matched('idle'); process.exit(0); }
      if (hit !== 'done') { console.error('timeout'); process.exit(1); }
    }
    if (!fs.existsSync(join(home, 'missing-report'))) {
      const countFile = join(home, 'done-count');
      const n = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1;
      fs.writeFileSync(countFile, String(n));
      const report = join(dir, 'report.md');
      if (n > 1 && !fs.existsSync(join(home, 'unchanged-report'))) fs.writeFileSync(report, 'Synthetic grok report two.' + String.fromCharCode(10));
      else if (!fs.existsSync(report)) fs.writeFileSync(report, 'Synthetic grok report.' + String.fromCharCode(10));
    }
    matched('done');
  } else if (until.includes('idle') || until.includes('unknown')) matched('idle');
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && args[3] === '/quit' && fs.existsSync(join(process.env.HOME, 'late-session'))) {
  fs.writeFileSync(join(process.env.HOME, 'late-session-gone'), '');
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && String(args[3]).startsWith('Write your report to ') && fs.existsSync(join(process.env.HOME, 'write-on-report-prompt'))) {
  const reportPath = String(args[3]).slice('Write your report to '.length).split(' now;')[0];
  fs.writeFileSync(reportPath, 'Synthetic report after prompt.\\n');
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && String(args[3]).startsWith('Write your report to ') && fs.existsSync(join(process.env.HOME, 'fail-report-prompt'))) {
  console.error('synthetic report prompt failed'); process.exit(1);
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && args[3] === '/quit' && fs.existsSync(join(process.env.HOME, 'reject-quit'))) {
  console.error('agent_not_ready before input'); process.exit(1);
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && fs.existsSync(join(process.env.HOME, 'fast-ambiguous-prompt'))) {
  const id = args[2].replace(/-primary$/, '');
  fs.writeFileSync(join(process.env.HUD_HOME, 'jobs', id, 'report.md'), 'Synthetic fast report after input.\\n');
  waitToReply();
  console.error('agent_prompt_stalled after submit'); process.exit(1);
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && fs.existsSync(join(process.env.HOME, 'stalled-prompt'))) {
  console.error('agent_prompt_stalled after submit'); process.exit(1);
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && fs.existsSync(join(process.env.HOME, 'rejected-prompt'))) {
  if (!args.includes('--wait')) waitToReply();
  console.error('agent_not_ready before input'); process.exit(1);
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt' && fs.existsSync(join(process.env.HOME, 'fail-prompt'))) {
  console.error('synthetic prompt timeout'); process.exit(1);
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'split') {
  if (fs.existsSync(join(process.env.HOME, 'fail-split'))) { console.error('synthetic split failed'); process.exit(1); }
  console.log(JSON.stringify({result: {pane: {pane_id: 'w4E:p3'}}}));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'list') {
  const file = join(process.env.HOME, 'pane-list.json');
  if (!fs.existsSync(file)) process.exit(1);
  console.log(fs.readFileSync(file, 'utf8'));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'get') {
  const agentFile = join(process.env.HOME, 'main-agent');
  const agent = fs.existsSync(agentFile) ? fs.readFileSync(agentFile, 'utf8') : 'claude';
  console.log(JSON.stringify({result: {pane: {workspace_id: 'w4E', agent}}}));
} else if (command === 'herdr' && args[0] === 'tab' && args[1] === 'create') {
  console.log(JSON.stringify({result: {tab: {tab_id: 'w4E:t2'}, root_pane: {pane_id: 'w4E:p2'}}}));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'run') {
  process.exit(spawnSync('/bin/sh', ['-c', args[3]], {stdio: 'inherit'}).status);
} else if (command === 'jev-ask' && args[0] === 'key') {
  console.log(JSON.stringify({key: 'synthetic-key'}));
} else if (command === 'jev-ask' && args[0] === 'wait') {
  fs.writeFileSync(args[args.indexOf('--answer-file') + 1], 'Synthetic Jev answer.');
} else if (command === 'jev-aistudio') {
  fs.writeFileSync(args[args.indexOf('--out') + 1], 'Synthetic Argon answer.');
} else if (command === 'jev-flow') {
  if (args[args.indexOf('--kind') + 1] === 'video' && !args.includes('--confirm-credits')) process.exit(17);
  fs.writeFileSync(join(args[args.indexOf('--out-dir') + 1], 'synthetic-media.mp4'), 'synthetic media');
} else if (command === 'pi-role-reap') {
  const dir = args[0], fail = join(dir, 'fail-reap-once');
  if (fs.existsSync(fail)) { fs.unlinkSync(fail); process.exit(1); }
  if (fs.existsSync(join(dir, 'reap-worker'))) {
    try { process.kill(Number(fs.readFileSync(join(process.env.HOME, 'cli-pid'))), 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  try {
    const status = JSON.parse(fs.readFileSync(join(dir, 'STATUS.json'), 'utf8'));
    if (status && !['closed', 'failed', 'stopped', 'idle_grace'].includes(status.state))
      fs.writeFileSync(join(dir, 'STATUS.json.stop-requested'), '');
    fs.writeFileSync(join(dir, 'agent-gone'), '');
  } catch {}
  console.log('Reaping synthetic job');
  console.log('Synthetic reap complete');
}
`;
  for (const command of ['pi', 'pi-role', 'pi-dispatch', 'pi-role-reap', 'herdr', 'jev-ask', 'jev-aistudio', 'jev-flow', 'grok', 'agy', 'claude', 'codex']) {
    fs.writeFileSync(join(bin, command), fake, { mode: 0o700 });
  }
  fs.mkdirSync(join(root, 'roles'));
  fs.writeFileSync(join(root, 'roles', 'implementer.md'), '---\nmodel: synthetic/default\nthinking: low\n---\n');
  // Accelerate deadlines, not observations: production still wakes from real socket/file events.
  const clock = join(root, 'clock.mjs');
  fs.writeFileSync(clock, `import * as fs from 'node:fs';
import { join } from 'node:path';
if (process.argv[1]?.endsWith('/hud-cli.mjs')) {
  const now = Date.now, timer = globalThis.setTimeout, anchor = Date.now();
  Date.now = () => anchor + (now() - anchor) * 20;
  globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 250 ? 15 : ms / 20, ...args);
  const opendir = fs.opendirSync;
  fs.default.opendirSync = (...args) => {
    if (/^\\/proc\\/\\d+\\/task$/.test(args[0])) fs.appendFileSync(join(process.env.HOME, 'proc-scans'), 'scan\\n');
    return opendir(...args);
  };
  const rename = fs.renameSync;
  fs.default.renameSync = (...args) => {
    if (args[1].endsWith('/STATUS.json')) fs.appendFileSync(join(process.env.HOME, 'status-writes'), args[1] + '\\n');
    return rename(...args);
  };
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
}
if (process.argv[1]?.endsWith('/hud-progress.mjs')) {
  const fault = join(process.env.HOME, 'progress-snapshot-enospc');
  const rename = fs.renameSync, open = fs.openSync;
  const enospc = () => Object.assign(new Error('synthetic ENOSPC in hud-progress'), { code: 'ENOSPC' });
  fs.default.renameSync = (from, to) => {
    if (to.endsWith('/worker-tree.json') && fs.existsSync(fault)) throw enospc();
    return rename(from, to);
  };
  fs.default.openSync = (file, ...args) => {
    if (typeof file === 'string' && file.includes('/worker-tree.json.') && fs.existsSync(fault) &&
        fs.readFileSync(fault, 'utf8') === 'open') throw enospc();
    return open(file, ...args);
  };
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
}
const isWatcher = process.argv[1]?.endsWith('/hud-watch.mjs');
if (isWatcher || process.argv[1]?.endsWith('/hud-cli.mjs')) {
  const flag = join(process.env.HOME, 'snapshot-enospc'), rename = fs.renameSync, kill = process.kill;
  fs.default.renameSync = (from, to) => {
    if (to.endsWith('/worker-tree.json') && fs.existsSync(flag))
      throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  if (isWatcher) process.kill = (pid, signal) => {
    if (signal && fs.existsSync(flag) && String(pid) === fs.readFileSync(flag, 'utf8')) return false;
    return kill(pid, signal);
  };
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
}`);
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${clock}`,
    HUD_MCP_SURFACE: 'roles',
    HUD_WATCH_FAILED_RETENTION_MS: '1000',
    ...(watcherTickMs ? { HUD_WATCH_CLI_CHECK_MS: String(watcherTickMs) } : {}),
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: log,
    HERDR_SOCKET_PATH: join(root, 'events.sock'),
  };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'MISTRAL_API_KEY']) {
    delete env[key];
  }
  for (const name of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) {
    env[name] = join(root, name.toLowerCase());
    fs.mkdirSync(env[name]);
  }
  env.HUD_SETTINGS_PATH = join(env.HUD_HOME, 'hud-settings.json');
  // The fake CLI can still show a trust prompt even when these local grants exist.
  const trusted = fs.realpathSync(root);
  const grokDir = join(env.HOME, '.grok');
  const agyDir = join(env.HOME, '.gemini', 'antigravity-cli');
  fs.mkdirSync(grokDir);
  fs.mkdirSync(agyDir, { recursive: true });
  fs.writeFileSync(join(grokDir, 'trusted_folders.toml'), `[folders.${JSON.stringify(trusted)}]\ntrusted = true\n`);
  fs.writeFileSync(join(agyDir, 'settings.json'), JSON.stringify({ trustedWorkspaces: [trusted] }));
  fs.writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ projects: { [trusted]: { hasTrustDialogAccepted: true } } }));
  if (inHerdr) env.HERDR_PANE_ID = 'w4E:p1';
  else delete env.HERDR_PANE_ID;
  if (worker) {
    env.HUD_JOB_DIR = join(env.HUD_HOME, 'jobs', 'j0000000000000001');
    fs.mkdirSync(env.HUD_JOB_DIR, { recursive: true });
  } else delete env.HUD_JOB_DIR;
  const preload = probe ? ['--import', 'data:text/javascript,' + encodeURIComponent(probe)] : [];
  const child = spawn(process.execPath, [...preload, entry], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  const rpc = rpcClient(child);
  t.after(async () => {
    const panePid = join(env.HUD_HOME, 'watchers/w4E:p1.pid');
    try {
      const pid = Number(fs.readFileSync(panePid));
      if (pid > 1 && pid !== process.pid) process.kill(pid, 'SIGTERM');
    } catch {}
    const jobsDir = join(env.HUD_HOME, 'jobs');
    if (fs.existsSync(jobsDir))
      for (const id of fs.readdirSync(jobsDir)) {
        const pidFile = join(jobsDir, id, 'supervisor.pid');
        if (!fs.existsSync(pidFile)) continue;
        try {
          process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
        } catch {}
      }
    child.stdin.end();
    await exited;
    const watchLog = join(env.HUD_HOME, 'watch.log');
    if (fs.existsSync(watchLog))
      for (const match of fs.readFileSync(watchLog, 'utf8').matchAll(/start pid=(\d+)/g)) {
        try {
          process.kill(Number(match[1]), 'SIGTERM');
        } catch {}
      }
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(stderr, '');
  });
  let cliSocket, piStatus = () => 'idle';
  const socketRequests = [];
  const subscribers = new Set();
  const has = (name) => fs.existsSync(join(env.HOME, name));
  const push = (client, state) => {
    client.state = state;
    client.socket.write(JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: 'w4E:p2', workspace_id: 'w4E', agent_status: state } }) + '\n');
  };
  async function startCliSocket() {
    if (cliSocket || fs.existsSync(env.HERDR_SOCKET_PATH)) return;
    cliSocket = createServer((socket) => {
      const client = { socket, id: null, state: null, reported: 0 };
      const lines = createInterface({ input: socket });
      lines.on('line', (line) => {
        const req = JSON.parse(line);
        socketRequests.push(req);
        const reply = (result) => socket.write(JSON.stringify({ id: req.id, result }) + '\n');
        if (req.method === 'events.subscribe') {
          client.supervisor = req.params.subscriptions.some((sub) => sub.type === 'pane.agent_status_changed');
          subscribers.add(client); reply({ type: 'subscribed' });
        }
        else if (req.method === 'agent.get') {
          const id = req.params.target.replace(/-primary$/, '');
          const jobFile = join(env.HUD_HOME, 'jobs', id, 'job.json');
          if (fs.existsSync(jobFile) && !JSON.parse(fs.readFileSync(jobFile)).cli) {
            const state = piStatus();
            if (state === 'agent_not_found') socket.write(JSON.stringify({ id: req.id, error: { code: state } }) + '\n');
            else reply({ agent: { agent_status: state } });
            return;
          }
          const sub = [...subscribers].reverse().find((item) => item.supervisor && !item.id) ?? [...subscribers].find((item) => item.supervisor && item.id === id);
          if (sub) sub.id = id;
          if (has('herdr-errors') || has('no-pid')) { socket.write(JSON.stringify({ id: req.id, error: { code: 'agent_not_found' } }) + '\n'); return; }
          reply({ agent: { agent_status: sub?.state ?? 'working', agent_session: has('late-session') && !has('exit-after-done') && !has('socket-got-session') ? null : { kind: 'id', value: 'synthetic-grok-session' } } });
          fs.writeFileSync(join(env.HOME, 'socket-got-session'), '');
        } else if (req.method === 'pane.read') {
          if (has('pane-read-timeout')) return;
          reply({ read: { text: has('pane-read') ? fs.readFileSync(join(env.HOME, 'pane-read'), 'utf8') : 'synthetic pane' } });
        } else if (req.method === 'pane.process_info') {
          const pidFile = ['cli-pid', 'fake-agent-pid'].map((file) => join(env.HOME, file)).find((file) => fs.existsSync(file));
          const id = [...subscribers].filter((item) => item.supervisor).at(-1)?.id;
          const supervisor = id && join(env.HUD_HOME, 'jobs', id, 'supervisor.pid');
          reply({ process_info: { shell_pid: 1, foreground_processes: has('no-pid') ? [] : [{ pid: pidFile ? Number(fs.readFileSync(pidFile)) : supervisor && fs.existsSync(supervisor) ? Number(fs.readFileSync(supervisor)) : child.pid }] } });
        }
      });
      socket.on('error', () => {});
      lines.on('error', () => {});
      socket.on('close', () => { subscribers.delete(client); lines.close(); });
    });
    await new Promise((done) => cliSocket.listen(env.HERDR_SOCKET_PATH, done));
    const simulation = setInterval(() => {
      for (const client of subscribers) {
        if (!client.id || has('manual-socket')) continue;
        const dir = join(env.HUD_HOME, 'jobs', client.id);
        if (!fs.existsSync(join(dir, 'turn.json'))) continue;
        if (has('herdr-errors')) { client.socket.destroy(); continue; }
        const turn = JSON.parse(fs.readFileSync(join(dir, 'turn.json')));
        const status = cliState(dir);
        if (status?.state === 'idle_grace') fs.writeFileSync(join(env.HOME, 'seen-grace.json'), JSON.stringify(status));
        let state = has('hold-turn') && !has('release-turn') ? 'working' : 'done';
        if (has('cli-blocked') && !has('release-blocked')) state = 'blocked';
        const report = join(dir, 'report.md');
        if (has('report-while-working')) {
          if (!fs.existsSync(report)) fs.writeFileSync(report, 'Synthetic mid-turn report.\n');
          fs.writeFileSync(join(env.HOME, 'report-while-working-stage'), '1');
          if (!has('release-done')) state = 'working';
        } else if (state === 'done' && !has('missing-report') && client.reported !== turn.seq) {
          if (turn.seq > 1 && !has('unchanged-report')) fs.writeFileSync(report, 'Synthetic grok report two.\n');
          else if (!fs.existsSync(report)) fs.writeFileSync(report, 'Synthetic grok report.\n');
          client.reported = turn.seq;
        }
        if (['cli-exit', 'cli-unknown', 'cli-gone', 'exit-after-done'].some(has) || (status?.state === 'idle_grace' && has('grace-quiet-gone')) || (has('cli-blocked') && has('blocked-quiet-gone'))) {
          if (['cli-exit', 'cli-unknown', 'cli-gone', 'exit-after-done'].some(has)) { try { fs.unlinkSync(report); } catch {} }
          const pidFile = join(env.HOME, 'fake-agent-pid');
          if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile)), 'SIGKILL'); } catch {} }
          push(client, 'unknown'); continue;
        }
        if (has('quiet-hold')) state = fs.readFileSync(join(env.HOME, 'quiet-hold'), 'utf8').trim();
        if (status?.state === 'idle_grace' && has('grace-quiet')) state = fs.readFileSync(join(env.HOME, 'grace-quiet'), 'utf8').trim();
        if (client.state !== state) push(client, state);
      }
    }, 20);
    t.after(() => { clearInterval(simulation); for (const client of subscribers) client.socket.destroy(); cliSocket.close(); });
  }
  async function call(name, args = {}) {
    if (name === 'hud_create') {
      const roleFile = join(env.HUD_HOME, 'roles', `${args.role}.json`);
      let role;
      try { role = JSON.parse(fs.readFileSync(roleFile)); } catch {}
      if (['grok', 'agy', 'claude', 'codex'].includes(args.on) || role?.harness === 'cli' || role?.run?.some((place) => place.harness === 'cli')) {
        if (args.role === 'imp' && !role) {
          fs.mkdirSync(join(env.HUD_HOME, 'roles'), { recursive: true });
          const imp = JSON.parse(fs.readFileSync(resolve('packages/hud-mcp/roles/imp.json')));
          fs.writeFileSync(roleFile, JSON.stringify({ ...imp, idle_grace_s: 40 }));
        }
        await startCliSocket();
      }
    }
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
    assert.equal(response.result.content.length, 1);
    assert.equal(response.result.content[0].type, 'text');
    return JSON.parse(response.result.content[0].text);
  }
  return {
    root,
    env,
    rpc,
    call,
    socketRequests,
    startCliSocket,
    piStatus: (get) => { piStatus = get; },
    push: (id, state) => { for (const client of subscribers) if (client.id === id) push(client, state); },
    // herdr's status changes but the push never arrives: only agent.get sees it.
    silent: (id, state) => { for (const client of subscribers) if (client.id === id) client.state = state; },
    drop: () => { for (const client of subscribers) client.socket.destroy(); },
    dropWorker: (id) => { for (const client of subscribers) if (client.id === id) client.socket.destroy(); },
    closeTab: () => { for (const client of subscribers) client.socket.write(JSON.stringify({ event: 'tab.closed', data: { tab_id: 'w4E:t2', workspace_id: 'w4E' } }) + '\n'); },
    commands: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
  };
}

function rpcClient(child) {
  let next = 0;
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line);
    const callback = pending.get(response.id);
    if (callback) {
      pending.delete(response.id);
      callback(response);
    }
  });
  return (method, params = {}) => new Promise((done) => {
    const id = ++next;
    pending.set(id, done);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function workerClient(t, f, dir, askTimeout = '30') {
  const child = spawn(process.execPath, [entry], {
    cwd: f.root, env: { ...f.env, HUD_JOB_DIR: dir, HUD_ASK_TIMEOUT: askTimeout }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.stdin.end();
    assert.deepEqual(await exited, [0, null]);
  });
  const rpc = rpcClient(child);
  const call = async (name, args = {}) => {
    const { result, error } = await rpc('tools/call', { name, arguments: args });
    assert.equal(error, undefined);
    return result;
  };
  return Object.assign(call, { rpc });
}
const resultValue = (result) => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};

async function until(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, 'condition did not settle');
    await new Promise((done) => setTimeout(done, 20));
  }
}

const tasksExtension = 'io.modelcontextprotocol/tasks';
function taskRpc(rpc) {
  return async (method, params = {}) => {
    const { result, error } = await rpc(method, { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { extensions: { [tasksExtension]: {} } },
    } });
    assert.equal(error, undefined, JSON.stringify(error));
    return result;
  };
}
const taskCall = (rpc, name, args) => rpc('tools/call', { name, arguments: args });
const taskJob = (f, task) => {
  assert.equal(task.resultType, 'task');
  assert.equal(task.status, 'working');
  const job = task.taskId.split(':')[0];
  assert.match(job, /^j[0-9a-f]{16}$/);
  return { job, task_dir: join(f.env.HUD_HOME, 'jobs', job) };
};

test('MCP tasks: discover, progress and report settlement without reading or closing', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  assert.deepEqual(await rpc('server/discover'), {
    resultType: 'complete', supportedVersions: ['2026-07-28'], ttlMs: 0, cacheScope: 'private',
    capabilities: { tools: {}, extensions: { [tasksExtension]: {} } },
  });
  const list = await rpc('tools/list');
  assert.equal(list.resultType, 'complete');
  assert.equal(list.ttlMs, 0);
  assert.equal(list.cacheScope, 'private');
  assert.equal(list.tools.some(({ name }) => name === 'hud_wait'), false);
  assert.deepEqual(list.tools.filter((tool) => tool.execution?.taskSupport === 'optional').map((tool) => tool.name).sort(),
    ['hud_create', 'hud_respond', 'hud_send']);
  const roster = resultValue(await taskCall(rpc, 'hud_roster'));
  assert.match(roster.hint, /task completions.*hud_read/);
  assert.equal(roster.watcher_alive, undefined);
  assert.equal(roster.changes, undefined);
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic task.' });
  const job = taskJob(f, task);
  assert.equal(task.pollIntervalMs, 5000);
  assert.equal(task.ttlMs, 3 * 60 * 60_000);
  assert.match(task.statusMessage, /task completions.*hud_read/);
  const get = () => rpc('tasks/get', { taskId: task.taskId });
  fs.writeFileSync(join(job.task_dir, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), text: 'Synthetic milestone.' }) + '\n');
  assert.match((await get()).statusMessage, /Synthetic milestone\./);
  await publishPiGrace(job);
  const done = await get();
  assert.equal(done.resultType, 'complete');
  assert.equal(done.status, 'completed');
  const [label, path, summary, launch] = done.result.content[0].text.split('\n');
  assert.equal(label, `${job.job} (imp) — idle_grace`);
  assert.equal(path, `Report: ${join(job.task_dir, 'report.md')}`);
  assert.equal(summary, 'Summary: Synthetic settled pi report.');
  assert.match(launch, /^Launch: used_place: pi/);
  assert.deepEqual(await rpc('tasks/cancel', { taskId: task.taskId }), done);
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).read_at, undefined);
  assert.equal(f.commands().some(({ command }) => command === 'pi-role-reap'), false);
  const report = resultValue(await taskCall(rpc, 'hud_read', { job: job.job }));
  assert.match(report.report, /Synthetic settled pi report/);
  assert.equal(report.changes, undefined);
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed', exit_reason: 'closed after report read' }));
  const repair = taskJob(f, await taskCall(rpc, 'hud_send', { job: job.job, text: 'Synthetic repair.' }));
  assert.notEqual(repair.job, job.job);
  assert.equal(JSON.parse(fs.readFileSync(join(repair.task_dir, 'job.json'))).repair_of, job.job);
});

test('MCP tasks: launch fall-through and effective effort are in the initial and final text', async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  fallbackRole(f, 'fallback-task');
  fs.writeFileSync(join(f.env.HOME, 'fail-start-grok'), 'Synthetic start failure');
  fs.writeFileSync(join(f.env.HOME, 'pi-model-caps.json'), JSON.stringify({
    'synthetic/second': { provider: 'synthetic', id: 'second', reasoning: false },
  }));
  const task = await taskCall(rpc, 'hud_create', { role: 'fallback-task', task: 'Synthetic fallback.', thinking: 'high' });
  const job = taskJob(f, task);
  const launch = /used_place: pi \(synthetic\/second\); thinking: off; attempts: cli\/grok \(synthetic-first\) \(Synthetic start failure\) → pi \(synthetic\/second\)/;
  assert.match(task.statusMessage, launch);
  await publishPiGrace(job);
  const done = await rpc('tasks/get', { taskId: task.taskId });
  assert.equal(done.status, 'completed');
  assert.match(done.result.content[0].text, launch);
});

test('MCP tasks: a question completes the task; an answer starts another task', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic question job.' });
  const job = taskJob(f, task);
  const worker = workerClient(t, f, job.task_dir, '0');
  assert.match((await worker('hud_ask', { question: 'Which synthetic option?', default: 'A', options: ['A', 'B'] })).content[0].text,
    /delivered by MCP task/);
  assert.equal(f.commands().some(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'w4E:p1'), false);
  const question = await rpc('tasks/get', { taskId: task.taskId });
  assert.equal(question.status, 'completed');
  assert.match(question.result.content[0].text, /Question q1: Which synthetic option\?/);
  const next = await taskCall(rpc, 'hud_respond', { job: job.job, request_id: 'q1', answer: 'B' });
  assert.equal(taskJob(f, next).job, job.job);
  assert.notEqual(next.taskId, task.taskId);
  assert.equal(fs.readFileSync(join(job.task_dir, 'qa/q1.answer.md'), 'utf8'), 'B');
  assert.deepEqual(await rpc('tasks/cancel', { taskId: task.taskId }), question);
  assert.equal((await rpc('tasks/get', { taskId: next.taskId })).status, 'working');
  await publishPiGrace(job);
  assert.equal((await rpc('tasks/get', { taskId: next.taskId })).status, 'completed');
});

test('MCP tasks: fan-out sends keep the create task through report settlement', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic fan-out job.' });
  const job = taskJob(f, task);
  const get = () => rpc('tasks/get', { taskId: task.taskId });

  const failPrompt = join(f.env.HOME, 'fail-prompt');
  fs.writeFileSync(failPrompt, '');
  const failed = await taskCall(rpc, 'hud_send', { jobs: [job.job], text: 'Synthetic refused fan-out.' });
  assert.deepEqual(resultValue(failed).skipped, [{ job: job.job, reason: 'send_failed' }]);
  assert.equal((await get()).status, 'working');
  fs.unlinkSync(failPrompt);

  const sent = await taskCall(rpc, 'hud_send', { jobs: [job.job], text: 'Synthetic queued fan-out.' });
  assert.equal(sent.resultType, 'complete');
  assert.deepEqual(resultValue(sent).sent, [job.job]);
  assert.equal((await get()).status, 'working');

  await publishPiGrace(job);
  const done = await get();
  assert.equal(done.status, 'completed');
  assert.ok(done.result.content[0].text.includes(`Report: ${join(job.task_dir, 'report.md')}`));
  assert.match(done.result.content[0].text, /Summary: Synthetic settled pi report\./);
});

test('MCP tasks: cancel fences sends and reaps once even with duplicate requests', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic cancel job.' });
  const job = taskJob(f, task);
  const fanOut = await taskCall(rpc, 'hud_send', { jobs: [job.job], text: 'Synthetic fan-out.' });
  assert.equal(fanOut.resultType, 'complete');
  assert.deepEqual(resultValue(fanOut).sent, [job.job]);
  const send = await taskCall(rpc, 'hud_send', { job: job.job, text: 'Synthetic new turn.' });
  assert.equal(taskJob(f, send).job, job.job);
  assert.equal((await rpc('tasks/cancel', { taskId: task.taskId })).status, 'failed');
  const reaps = () => f.commands().filter(({ command }) => command === 'pi-role-reap');
  assert.equal(reaps().length, 0);
  const params = { taskId: send.taskId };
  const [first, duplicate] = await Promise.all([rpc('tasks/cancel', params), rpc('tasks/cancel', params)]);
  assert.equal(first.status, 'cancelled');
  assert.deepEqual(first, duplicate);
  assert.deepEqual(first, await rpc('tasks/get', params));
  assert.deepEqual(reaps().map(({ args }) => args), [[job.task_dir]]);
  assert.ok(fs.existsSync(join(job.task_dir, 'STATUS.json.stop-requested')));
});

test('MCP tasks: a fresh server cannot cancel old tasks; legacy and failed dispatches stay immediate', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.rpc('initialize', { protocolVersion: '2025-11-25' });
  const { result: legacy } = await f.rpc('tools/list');
  assert.equal(legacy.resultType, undefined);
  assert.ok(legacy.tools.some(({ name }) => name === 'hud_wait'));
  const old = await f.call('hud_create', { role: 'imp', task: 'Synthetic legacy job.' });
  assert.equal(old.watcher_alive, false);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Synthetic task before restart.' });
  const job = taskJob(f, task);
  const child = spawn(process.execPath, [entry], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.stdin.end(); assert.deepEqual(await exited, [0, null]); });
  const next = taskRpc(rpcClient(child));
  await next('server/discover');
  const unknown = await next('tasks/get', { taskId: task.taskId });
  assert.equal(unknown.resultType, 'complete');
  assert.equal(unknown.status, 'failed');
  assert.match(unknown.statusMessage, /hud_read/);
  assert.equal((await next('tasks/cancel', { taskId: task.taskId })).status, 'failed');
  assert.equal(fs.existsSync(join(job.task_dir, 'STATUS.json.stop-requested')), false);
  const retry = await taskCall(next, 'hud_create', { role: 'imp', task: 'Synthetic legacy job.' });
  assert.equal(retry.resultType, 'complete');
  assert.equal(resultValue(retry).job, old.job);
  fs.writeFileSync(join(f.env.HOME, 'fail-start'), 'Synthetic startup failure.');
  const failure = await taskCall(next, 'hud_create', { role: 'imp', on: 'pi', task: 'Synthetic failure.' });
  assert.equal(failure.resultType, 'complete');
  assert.equal(resultValue(failure).ok, false);
});

test('roster and create report pane watcher liveness, with Claude delivery guidance', async (t) => {
  const f = await fixture(t);
  const create = () => f.call('hud_create', { role: 'imp', request_key: 'watcher-live', task: 'Synthetic task.' });
  const roster = await f.call('hud_roster');
  assert.equal(roster.watcher_alive, false);
  assert.match(roster.hint, /^Claude Code: run `hud watch` under Monitor; re-arm after expiry\./);
  const initial = await create();
  assert.equal(initial.watcher_alive, false);
  assert.equal(initial.hint, roster.hint);

  const child = spawn(process.execPath, [resolve('bin/hud'), 'watch'], { env: f.env, stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(() => child.kill('SIGKILL'));
  await until(() => fs.existsSync(join(f.env.HUD_HOME, 'watchers/w4E:p1.pid')));
  const live = await f.call('hud_roster');
  assert.equal(live.watcher_alive, true);
  assert.match(live.hint, /^Claude Code: `hud watch` is live under Monitor;/);
  const retry = await create();
  assert.equal(retry.job, initial.job);
  assert.equal(retry.watcher_alive, true);
  assert.equal(Object.hasOwn(retry, 'hint'), false);

  child.kill('SIGTERM');
  await exited;
  assert.equal((await f.call('hud_roster')).watcher_alive, false);
});

test('lean main-pi delegation collects first and repeat reports through native watch without polling', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.startCliSocket(); // Read-close checks fake Herdr's agent state after the report is collected.
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const convention = '# Synthetic project convention\n' + '- Retain the scope and evidence for this project. 下一步: read the report before accepting.\n'.repeat(26);
  fs.writeFileSync(join(f.root, 'hud-convention.md'), convention);
  // Stub the pi host API, not the HUD registration, native watcher, MCP proxy or stdio server.
  // The synthetic launcher's basename is pi so the real pane/PID watcher check is exercised.
  const launcher = join(f.root, 'pi');
  fs.writeFileSync(launcher, `
import { createInterface } from 'node:readline';
import { installPiPackage } from ${JSON.stringify(resolve('dist/harness/pi/package-entry.js'))};
const tools = new Map(), hooks = new Map();
const send = (value) => console.log(JSON.stringify(value));
const ctx = { cwd: process.cwd(), sessionManager: { getSessionDir: () => 'synthetic', getSessionId: () => 'main' } };
installPiPackage({
  on: (name, fn) => { hooks.set(name, fn); },
  registerTool: (tool) => { tools.set(tool.name, tool); },
  sendMessage: ({ content }) => send({ notice: content }),
}, { release: ${JSON.stringify(resolve('.'))}, hudHome: process.env.HUD_HOME, node: process.execPath }, {}, 'delegate');
await hooks.get('session_start')({}, ctx);
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const { name, args } = JSON.parse(line);
    send(await tools.get(name).execute('synthetic', args, undefined, undefined, ctx));
  }
} finally { await hooks.get('session_shutdown')(); }
`);
  const pi = spawn(process.execPath, [launcher], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(pi, 'close'), notices = [], calls = [];
  let stderr = '', reply;
  pi.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  createInterface({ input: pi.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.notice) notices.push(...message.notice.split('\n'));
    else reply(message);
  });
  const call = async (name, args) => {
    const result = await Promise.race([new Promise((done) => {
      reply = done;
      pi.stdin.write(JSON.stringify({ name, args }) + '\n');
    }), exited.then(() => assert.fail(stderr || 'Synthetic pi host exited'))]);
    assert.equal(result.isError, undefined);
    const { text } = result.content[0];
    calls.push([name, Buffer.byteLength(text, 'utf8')]);
    return JSON.parse(text);
  };
  try {
    const { result } = await f.rpc('tools/list');
    const tools = result.tools.filter(({ name }) => name !== 'hud_statusline');
    const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
    t.diagnostic(`tool declarations: ${bytes(tools)} B (create ${bytes(tools.find(({ name }) => name === 'hud_create'))} B)`);
    await until(() => fs.existsSync(join(f.env.HUD_HOME, 'watchers', 'w4E:p1.pid')));
    const roster = await call('hud_roster', { cwd: f.root });
    assert.equal(roster.watcher_alive, true);
    assert.match(roster.hint, /^pi: native HUD notices/);
    assert.equal(roster.roles.length, 7);
    assert.equal(roster.convention.text, convention);
    const imp = roster.roles.find((r) => r.role === 'imp' && r.available);
    assert.equal(imp.can_continue, true);
    assert.deepEqual(imp.runs_on, { harness: 'pi', pi_role: 'implementer', model: 'synthetic/default', thinking: 'low' });
    let repeated, collected;
    for (const request_key of ['lean-first', 'lean-repeat']) {
      const created = await call('hud_create', { role: imp.role, cwd: f.root, request_key, task: 'Synthetic task: 新 report.' });
      repeated = created.job;
      assert.equal(created.watcher_alive, true);
      assert.equal(created.hint, request_key === 'lean-first' ? roster.hint : undefined);
      assert.equal(created.role, 'imp');
      assert.equal(cliState(created.task_dir).state, 'working');
      assert.ok(f.commands().some(({ args }) => args[0] === 'agent' && args[1] === 'prompt' && args[2] === created.agent));
      assert.equal(fs.existsSync(join(created.task_dir, 'report.md')), false, 'create waits for startup/prompt, not a report');
      // Simulate the worker finishing after create returns; the caller only awaits a native event.
      await publishPiGrace(created);
      await until(() => notices.includes(`${created.job} imp: idle_grace | report`));
      const receipt = () => JSON.parse(fs.readFileSync(join(created.task_dir, 'job.json')));
      assert.equal(receipt().read_at, undefined, 'notification does not consume the report');
      assert.equal(cliState(created.task_dir).state, 'idle_grace');
      collected = await call('hud_read', { job: created.job });
      assert.equal(collected.report, 'Synthetic settled pi report.\n');
      assert.ok(receipt().read_at);
      await until(() => cliState(created.task_dir)?.exit_reason === 'closed after report read');
    }
    const normal = calls.splice(0);
    assert.deepEqual(normal.map(([name]) => name), ['hud_roster', 'hud_create', 'hud_read', 'hud_create', 'hud_read']);
    t.diagnostic(`monitored replies (B): cold ${JSON.stringify(normal.slice(0, 3))}; repeat ${JSON.stringify(normal.slice(3))}`);
    const refresh = await call('hud_roster', { cwd: f.root });
    assert.equal(refresh.convention_unchanged, true);
    assert.equal(refresh.convention, undefined);
    assert.ok([...(collected.changes ?? []), ...(refresh.changes ?? [])].some((line) => line.startsWith(`${repeated} imp: closed`)));
    const working = waitFixtureJob(f, 1, 'working', 'w4E:p9');
    fs.writeFileSync(join(working.dir, 'job.json'), JSON.stringify({ ...working.receipt, model: 'synthetic/default',
      thinking: 'low', model_source: join(f.root, 'roles/implementer.md'), split: false, pi_args: [],
      dispatch_exit_code: 0, stderr_tail: '', role_skills: [], skipped_skills: [], worker_prompt: null }));
    const read = await call('hud_read', { job: working.job });
    assert.deepEqual(read, { job: working.job, role: 'imp', state: 'working', report_exists: false });
    t.diagnostic(`optional replies (B): roster refresh ${calls[0][1]}; working read ${calls[1][1]}`);
    const retry = await call('hud_create', { role: imp.role, cwd: f.root, request_key: 'lean-repeat', task: 'Do not run this.' });
    assert.equal(retry.job, repeated);
    assert.equal(f.commands().filter((c) => c.command === 'pi-role').length, 2, 'retry never relaunches');
  } finally {
    pi.stdin.end();
    assert.deepEqual(await exited, [0, null], stderr);
    assert.equal(stderr, '');
  }
});

function runSonic(f, action, dir, ...args) {
  return new Promise((done) => execFile(process.execPath,
    [resolve('packages/hud-mcp/bin/hud-sonic.mjs'), action, '--dir', dir, ...args],
    { cwd: f.root, env: { ...f.env, HUD_JOB_DIR: dir, HERDR_PANE_ID: 'w4E:p9' } },
    (error, stdout, stderr) => done({ status: error?.code ?? 0, stdout, stderr })
  ));
}
function sonicTask(f) {
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'sonic.json'), JSON.stringify({
    role: 'sonic', instructions: 'sonic', can_continue: false, run: [{
      harness: 'pi', pi_role: 'sonic', model: 'synthetic/sonic', thinking: 'low',
    }],
  }));
  const task = join(f.root, 'sonic-task.md');
  fs.writeFileSync(task, '# Synthetic sonic sub-task\n\nSummarize the synthetic fixture.');
  return task;
}
function publishSonic(dir, status) {
  const tmp = join(dir, 'test-status.tmp');
  fs.writeFileSync(tmp, JSON.stringify(status));
  fs.renameSync(tmp, join(dir, 'STATUS.json'));
}

test('hud_sonic starts two independent child jobs; wait follows STATUS, scope and timeout', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const task = sonicTask(f);
  const parent = await f.call('hud_create', { role: 'imp', request_key: 'sonic-parent', task: 'Synthetic parent.' });
  const call = workerClient(t, f, parent.task_dir);
  const start = async (thinking) => resultValue(await call('hud_sonic', { task: fs.readFileSync(task, 'utf8'), thinking })).job;
  const [first, second] = await Promise.all([start('high'), start()]);
  assert.notEqual(first, second);
  const dir = (id) => join(f.env.HUD_HOME, 'jobs', id);
  for (const [id, thinking] of [[first, 'high'], [second, 'low']]) {
    assert.match(id, /^j[0-9a-f]{16}$/);
    const job = JSON.parse(fs.readFileSync(join(dir(id), 'job.json')));
    assert.equal(job.parent_job, parent.job);
    assert.equal(job.herdr_pane, 'w4E:p1');
    assert.equal(job.cwd, f.root);
    assert.equal(job.role, 'sonic');
    assert.equal(job.model, 'synthetic/sonic');
    assert.equal(job.thinking, thinking);
    const launched = f.commands().find(({ args }) => args[1] === 'start' && args[2] === `${id}-primary`).args;
    assert.equal(launched[launched.indexOf('--thinking') + 1], thinking);
    assert.match(fs.readFileSync(join(dir(id), 'SESSION.txt'), 'utf8'), /^ORCH=w4E:p1$/m);
    assert.equal(cliState(dir(id)).state, 'working');
  }
  const wait = (id, timeout = '0', own = parent.task_dir) => runSonic(f, 'wait', own, '--job', id, '--timeout', timeout);
  const stillWorking = { status: 3, stdout: 'still working: run wait again\n', stderr: '' };
  assert.deepEqual(await wait(first), stillWorking, 'a report file alone does not settle a child');
  assert.deepEqual(await wait(second, '0.2'), stillWorking);
  assert.deepEqual(resultValue(await call('hud_sonic', { timeout_s: 0 })), { reports: [], working: [first, second].sort(), failed: [] });
  const qa = join(dir(first), 'qa');
  fs.mkdirSync(qa, { recursive: true });
  fs.writeFileSync(join(qa, 'q1.md'), 'Synthetic child question.');
  const changes = async () => (await f.call('hud_read')).changes ?? [];
  assert.ok((await changes()).some((line) => line.startsWith(first) && line.includes('QUESTION') && !line.includes(' | report')));
  const waiting = call('hud_sonic', { timeout_s: 2 });
  fs.writeFileSync(join(qa, 'q1.answer.md'), 'Answer.');
  publishSonic(dir(first), { state: 'closed', output_written: true });
  assert.ok(!(await changes()).some((line) => line.startsWith(first)), 'child settlement stays quiet');
  publishSonic(dir(second), { state: 'closed', output_written: true });
  assert.deepEqual(resultValue(await waiting), { working: [], failed: [], reports: [first, second].sort().map((id) => ({
    id, path: `${dir(id)}/report.md`, body: 'Synthetic implementation report.',
  })) });
  assert.deepEqual(resultValue(await call('hud_sonic', { timeout_s: 0 })), { reports: [], working: [], failed: [] });
  assert.equal((await f.call('hud_read')).jobs.find((job) => job.job === first).report_unread, true);
  assert.match((await f.call('hud_read', { job: first, full: true })).report, /Synthetic implementation report/);

  const other = await f.call('hud_create', { role: 'imp', request_key: 'not-the-parent', task: 'Synthetic other job.' });
  const refused = await wait(first, '0', other.task_dir);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not a sonic child/);
  const sonicParent = await runSonic(f, 'start', dir(first), '--task-file', task);
  assert.equal(sonicParent.status, 1);
  assert.match(sonicParent.stderr, /a sonic worker cannot start sonic/);
  const inline = await runSonic(f, 'start', parent.task_dir, '--task', 'Synthetic inline sub-task.');
  assert.equal(inline.status, 0, inline.stderr);
  assert.match(fs.readFileSync(join(dir(inline.stdout.trim()), 'brief.md'), 'utf8'), /^Synthetic inline sub-task\./);
  publishSonic(dir(inline.stdout.trim()), { state: 'failed', exit_reason: 'synthetic child failed' });
  const failed = await wait(inline.stdout.trim());
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /synthetic child failed/);
  for (const opts of [[], ['--task', 'Synthetic.', '--task-file', task], ['--task', ' ']]) {
    const bad = await runSonic(f, 'start', parent.task_dir, ...opts);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--task <text> or --task-file <file>|the sub-task is empty/);
  }
  const foreignDir = join(f.root, first);
  fs.mkdirSync(foreignDir);
  fs.copyFileSync(join(dir(first), 'job.json'), join(foreignDir, 'job.json'));
  const outside = await runSonic(f, 'start', foreignDir, '--task-file', task);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /under HUD_HOME/);
});

test('main and worker dispatch use inherited sonic choices before mapping to model-supported thinking', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const task = sonicTask(f); // Owner launch settings override the shipped chain, but omit thinking_choices.
  const expected = {
    low: 'mechanical lookups: counts, listings, finding a definition',
    high: 'surveys across several files, small doc patches',
    max: 'tracing a cause, cross-checking claims against each other',
  };
  for (const detail of [false, true]) {
    const { roles } = await f.call('hud_roster', { detail });
    assert.deepEqual(roles.find(({ role }) => role === 'sonic').thinking_choices, expected);
    assert.equal(roles.find(({ role }) => role === 'imp').thinking_choices, undefined);
  }
  fs.writeFileSync(join(f.env.HOME, 'pi-model-caps.json'), JSON.stringify({
    'synthetic/sonic': { provider: 'synthetic', id: 'sonic', reasoning: true,
      thinkingLevelMap: { minimal: null, medium: null } },
  }));
  const refused = await f.call('hud_create', { role: 'sonic', task: 'Synthetic task.', thinking: 'off' });
  assert.equal(refused.code, 'invalid_arguments');
  assert.match(refused.error, /low, high, max/);
  assert.equal(refused.job, undefined);
  const parent = await f.call('hud_create', { role: 'imp', request_key: 'cap-parent', task: 'Synthetic parent.' });
  const call = workerClient(t, f, parent.task_dir);
  const { tools } = (await call.rpc('tools/list')).result;
  const schema = tools.find(({ name }) => name === 'hud_sonic').inputSchema.properties.thinking;
  assert.deepEqual(schema.enum, Object.keys(expected));
  for (const [level, purpose] of Object.entries(expected)) assert.ok(schema.description.includes(`${level} — ${purpose}`));
  const workerRefused = await call('hud_sonic', { task: 'Synthetic child.', thinking: 'off' });
  assert.equal(workerRefused.isError, true);
  const workerError = JSON.parse(workerRefused.content[0].text);
  assert.equal(workerError.code, 'invalid_arguments');
  assert.match(workerError.error, /low, high, max/);
  const sonic = resultValue(await call('hud_sonic', { task: 'Synthetic child.', thinking: 'max' }));
  assert.equal(sonic.thinking, 'high');
  const script = await runSonic(f, 'start', parent.task_dir, '--task-file', task, '--thinking', 'max');
  assert.equal(script.status, 0, script.stderr);
  assert.match(script.stderr, /^thinking: high/m);
  const main = await f.call('hud_create', { role: 'sonic', request_key: 'cap-main', task: 'Synthetic task.', thinking: 'max' });
  assert.equal(main.thinking, 'high');
  for (const id of [sonic.job, script.stdout.trim(), main.job]) {
    const launch = f.commands().find(({ args }) => args[1] === 'start' && args[2] === `${id}-primary`).args;
    assert.equal(launch[launch.indexOf('--thinking') + 1], 'high');
  }
});

test('roster rejects a role file with a multiline thinking purpose', async (t) => {
  const f = await fixture(t);
  sonicTask(f);
  const path = join(f.env.HUD_HOME, 'roles', 'sonic.json');
  const role = JSON.parse(fs.readFileSync(path, 'utf8'));
  fs.writeFileSync(path, JSON.stringify({ ...role, thinking_choices: { low: 'First line\nSecond line' } }));
  const roster = await f.call('hud_roster');
  assert.deepEqual(roster.invalid, [{ path, reason: 'bad thinking_choices' }]);
  assert.ok(roster.roles.some(({ role, thinking_choices }) => role === 'sonic' && thinking_choices.low));
});

test('launch thinking facts map CLI efforts before opening the worker; unknown models pass through', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'phantom-working'), '');
  for (const [on, model, thinking, expected] of [
    ['claude', 'opus', 'ultra', 'max'], ['agy', 'gemini-4-hydrogen-high', 'minimal', 'low'],
    ['claude', 'haiku', 'minimal', 'low'], ['claude', 'claude-fable-5-2', 'ultra', 'max'],
    ['claude', 'claude-opus-5-5', 'ultra', 'max'], ['claude', 'claude-sonnet-5-5', 'ultra', 'max'],
    ['agy', 'gemini-3.8-flash-high', 'minimal', 'low'],
    ['codex', 'gpt-5.5', 'max', 'xhigh'], ['codex', 'gpt-6.1-sol', 'ultra', 'ultra'],
    ['claude', 'hud-unknown', 'ultra', 'ultra'], ['grok', 'grok-4.7', 'minimal', 'minimal'],
  ]) {
    const job = await f.call('hud_create', { role: 'imp', task: `Synthetic ${on} ${model}.`, on, model, thinking });
    assert.equal(job.thinking, expected, JSON.stringify(job));
    const { args } = f.commands().find(({ args }) => args[1] === 'start' && args[2] === job.agent);
    if (on === 'codex') assert.ok(args.includes(`model_reasoning_effort=${expected}`));
    else assert.equal(args[args.indexOf(on === 'grok' ? '--reasoning-effort' : '--effort') + 1], expected);
  }
});

test('every bundled role uses the same unanswered-question policy', () => {
  const dir = resolve('packages/hud-mcp/instructions');
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    const body = fs.readFileSync(join(dir, file), 'utf8').replace(/\s+/g, ' ');
    assert.match(body, /If unanswered after 20 minutes, proceed on the default only if it is reversible and inside the brief; otherwise leave that part and name it as blocked in your report/, file);
  }
});

test('an open sonic child holds the real CLI supervisor; uncollected reports get one fixed prompt', { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const task = sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'sonic-parent-cli', 0.25, false);
  const server = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.95));
  configureFakeDecision(f, server.baseUrl);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  await f.startCliSocket();
  const handle = await taskCall(rpc, 'hud_create', { role: 'sonic-parent-cli', request_key: 'sonic-parent-cli', task: 'Synthetic CLI parent.' });
  const parent = taskJob(f, handle);
  parent.agent = `${parent.job}-primary`;
  await until(() => cliState(parent.task_dir)?.agent_session_id);
  const start = () => runSonic(f, 'start', parent.task_dir, '--task-file', task);
  const [child, alreadyCollected] = await Promise.all([start(), start()]);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(alreadyCollected.status, 0, alreadyCollected.stderr);
  const id = child.stdout.trim(), dir = join(f.env.HUD_HOME, 'jobs', id);
  const collectedId = alreadyCollected.stdout.trim();
  publishSonic(join(f.env.HUD_HOME, 'jobs', collectedId), { state: 'closed', output_written: true });
  const report = await runSonic(f, 'wait', parent.task_dir, '--job', collectedId, '--timeout', '0');
  assert.equal(report.status, 0, report.stderr);
  const prompts = () => f.commands().filter(({ args }) => args[1] === 'prompt' && args[2] === parent.agent && args[3].startsWith('Collect these sonic reports'));
  f.push(parent.job, 'idle');
  await new Promise((done) => setTimeout(done, 400)); // exceeds the accelerated 250ms no-report grace
  assert.equal(server.requests.length, 0);
  assert.equal(cliState(parent.task_dir).state, 'working');

  fs.writeFileSync(join(parent.task_dir, 'report.md'), 'Premature synthetic parent report.');
  await new Promise((done) => setTimeout(done, 700)); // exceeds the accelerated report stability window
  assert.equal(cliState(parent.task_dir).state, 'working');
  assert.equal(cliState(parent.task_dir).settled_at, null);
  assert.equal(readCloseQuit(f, parent), false);
  assert.equal(prompts().length, 0);

  publishSonic(dir, { state: 'closed', output_written: true });
  await until(() => prompts().length === 1, 5000);
  assert.ok(prompts()[0].args[3].includes(id));
  assert.ok(!prompts()[0].args[3].includes(collectedId));
  assert.equal((await rpc('tasks/get', { taskId: handle.taskId })).status, 'working');
  const next = await taskCall(rpc, 'hud_send', { job: parent.job, text: 'Synthetic caller turn after collection.' });
  assert.equal(taskJob(f, next).job, parent.job);
  const superseded = await rpc('tasks/cancel', { taskId: handle.taskId });
  assert.equal(superseded.status, 'failed');
  assert.match(superseded.statusMessage, /no longer current/);
  assert.equal(reapAttempts(f, parent), 0);
  fs.writeFileSync(join(parent.task_dir, 'report.md'), 'Synthetic parent report after collect prompt.');
  await until(() => cliState(parent.task_dir)?.state === 'closed', 5000);
  assert.equal((await rpc('tasks/get', { taskId: next.taskId })).status, 'completed');
  assert.equal(prompts().length, 1, 'the same report is not prompted for again');
  assert.equal(server.requests.length, 0);
});

test('supervisor events: report then long summary, flapping, explicit continuation and rewritten report', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'event-cli', 4);
  const job = await f.call('hud_create', { role: 'event-cli', request_key: 'events', task: 'Synthetic event sequences.' });
  await until(() => cliState(job.task_dir)?.pid);
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'Report before the long summary.\n');
  await new Promise((r) => setTimeout(r, 750));
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).quiet_decision, undefined);
  f.push(job.job, 'done');
  // One virtual second per flap. No advisory event may create/re-baseline a turn.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 50));
    f.push(job.job, i % 2 ? 'done' : 'working');
  }
  assert.equal(cliState(job.task_dir).state, 'working');
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  assert.equal(cliState(job.task_dir).output_written, true);
  assert.equal(cliState(job.task_dir).quiet_decision, undefined);
  const first = JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json')));
  const sent = await f.call('hud_send', { job: job.job, message_key: 'continue', text: 'Synthetic continuation.' });
  assert.equal(sent.sent, true);
  const second = JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json')));
  assert.equal(second.seq, first.seq + 1);
  assert.match(second.report_sig, /:/);
  await until(() => cliState(job.task_dir)?.state === 'working');
  await f.call('hud_send', { job: job.job, message_key: 'continue', text: 'Synthetic retry.' });
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json'))).seq, second.seq);
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'Report before the long summary.\n'); // same bytes, new signature
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  assert.equal(cliState(job.task_dir).output_written, true);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[2] === 'w4E:p1'), false);
  assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
});

test('supervisor events: a report with a missed status push settles on the safety tick', { timeout: 10000 }, async (t) => {
  // Live agy 2026-11-14: the push was never matched and a finished job stayed working for 10 minutes.
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'missed-push', 4);
  const job = await f.call('hud_create', { role: 'missed-push', request_key: 'missed-push', task: 'Synthetic missed push.' });
  await until(() => cliState(job.task_dir)?.pid);
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'Report, then herdr goes idle without a push.\n');
  f.silent(job.job, 'idle');
  await until(() => cliState(job.task_dir)?.state === 'idle_grace', 5000);
  assert.equal(cliState(job.task_dir).output_written, true);
});
function fakeCliWithChild(t, f) {
  const worker = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const children = new Map();
    let latest;
    process.on('message', ({ command, args, detached }) => {
      if (command) {
        const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], detached });
        latest = child.pid;
        children.set(latest, detached);
        child.once('exit', () => children.delete(child.pid));
        process.send(latest);
      } else process.kill(latest);
    });
    process.on('disconnect', () => {
      for (const [pid, group] of children) { try { process.kill(group ? -pid : pid); } catch {} }
    });
  `], { env: f.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(worker, 'exit');
  t.after(async () => { if (worker.connected) worker.disconnect(); await exited; });
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(worker.pid));
  return {
    pid: worker.pid,
    // Model a tool shell that stays live until stopped, without leaving an orphan child.
    async start(command = '/bin/bash', args = ['-c', 'read -r line'], detached = false) {
      const message = once(worker, 'message');
      worker.send({ command, args, detached });
      const [pid] = await message;
      assert.equal(procStat(pid)?.ppid, worker.pid);
      return pid;
    },
    stop: () => worker.send({}),
    exit: async () => { worker.disconnect(); await exited; },
  };
}

const statusQueries = (f, job) => f.socketRequests.filter((r) =>
  r.method === 'agent.get' && r.params.target === `${job.job}-primary`).length;

const readCloseQuit = (f, job) => f.commands().some((c) =>
  c.command === 'herdr' && c.args[1] === 'prompt' && c.args[2] === job.agent && c.args[3] === '/quit');
const readCloseReaped = (job) => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).reaped_at;
const reapAttempts = (f, job) => f.commands().filter((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir).length;
const progressCommand = resolve('packages/hud-mcp/bin/hud-progress.mjs');
const cliToken = (dir) => turnToken(JSON.parse(fs.readFileSync(join(dir, 'turn.json'), 'utf8')));
const runProgress = (f, dir, ...args) => spawnSync(process.execPath, [progressCommand, ...args], {
  env: { ...f.env, HUD_JOB_DIR: dir }, encoding: 'utf8',
});
function declareDone(f, job, cli = true) {
  const dir = job.task_dir;
  const result = runProgress(f, dir, '--done', ...(cli ? ['--turn', cliToken(dir)] : []));
  assert.equal(result.status, 0, result.stderr);
}

async function publishPiGrace(job, worker, writeReport = true) {
  const dir = job.task_dir;
  const report = join(dir, 'report.md');
  if (writeReport) fs.writeFileSync(report, 'Synthetic settled pi report.\n');
  const now = Date.now();
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({
    version: 1, task_dir: dir, slot: 'primary', state: 'idle_grace', output_written: true,
    ...(worker ? { pid: worker.pid, pid_start_time: procStat(worker.pid).start } : {}),
    settled_at: new Date(now).toISOString(), idle_deadline_at: new Date(now + 8000).toISOString(),
  }));
  const mtime = fs.statSync(report).mtimeMs;
  await until(() => Date.now() > mtime); // hud_read records integer milliseconds.
}

const checkFile = (job) => join(job.task_dir, 'checks.json');
const checkReceipt = (job) => fs.existsSync(checkFile(job)) ? JSON.parse(fs.readFileSync(checkFile(job), 'utf8')) : null;

test('HUD checks: CLI declaration starts ordered checks, delays reap and announces results', { timeout: 18000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'hud-check-cli', 15, false);
  const job = await f.call('hud_create', { role: 'hud-check-cli', task: 'Synthetic check job.', checks: [
    'echo "$BASHPID" > check-shell; for ((i=0; i<300; i++)); do [[ -f release-check ]] && break; sleep .05; done; test -f release-check',
    'test -f check-shell || exit 9; printf "%4096s failure tail" x >&2; exit 7',
  ] });
  const dir = job.task_dir, pidFile = join(f.env.HUD_HOME, 'watch.pid');
  fs.writeFileSync(join(dir, 'reap-worker'), '');
  const lines = [], ac = new AbortController();
  const watching = watchCommand([], { env: f.env, stdout: (s) => lines.push(...s.trim().split('\n')), stderr: () => {} },
    { signal: ac.signal, rescanMs: 100 });
  try {
    fs.writeFileSync(join(dir, 'report.md'), 'Synthetic report without a declaration yet.\n');
    await new Promise((done) => setTimeout(done, 120));
    assert.equal(checkReceipt(job), null);
    declareDone(f, job);
    await until(() => checkReceipt(job)?.state === 'running' && fs.existsSync(join(f.root, 'check-shell')));
    const { pid: helper } = checkReceipt(job);
    const shell = Number(fs.readFileSync(join(f.root, 'check-shell'), 'utf8'));
    const watchPid = Number(fs.readFileSync(pidFile, 'utf8'));
    await until(() => lines.some((line) => line.includes('closed') && line.includes('report')), 6500);
    assert.ok(procStat(watchPid) && procStat(helper) && procStat(worker.pid));
    assert.equal(reapAttempts(f, job), 0);
    assert.equal(readCloseQuit(f, job), false);
    assert.equal((await f.call('hud_read', { job: job.job })).checks.state, 'running');
    assert.match(cardText(workerFor(f, job.job)), /\[↻0\/2\]/);
    fs.writeFileSync(join(f.root, 'release-check'), '');
    await until(() => checkReceipt(job)?.state === 'done' && !fs.existsSync(pidFile));
    const receipt = checkReceipt(job);
    assert.equal(receipt.turn, cliToken(dir));
    assert.equal(receipt.report_sig, reportSignature(dir));
    assert.equal(fs.statSync(checkFile(job)).mode & 0o777, 0o600);
    assert.deepEqual(receipt.results.map((r) => r.exit_code), [0, 7]);
    assert.ok(receipt.results.every((r) => r.duration_ms >= 0 && Buffer.byteLength(r.output_tail) <= 2048));
    const read = await f.call('hud_read', { job: job.job });
    assert.equal(read.state, 'closed', 'the failing check does not fail the job');
    assert.equal(read.checks.stale, false);
    assert.deepEqual(read.checks.results.map((r) => r.passed), [true, false]);
    assert.equal(read.checks.results[0].output_tail, undefined);
    assert.match(read.checks.results[1].output_tail, /failure tail$/);
    assert.match(cardText(workerFor(f, job.job)), /\[✗1\/2\]/);
    assert.match(workInspectorRows(workerFor(f, job.job), initialMonitorState(), 56, Date.now()).map((r) => stripAnsi(r.text)).join('\n'), /\[✗1\/2\]/);
    await until(() => lines.some((line) => line.endsWith(' | checks 1/2')), 6500);
    assert.equal(lines.filter((line) => line.includes(' | checks ')).length, 1);
    assert.equal(reapAttempts(f, job), 1);
    assert.ok([helper, shell, watchPid, worker.pid].every((pid) => !procStat(pid) || procStat(pid)?.state === 'Z'));
  } finally {
    fs.writeFileSync(join(f.root, 'release-check'), '');
    ac.abort(); await watching;
  }
});

test('HUD checks: Pi continuation and report rewrite make results stale; a running check does not block repair', { timeout: 14000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  await f.startCliSocket();
  const checks = ['echo ran >> check-count; if [[ -f hold-check ]]; then for ((i=0; i<100; i++)); do [[ -f release-check ]] && break; sleep .05; done; test -f release-check; fi'];
  const job = await f.call('hud_create', { role: 'imp', task: 'Synthetic checks and repair.', checks });
  assert.equal(checkReceipt(job), null);
  await publishPiGrace(job);
  await until(() => checkReceipt(job)?.state === 'done');
  const previous = checkReceipt(job);
  assert.equal(previous.report_sig, reportSignature(job.task_dir));
  assert.equal((await f.call('hud_send', { job: job.job, text: 'Synthetic continuation.' })).sent, true);
  assert.equal((await f.call('hud_read', { job: job.job })).checks.stale, true);
  assert.equal(checkReceipt(job).turn, previous.turn);
  const oldRead = Date.now();
  // Keep the synthetic report newer than the previous report's read receipt, even on coarse file clocks.
  await until(() => Date.now() > oldRead + 5);
  await publishPiGrace(job);
  await until(() => checkReceipt(job)?.state === 'done' && checkReceipt(job).turn !== previous.turn);
  const next = checkReceipt(job);
  assert.notEqual(next.report_sig, previous.report_sig);
  assert.equal(readCloseReaped(job), undefined);
  const report = join(job.task_dir, 'report.md');
  fs.writeFileSync(report, 'Synthetic rewritten Pi report.\n');
  await until(() => Date.now() > fs.statSync(report).mtimeMs);
  assert.equal((await f.call('hud_read', { job: job.job })).checks.stale, true);
  assert.equal(checkReceipt(job).report_sig, next.report_sig);
  fs.writeFileSync(join(f.root, 'hold-check'), '');
  await publishPiGrace(job, undefined, false);
  const send = { job: job.job, text: 'Synthetic repair during a check hold.' };
  try {
    await until(() => checkReceipt(job)?.state === 'running');
    const repair = await f.call('hud_send', send);
    assert.equal(repair.continued_as, repair.job);
    assert.notEqual(repair.job, job.job);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(repair.task_dir, 'job.json'), 'utf8')).checks, checks);
    assert.equal(readCloseReaped(job), undefined);
    assert.equal(reapAttempts(f, job), 0);
    assert.equal(cliState(job.task_dir).state, 'idle_grace');
    fs.writeFileSync(join(f.root, 'release-check'), '');
    await until(() => readCloseReaped(job));
    assert.equal(checkReceipt(job).report_sig, reportSignature(job.task_dir));
    assert.equal(fs.readFileSync(join(f.root, 'check-count'), 'utf8'), 'ran\nran\nran\n');
    assert.equal((await f.call('hud_send', send)).continued_as, repair.job);
  } finally { fs.writeFileSync(join(f.root, 'release-check'), ''); }
});

test('read-close: hud_read closes settled CLI and pi workers within one tick', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'read-close-cli', 8);
  for (const role of ['read-close-cli', 'imp']) {
    const job = await f.call('hud_create', { role, request_key: `close-on-read-${role}`, task: 'Synthetic task.', package: 'Original package' });
    if (role === 'imp') await publishPiGrace(job); // Fake pi settles only after the initial prompt.
    await until(() => cliState(job.task_dir)?.state === 'idle_grace');
    const grace = cliState(job.task_dir), queries = statusQueries(f, job);
    assert.equal(readCloseReaped(job), undefined);
    const read = await f.call('hud_read', { job: job.job });
    assert.match(read.report, /^Synthetic /);
    await until(() => cliState(job.task_dir)?.state === 'closed', 1650); // 1.5s accelerated safety tick + dispatch overhead.
    const closed = cliState(job.task_dir);
    assert.equal(closed.exit_reason, 'closed after report read');
    assert.equal(closed.output_written, true);
    assert.equal(closed.settled_at, grace.settled_at);
    assert.ok(Date.parse(closed.ended_at) < Date.parse(grace.idle_deadline_at));
    assert.ok(statusQueries(f, job) <= queries + 1);
    if (role !== 'imp') assert.ok(readCloseQuit(f, job));
    await until(() => readCloseReaped(job));
    assert.ok(f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir));
    const send = { job: job.job, text: 'Synthetic repair.' };
    const repair = await f.call('hud_send', send);
    assert.equal(repair.continued_as, repair.job);
    assert.notEqual(repair.job, job.job);
    assert.equal(repair.role, role);
    assert.equal(repair.package, 'Original package');
    const brief = fs.readFileSync(join(repair.task_dir, 'brief.md'), 'utf8');
    assert.ok(brief.startsWith(`${send.text}\n\n## Context References\n`));
    assert.ok(brief.includes(`${job.job} brief: ${JSON.stringify(join(job.task_dir, 'brief.md'))}`));
    assert.ok(brief.includes(`${job.job} report: ${JSON.stringify(join(job.task_dir, 'report.md'))}`));
    assert.equal((await f.call('hud_send', send)).continued_as, repair.job);
  }
});

test('read-close: reading the old Pi report after an admitted continuation does not reap', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  await f.startCliSocket();
  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-continuation', task: 'Synthetic task.' });
  await publishPiGrace(job);
  const sent = await f.call('hud_send', { job: job.job, message_key: 'next', text: 'Synthetic continuation.' });
  assert.equal(sent.sent, true);
  assert.equal(sent.queued, undefined, 'the continuation was admitted from idle grace');
  assert.match((await f.call('hud_read', { job: job.job })).report, /^Synthetic /);
  await new Promise((done) => setTimeout(done, 450));
  assert.equal(reapAttempts(f, job), 0);
  assert.equal(cliState(job.task_dir).state, 'idle_grace');
  assert.equal((await f.call('hud_send', { job: job.job, text: 'Do not repair the already continued report.' })).code, 'not_continuable');

  await publishPiGrace(job);
  assert.match((await f.call('hud_read', { job: job.job })).report, /^Synthetic /);
  await until(() => readCloseReaped(job));
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
});

test('read-close: aborts Pi reap when fresh Herdr status has turned working', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  await f.startCliSocket();
  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-resumed', task: 'Synthetic task.' });
  await publishPiGrace(job, worker);
  let state = 'idle';
  f.piStatus(() => (state = 'working')); // The worker resumes during the automatic reap preflight.
  assert.match((await f.call('hud_read', { job: job.job })).report, /^Synthetic /);
  await until(() => statusQueries(f, job) > 0);
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(state, 'working');
  assert.ok(procStat(worker.pid));
  assert.equal(cliState(job.task_dir).state, 'idle_grace', 'the on-disk status is still stale');
  assert.equal(reapAttempts(f, job), 0);
  assert.equal(readCloseReaped(job), undefined);

  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ ...cliState(job.task_dir), state: 'working' }));
  assert.equal((await f.call('hud_close', { job: job.job })).exit_code, 0);
  assert.equal(reapAttempts(f, job), 1, 'explicit close still invokes the reaper on a working job');
  assert.ok(fs.existsSync(join(job.task_dir, 'STATUS.json.stop-requested')));
});

test('read-close: failed Pi reap is retried on the slow safety tick without a file event', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 350);
  await f.startCliSocket();
  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-retry', task: 'Synthetic task.' });
  await publishPiGrace(job);
  fs.writeFileSync(join(job.task_dir, 'fail-reap-once'), '');
  assert.match((await f.call('hud_read', { job: job.job })).report, /^Synthetic /);
  const log = join(f.env.HUD_HOME, 'watch.log');
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes(`reap ${job.job} state=idle_grace exit=1`));
  assert.equal(cliState(job.task_dir).state, 'idle_grace');
  assert.equal(readCloseReaped(job), undefined);
  await until(() => readCloseReaped(job));
  assert.equal(reapAttempts(f, job), 2);
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
});

for (const rewrite of [false, true]) test(`read-close: Pi retries captured children after root exit and snapshot ENOSPC (rewrite=${rewrite})`, { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 350);
  const worker = fakeCliWithChild(t, f);
  await f.startCliSocket();
  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-partial-reap', task: 'Synthetic task.' });
  const child = await worker.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], true);
  const start = procStat(child).start;
  t.after(() => { if (procStat(child)?.start === start) process.kill(child, 'SIGKILL'); });
  await publishPiGrace(job, worker);
  const flag = join(f.env.HOME, 'snapshot-enospc');
  fs.writeFileSync(flag, String(child));
  fs.writeFileSync(join(job.task_dir, 'reap-worker'), '');
  f.piStatus(() => procStat(worker.pid) ? 'idle' : 'agent_not_found');
  assert.match((await f.call('hud_read', { job: job.job })).report, /^Synthetic /);
  const log = join(f.env.HUD_HOME, 'watch.log');
  await until(() => fs.readFileSync(log, 'utf8').includes('synthetic ENOSPC'));
  assert.equal(procStat(worker.pid), null);
  assert.equal(procStat(child)?.start, start);
  assert.equal(cliState(job.task_dir).state, 'idle_grace');
  assert.equal(readCloseReaped(job), undefined);
  if (rewrite) {
    const report = join(job.task_dir, 'report.md');
    fs.writeFileSync(report, 'Synthetic rewritten report.\n');
    assert.ok(Math.floor(fs.statSync(report).mtimeMs) > Date.parse(cliState(job.task_dir).settled_at));
    await until(() => Date.now() > fs.statSync(report).mtimeMs);
    assert.match((await f.call('hud_read', { job: job.job })).report, /rewritten report/);
  }
  // No relevant file event on fault removal: the slow retry must work without a live agent or eligible report.
  fs.unlinkSync(flag);
  await until(() => readCloseReaped(job));
  assert.ok(reapAttempts(f, job) >= 2);
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
  assert.ok(!procStat(child) || procStat(child).state === 'Z');
});

for (const trigger of ['native deadline', 'native one-shot']) test(`pi reap: ${trigger} retains ancestry captured before shutdown`, { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  const worker = fakeCliWithChild(t, f);
  const job = await f.call('hud_create', { role: 'imp', request_key: trigger, task: 'Synthetic task.' });
  const child = await worker.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], true);
  const start = procStat(child).start;
  t.after(() => { if (procStat(child)?.start === start) process.kill(child, 'SIGKILL'); });
  await publishPiGrace(job, worker);
  if (trigger === 'native one-shot') fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ ...cliState(job.task_dir), state: 'working' }));
  declareDone(f, job, false);
  process.kill(worker.pid, 'SIGTERM');
  await until(() => !procStat(worker.pid));
  assert.equal(procStat(child)?.start, start);
  const file = join(job.task_dir, 'STATUS.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...cliState(job.task_dir), state: 'closed', exit_reason: 'settled' }));
  fs.renameSync(`${file}.tmp`, file);
  await until(() => readCloseReaped(job));
  assert.ok(!procStat(child) || procStat(child).state === 'Z');
});

for (const fault of ['rename', 'open']) test(`pi reap: --done snapshot ${fault} ENOSPC before native shutdown`, { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  const worker = fakeCliWithChild(t, f);
  const job = await f.call('hud_create', { role: 'imp', request_key: `pi-done-${fault}`, task: 'Synthetic task.' });
  const child = await worker.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], true);
  const start = procStat(child).start;
  t.after(() => { if (procStat(child)?.start === start) process.kill(child, 'SIGKILL'); });
  await publishPiGrace(job, worker);
  const file = join(job.task_dir, 'STATUS.json');
  fs.writeFileSync(file, JSON.stringify({ ...cliState(job.task_dir), state: 'working' }));
  fs.writeFileSync(join(f.env.HOME, 'progress-snapshot-enospc'), fault);
  const done = runProgress(f, job.task_dir, '--done');
  assert.equal(fs.existsSync(join(job.task_dir, 'worker-tree.json')), false);
  process.kill(worker.pid, 'SIGTERM');
  await until(() => !procStat(worker.pid));
  assert.equal(procStat(child)?.start, start);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...cliState(job.task_dir), state: 'closed', exit_reason: 'settled' }));
  fs.renameSync(`${file}.tmp`, file);
  if (fault === 'rename') {
    await until(() => readCloseReaped(job));
    assert.ok(!procStat(child) || procStat(child).state === 'Z', 'watcher recovered the captured orphan');
  } else {
    const log = join(f.env.HUD_HOME, 'watch.log');
    await until(() => readCloseReaped(job) || reapAttempts(f, job) >= 2);
    assert.equal(readCloseReaped(job), undefined, 'missing proof must not be recorded as a successful reap');
    assert.match(fs.readFileSync(log, 'utf8'), /worker-tree snapshot unresolved/);
    assert.equal(procStat(child)?.start, start, 'unprovable child was left alone');
  }
  assert.equal(done.status, 1, done.stderr);
  assert.match(done.stderr, /synthetic ENOSPC in hud-progress/);
});

test('read-close: rejected CLI quit keeps closed while the watcher retries terminal reap', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 450);
  const worker = fakeCliWithChild(t, f);
  writeCliRole(f, 'cli-retry', 8);
  const job = await f.call('hud_create', { role: 'cli-retry', request_key: 'cli-retry', task: 'Synthetic cleanup retry.' });
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  fs.writeFileSync(join(f.env.HOME, 'reject-quit'), '');
  fs.writeFileSync(join(job.task_dir, 'fail-reap-once'), '');
  fs.writeFileSync(join(job.task_dir, 'reap-worker'), '');
  assert.match((await f.call('hud_read', { job: job.job })).report, /^Synthetic /);
  const log = join(f.env.HUD_HOME, 'watch.log');
  await until(() => fs.readFileSync(log, 'utf8').includes(`reap ${job.job} state=closed exit=1`));
  assert.ok(procStat(worker.pid), 'the rejected quit and failed reap did not stop the worker');
  assert.equal(readCloseReaped(job), undefined);
  assert.equal(cliState(job.task_dir).state, 'closed');
  assert.ok(readCloseQuit(f, job));
  await until(() => readCloseReaped(job));
  assert.equal(reapAttempts(f, job), 2);
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
  await until(() => !procStat(worker.pid));
});

test('read-close: CLI pre-quit snapshot failure hands cleanup to the watcher and retries', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 350);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'cli-snapshot-failure', 30);
  const job = await f.call('hud_create', { role: 'cli-snapshot-failure', request_key: 'cli-snapshot-failure', task: 'Synthetic task.' });
  await until(() => cliState(job.task_dir)?.pid === worker.pid);
  const child = await worker.start();
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'Synthetic report.\n');
  declareDone(f, job);
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  const flag = join(f.env.HOME, 'snapshot-enospc');
  fs.writeFileSync(flag, '');
  assert.match((await f.call('hud_read', { job: job.job })).report, /^Synthetic /);
  await until(() => fs.readFileSync(join(f.env.HUD_HOME, 'watch.log'), 'utf8').includes('synthetic ENOSPC'));
  assert.equal(readCloseQuit(f, job), false, 'keep the root in place for the watcher to capture');
  assert.equal(cliState(job.task_dir).state, 'closed');
  assert.equal(readCloseReaped(job), undefined);
  await until(() => !procStat(child)); // Verified descendants are cleaned even though capture cannot persist yet.
  fs.unlinkSync(flag);
  await until(() => readCloseReaped(job));
  assert.ok(reapAttempts(f, job) >= 2);
});

test('read-close: a settled Pi with a fresh report closes and reaps a current-turn child', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  const worker = fakeCliWithChild(t, f);
  await f.startCliSocket();
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-new-child', task: 'Synthetic task.' });
  const child = await worker.start();
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({
    slot: 'primary', task_dir: job.task_dir, state: 'working', pid: worker.pid, pid_start_time: procStat(worker.pid).start,
  }));
  const report = 'Synthetic native Pi tool report.\n';
  const native = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import hud from ${JSON.stringify(pathToFileURL(resolve('integrations/pi/package/extensions/hud.mjs')).href)};
    process.argv.push('--hud-worker-tools');
    const tools = new Map();
    await hud({ registerTool(tool) { tools.set(tool.name, tool); } });
    console.log(JSON.stringify(await tools.get('hud_report').execute('report', { text: ${JSON.stringify(report)} })));
  `], { env: { ...f.env, HUD_JOB_DIR: job.task_dir }, encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  const result = JSON.parse(native.stdout);
  assert.equal(result.details.path, join(job.task_dir, 'report.md'));
  assert.equal(result.terminate, true);
  assert.equal(cliState(job.task_dir).state, 'working', 'publication alone does not declare pi settlement');
  await publishPiGrace(job, worker, false); // Synthetic pi-roles native turn end.
  assert.equal((await f.call('hud_read', { job: job.job })).report, report);
  await until(() => readCloseReaped(job));
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
  await until(() => procStat(child) === null);
});

test('read-close: listing an unread report leaves the CLI grace deadline in place', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'unread-close-cli', 2);
  const job = await f.call('hud_create', { role: 'unread-close-cli', request_key: 'unread-close', task: 'Synthetic task.' });
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  const { idle_deadline_at } = cliState(job.task_dir);
  for (const args of [{}, { view: 'recent' }]) {
    assert.equal((await f.call('hud_read', args)).jobs.find((row) => row.job === job.job).report_unread, true);
  }
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(cliState(job.task_dir).state, 'idle_grace');
  assert.equal(readCloseQuit(f, job), false);
  assert.equal(readCloseReaped(job), undefined);
  await until(() => cliState(job.task_dir)?.state === 'closed');
  const closed = cliState(job.task_dir);
  assert.equal(closed.exit_reason, 'settled');
  assert.ok(Date.parse(closed.ended_at) >= Date.parse(idle_deadline_at));
  assert.ok(readCloseQuit(f, job));
  await until(() => readCloseReaped(job));
});

test('read-close: the CLI receipt survives a shell-counter change and needs no pane read', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'child-read-cli', 8, true, 'claude');
  const job = await f.call('hud_create', { role: 'child-read-cli', request_key: 'child-read-close', task: 'Synthetic task.' });
  await until(() => cliState(job.task_dir)?.pid === worker.pid);
  const child = await worker.start();
  const report = join(job.task_dir, 'report.md'), pane = join(f.env.HOME, 'pane-read');
  fs.writeFileSync(pane, `⏺ report written: ${report}\n2 shells still running\n`);
  const call = workerClient(t, f, job.task_dir);
  assert.deepEqual(resultValue(await call('hud_report', { text: 'Synthetic report.\n', turn: cliToken(job.task_dir) })), { path: report });
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  assert.ok(procStat(child));
  fs.writeFileSync(pane, `⏺ report written: ${report}\n1 shell still running\n`);
  fs.writeFileSync(join(f.env.HOME, 'pane-read-timeout'), '');
  assert.match((await f.call('hud_read', { job: job.job })).report, /^Synthetic /);
  await until(() => readCloseReaped(job));
  assert.ok(readCloseQuit(f, job));
  assert.equal(f.socketRequests.filter(({ method }) => method === 'pane.read').length, 0);
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
  await until(() => procStat(child) === null);
});

test('read-close: a live pre-turn CLI child does not block settlement or close', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  const child = await worker.start();
  writeCliRole(f, 'pre-turn-cli', 20);
  const job = await f.call('hud_create', { role: 'pre-turn-cli', request_key: 'pre-turn-read-close', task: 'Synthetic task.' });
  await until(() => cliState(job.task_dir)?.state === 'idle_grace');
  assert.match((await f.call('hud_read', { job: job.job })).report, /^Synthetic /);
  await until(() => readCloseReaped(job));
  assert.equal(cliState(job.task_dir).exit_reason, 'closed after report read');
  assert.ok(readCloseQuit(f, job));
  await until(() => procStat(child) === null);
});

test('supervisor events: renewed idle and stale scrollback do not settle a draft with an in-turn child', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'background-events', 4);
  const job = await f.call('hud_create', { role: 'background-events', request_key: 'background-events', task: 'Synthetic background work.' });
  await until(() => cliState(job.task_dir)?.pid === worker.pid && cliState(job.task_dir)?.agent_session_id);
  assert.equal(cliState(job.task_dir).pid_start_time, procStat(worker.pid).start);
  const child = await worker.start();
  const report = join(job.task_dir, 'report.md');
  const marker = `⏺ report written: ${report}\n`;
  f.push(job.job, 'idle');
  fs.writeFileSync(join(f.env.HOME, 'pane-read'), marker.repeat(2));
  fs.writeFileSync(report, 'Report while tests finish.\n');
  fs.writeFileSync(join(f.env.HOME, 'pane-read'), marker);
  const queries = statusQueries(f, job);
  await until(() => statusQueries(f, job) >= queries + 2);
  assert.ok(procStat(child));
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).output_written, false);
});

async function fakeMcpBootstrap(f, worker, generic = false) {
  const files = Object.fromEntries(['launch', 'ready', 'pids', 'start-work', 'work-pid'].map((key) => [key, join(f.root, key)]));
  const spec = generic ? '@synthetic/mcp-demo' : 'chrome-devtools-mcp@1.11.0';
  const entry = generic ? 'demo-mcp' : 'chrome-devtools-mcp';
  const bin = join(f.root, generic ? 'node_modules/.bin' : 'bin');
  const watchdog = join(f.root, 'node_modules/chrome-devtools-mcp/build/src/telemetry/watchdog/main.js');
  if (!generic) {
    fs.mkdirSync(join(watchdog, '..'), { recursive: true });
    fs.writeFileSync(watchdog, 'setTimeout(() => {}, 30000)');
  }
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(join(bin, entry), `#!${process.execPath}
const { spawn } = require('node:child_process');
const fs = require('node:fs'), files = ${JSON.stringify(files)};
const pids = [process.ppid, process.pid];
${generic ? '' : `process.title = 'chrome-devtools-mcp';
pids.push(spawn(process.execPath, [${JSON.stringify(watchdog)}, '--parent-pid', String(process.pid)], { stdio: 'ignore' }).pid);`}
fs.writeFileSync(files.pids, JSON.stringify(pids));
setInterval(() => {
  if (!fs.existsSync(files['start-work']) || fs.existsSync(files['work-pid'])) return;
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  fs.writeFileSync(files['work-pid'], String(child.pid));
}, 10);
`, { mode: 0o700 });
  const launcher = await worker.start(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs'), files = ${JSON.stringify(files)};
    process.title = ${JSON.stringify(`npm exec ${spec}`)};
    fs.writeFileSync(files.ready, '');
    const poll = setInterval(() => {
      if (!fs.existsSync(files.launch)) return;
      clearInterval(poll);
      // As npm exec does: the bin name single-quoted (seen live 2026-11-18: sh -c 'playwright-mcp').
      spawn('/bin/sh', ['-c', ${JSON.stringify(`'${entry}'`)}], {
        stdio: 'ignore', env: { ...process.env, PATH: ${JSON.stringify(bin + ':')} + process.env.PATH },
      });
    }, 10);
  `], true);
  await until(() => fs.existsSync(files.ready));
  return {
    async launch() {
      fs.writeFileSync(files.launch, '');
      await until(() => fs.existsSync(files.pids) && fs.statSync(files.pids).size > 0);
      const pids = JSON.parse(fs.readFileSync(files.pids, 'utf8'));
      const [shell, server, watchdogPid] = pids;
      assert.equal(procStat(shell)?.ppid, launcher);
      assert.equal(procStat(server)?.ppid, shell);
      if (generic) assert.equal(fs.readFileSync(`/proc/${server}/cmdline`, 'utf8').split('\0')[1], join(bin, entry));
      else assert.equal(procStat(watchdogPid)?.ppid, server);
      return [launcher, ...pids];
    },
    async work() {
      fs.writeFileSync(files['start-work'], '');
      await until(() => fs.existsSync(files['work-pid']) && fs.statSync(files['work-pid']).size > 0);
      return Number(fs.readFileSync(files['work-pid'], 'utf8'));
    },
  };
}

for (const scenario of ['bootstrap only', 'generic package', 'no report', 'direct sleep', 'sleep under old MCP server', 'same-named runner']) {
  test(`supervisor MCP bootstrap: ${scenario}`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    const worker = fakeCliWithChild(t, f);
    const mcp = await fakeMcpBootstrap(f, worker, scenario === 'generic package');
    fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
    writeCliRole(f, 'mcp-bootstrap', 8);
    const job = await f.call('hud_create', { role: 'mcp-bootstrap', request_key: scenario, task: 'Synthetic task.' });
    const dir = job.task_dir, report = join(dir, 'report.md');
    await until(() => cliState(dir)?.pid === worker.pid && cliState(dir)?.agent_session_id);
    assert.equal((await f.call('hud_read')).jobs.find((row) => row.job === job.job).state, 'working');
    const pids = await mcp.launch();
    assert.ok(Number(procStat(pids[1]).start) > Number(procStat(pids[0]).start));
    if (scenario === 'no report') {
      f.push(job.job, 'idle');
      await until(() => cliState(dir)?.state === 'waiting_orchestrator');
      assert.match(cliState(dir).reason, /quiet without a report/);
      assert.equal(readCloseQuit(f, job), false);
      return;
    }
    // Exercise non-shell work on a continuation, where no direct child gets a launch exemption.
    if (['sleep under old MCP server', 'direct sleep', 'same-named runner'].includes(scenario)) {
      fs.writeFileSync(report, 'First synthetic report.\n');
      f.push(job.job, 'idle');
      await until(() => cliState(dir)?.state === 'idle_grace');
      assert.equal((await f.call('hud_send', { job: job.job, message_key: 'repair', text: 'Synthetic continuation.' })).sent, true);
    }
    let work;
    if (scenario === 'sleep under old MCP server') {
      work = await mcp.work();
      assert.equal(procStat(work)?.ppid, pids[2]);
    } else if (scenario === 'direct sleep') work = await worker.start('sleep', ['30']);
    else if (scenario === 'same-named runner') work = await worker.start(process.execPath, ['-e',
      `process.title = 'chrome-devtools-mcp'; setTimeout(() => {}, 30000);`]);
    if (work) {
      const reads = () => f.commands().filter((c) => c.command === 'herdr' && c.args[0] === 'pane' && c.args[1] === 'read').length;
      const before = reads(), queries = statusQueries(f, job);
      f.push(job.job, 'working'); f.push(job.job, 'idle');
      await until(() => statusQueries(f, job) > queries);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(reads(), before, 'no quiet decision while the worker has a live child');
      assert.equal(cliState(dir).state, 'working');
    }
    fs.writeFileSync(report, 'Synthetic fresh report with MCP infrastructure still alive.\n');
    f.push(job.job, 'idle');
    if (work) {
      assert.match((await f.call('hud_read', { job: job.job })).report, /Synthetic fresh report/);
      assert.ok(procStat(work));
      declareDone(f, job);
    } else {
      await until(() => cliState(dir)?.state === 'idle_grace');
      const listing = await f.call('hud_read');
      assert.match(listing.changes.find((line) => line.startsWith(job.job)), /: idle_grace \| report/);
      assert.equal(cliState(dir).output_written, true);
      assert.match((await f.call('hud_read', { job: job.job })).report, /Synthetic fresh report/);
    }
    await until(() => cliState(dir)?.state === 'closed', 1700);
    assert.equal(cliState(dir).exit_reason, 'closed after report read');
    assert.equal(cliState(dir).output_written, true);
    assert.match((await f.call('hud_read')).changes.find((line) => line.startsWith(job.job)), /: closed/);
    await until(() => readCloseReaped(job));
    assert.ok([...pids, ...(work ? [work] : [])].every((pid) => !procStat(pid) || procStat(pid)?.state === 'Z'),
      'cleanup reaps both bootstrap helpers and turn work');
  });
}

test('supervisor events: 60s at rest means zero spawns and zero STATUS writes; socket loss stays working', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'rest-events', 10);
  const job = await f.call('hud_create', { role: 'rest-events', request_key: 'rest-events', task: 'Synthetic rest.' });
  await until(() => cliState(job.task_dir)?.agent_session_id);
  await new Promise((r) => setTimeout(r, 100));
  const writes = fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8');
  const commands = f.commands().length, requests = f.socketRequests.length;
  for (let i = 0; i < 6; i++) {
    f.push(job.job, i % 2 ? 'working' : 'done');
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8'), writes, 'no-report status flaps do not write STATUS');
  assert.equal(fs.existsSync(join(f.env.HOME, 'proc-scans')), false, 'flaps never sample descendants');
  await new Promise((r) => setTimeout(r, 3100)); // >60 virtual seconds, two real safety ticks
  assert.equal(f.commands().length, commands);
  // Each safety tick re-reads the status once, so a missed push cannot hold a job; nothing else is asked at rest.
  const extra = f.socketRequests.slice(requests);
  assert.ok(extra.length >= 1 && extra.length <= 3, JSON.stringify(extra));
  assert.ok(extra.every((r) => r.method === 'agent.get'), JSON.stringify(extra));
  assert.equal(fs.existsSync(join(f.env.HOME, 'proc-scans')), false, 'working ticks never sample descendants');
  assert.equal(fs.readFileSync(join(f.env.HOME, 'status-writes'), 'utf8'), writes);
  assert.equal(cliState(job.task_dir).state, 'working');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  f.drop();
  await new Promise((r) => setTimeout(r, 3100));
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).error, null);
  assert.equal(f.commands().length, commands);
});

test('supervisor edges: stalled submission stays supervised; pre-input rejection closes its tab', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  fs.writeFileSync(join(f.env.HOME, 'stalled-prompt'), '');
  const live = await f.call('hud_create', { role: 'imp', on: 'agy', request_key: 'stalled', task: 'Synthetic stall.' });
  assert.notEqual(live.ok, false);
  await until(() => cliState(live.task_dir)?.state === 'working');
  assert.equal(JSON.parse(fs.readFileSync(join(live.task_dir, 'turn.json'))).seq, 1);
  assert.ok(fs.existsSync(join(live.task_dir, 'supervisor.pid')));
  assert.equal(f.commands().some((c) => c.args[0] === 'tab' && c.args[1] === 'close'), false);
  fs.unlinkSync(join(f.env.HOME, 'stalled-prompt'));
  fs.writeFileSync(join(f.env.HOME, 'rejected-prompt'), '');
  const rejected = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'rejected', task: 'Synthetic rejection.' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'dispatch_failed');
  assert.equal(fs.existsSync(join(rejected.task_dir, 'supervisor.pid')), false);
  assert.ok(f.commands().some((c) => c.args[0] === 'tab' && c.args[1] === 'close'));
});

test('supervisor edges: outage with a report settles at 60s, PID death closes with report or fails without quota scans', { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'outage-events', 10);
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => worker.kill('SIGKILL'));
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(worker.pid));
  const job = await f.call('hud_create', { role: 'outage-events', request_key: 'outage-report', task: 'Synthetic outage.' });
  await until(() => cliState(job.task_dir)?.pid === worker.pid);
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'Report survives a socket outage.\n');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  f.drop();
  await until(() => cliState(job.task_dir)?.state === 'idle_grace', 5000);
  assert.equal(cliState(job.task_dir).output_written, true);
  worker.kill('SIGKILL');
  await until(() => cliState(job.task_dir)?.state === 'closed', 3000);
  assert.equal(cliState(job.task_dir).exit_reason, 'settled');
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));
  const worker2 = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => worker2.kill('SIGKILL'));
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(worker2.pid));
  const failed = await f.call('hud_create', { role: 'outage-events', request_key: 'no-report-death', task: 'Task text says quota but that is not a quota fact.' });
  await until(() => cliState(failed.task_dir)?.pid === worker2.pid);
  fs.writeFileSync(join(f.env.HOME, 'pane-read'), 'quota exceeded');
  worker2.kill('SIGKILL');
  await until(() => cliState(failed.task_dir)?.state === 'failed', 3000);
  assert.equal(cliState(failed.task_dir).exit_reason, 'worker exited');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
  assert.equal(f.commands().filter((c) => c.args[0] === 'pane' && c.args[1] === 'read').length, 2, 'only the two dispatch trust reads, no exit scan');
});

test('worktree isolation validates before dispatch, links dependencies and carries only the selected CLI grant', async (t) => {
  const f = await fixture(t), cwd = initRepo(f.root);
  fs.chmodSync(f.env.HUD_HOME, 0o700); // Trust backups require a private HUD home.
  const args = { role: 'imp', task: 'Synthetic task.', request_key: 'isolated', isolation: 'worktree', package: 'Demo Slice' };
  assert.equal((await f.call('hud_create', { ...args, on: 'pi', cwd: f.root })).code, 'invalid_arguments');
  assert.equal((await f.call('hud_create', { ...args, on: 'chatgpt', cwd })).code, 'invalid_arguments');
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
  assert.ok(!fs.existsSync(join(f.env.HUD_HOME, 'jobs')));
  assert.ok(!fs.existsSync(join(f.root, 'demo-wt')));

  fs.mkdirSync(join(cwd, 'node_modules'));
  const trust = join(f.env.HOME, '.grok', 'trusted_folders.toml');
  const original = fs.readFileSync(trust, 'utf8');
  const claudeFile = join(f.env.CLAUDE_CONFIG_DIR, '.claude.json');
  const claude = fs.readFileSync(claudeFile, 'utf8');
  assert.equal((await f.call('hud_create', { ...args, request_key: 'isolated-untrusted', on: 'grok', cwd })).code, 'untrusted_cwd');
  assert.equal(fs.readFileSync(trust, 'utf8'), original);
  assert.ok(!fs.existsSync(join(f.root, 'demo-wt')));
  fs.appendFileSync(trust, `\n[folders.${JSON.stringify(cwd)}]\ntrusted = true\n`);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const create = { ...args, on: 'grok', cwd };
  const job = await f.call('hud_create', create);
  const name = `demo-slice-${job.job.slice(-6)}`, root = join(f.root, 'demo-wt', name);
  const branch = `wt/${name}`, base_head = git(cwd, 'rev-parse', 'HEAD');
  const record = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  assert.equal(record.dispatch_exit_code, 0, record.stderr_tail);
  assert.deepEqual(record.worktree, { main_root: cwd, root, branch, base_head });
  assert.equal(record.cwd, root);
  assert.equal(git(root, 'branch', '--show-current'), branch);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base_head);
  assert.equal(fs.readlinkSync(join(root, 'node_modules')), join(cwd, 'node_modules'));
  assert.ok(fs.readFileSync(trust, 'utf8').includes(`[folders.${JSON.stringify(root)}]`));
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), claude);
  assert.equal((await f.call('hud_create', create)).job, job.job);
  assert.deepEqual(fs.readdirSync(join(f.root, 'demo-wt')), [name]);
  const tabs = f.commands().filter(({ args }) => args[0] === 'tab' && args[1] === 'create');
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].args[tabs[0].args.indexOf('--cwd') + 1], root);
  const project = await new ProjectCollector(cwd, f.env.HUD_HOME, f.env).collect(true, { workers: [] }, Date.now());
  assert.equal(project.slices.find((s) => s.label === name)?.jobId, job.job);
  assert.equal(project.slices.find((s) => s.label === name).drift, undefined);
});

test('only a one-job read includes a bounded summary of committed and pending worktree changes', async (t) => {
  const f = await fixture(t), cwd = initRepo(f.root);
  fs.mkdirSync(join(cwd, 'node_modules'));
  const job = await f.call('hud_create', { role: 'imp', on: 'pi', cwd, isolation: 'worktree', request_key: 'summary', task: 'Synthetic task.' });
  const { worktree: { root, branch, base_head } } = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  fs.writeFileSync(join(root, 'tracked.txt'), 'changed\n');
  git(root, 'commit', '-qam', 'tracked change');
  fs.appendFileSync(join(root, 'tracked.txt'), 'pending\n');
  fs.writeFileSync(join(root, 'new.txt'), 'untracked\n');
  const head = git(root, 'rev-parse', 'HEAD');
  const read = await f.call('hud_read', { job: job.job });
  assert.equal(read.worktree.root, root);
  assert.deepEqual(read.git_summary, { branch, base_head, head, ahead_commits: 1, changed_files: 2, dirty: true });
  for (const result of [await f.call('hud_read'), await f.call('hud_read', { view: 'recent' }),
    await f.call('hud_wait', { jobs: [job.job], wait_ms: 0 })]) {
    assert.doesNotMatch(JSON.stringify(result), /git_summary/);
  }
});

test('pi role tools match the real MCP tools/list', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(PI_ROLE_TOOLS, (await f.rpc('tools/list')).result.tools.filter(({ name }) => name !== 'hud_statusline'));
});

const statuslineState = 'com.openai/codex-statusline-state';
const footerUri = 'ui://myhud/codex-statusline';
const footerMime = 'application/json';
async function readFooter(f, state) {
  const params = { uri: footerUri, ...(state === undefined ? {} : { _meta: { [statuslineState]: state } }) };
  const reply = await f.rpc('resources/read', params);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.contents.length, 1);
  const [{ uri, mimeType, text }] = reply.result.contents;
  assert.equal(uri, footerUri);
  assert.equal(mimeType, footerMime);
  const tree = JSON.parse(text);
  assert.equal(tree.type, 'row');
  assert.deepEqual(tree.props, { gap: 2, wrap: 'nowrap' });
  return tree;
}
const footerText = (tree) => tree.children.map((node) => node.children.join(''));
const windowOf = (minutes, used, resetsAt = null) => ({ used_percent: used, window_minutes: minutes, resets_at: resetsAt });

test('Codex native footer discovers MyHUD and serves ordered, request-local facts with no width', { timeout: 8000 }, async (t) => {
  const f = await fixture(t, true, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const readdir = fs.readdirSync;
    fs.readdirSync = (path, ...args) => {
      if (fs.existsSync(process.env.HOME + '/footer-reads') && /\\/(jobs|sessions)(\\/|$)/.test(String(path))) {
        fs.appendFileSync(process.env.HOME + '/footer-scans', String(path) + '\\n');
      }
      return readdir(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  const initialized = await f.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.deepEqual(initialized.result.capabilities.resources, {});
  const { result: { tools } } = await f.rpc('tools/list');
  const providers = tools.filter((tool) => tool._meta?.['openai/ui']?.entrypoints);
  assert.deepEqual(providers.map(({ title, _meta }) => [title, _meta['openai/ui'].entrypoints]), [
    ['MyHUD', [{ type: 'statusline', resourceUri: footerUri }]],
  ]);
  assert.deepEqual((await f.rpc('resources/list')).result.resources, [
    { uri: footerUri, name: 'codex-statusline', mimeType: footerMime },
  ]);
  assert.equal((await f.rpc('resources/read', { uri: 'ui://other/footer' })).error.code, -32002);
  assert.equal((await f.rpc('resources/read')).error.code, -32602);

  const now = Date.now();
  const pendingJob = (id, pane, role) => {
    const dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: id, role, herdr_pane: pane, created_at: new Date(now) }));
    const file = join(dir, 'STATUS.json');
    fs.writeFileSync(file, JSON.stringify({ state: 'waiting_orchestrator', harness: 'cli', blocked: true }));
    return file;
  };
  const current = pendingJob('j0000000000000001', 'w4E:p1', 'imp');
  pendingJob('j0000000000000002', 'w4E:p2', 'other');
  readThinJobs(f.env.HUD_HOME, { project: null, pane: 'w4E:p1' }, JSON.parse, {});
  fs.writeFileSync(join(f.env.HOME, 'footer-reads'), '');

  const a = {
    config: { profile: 'synthetic-a' },
    thread: { id: 'synthetic-thread-a', model: { id: 'openai/gpt-6.2-sol', reasoning_level: 'high' },
      usage: { context: { used_percentage: 38 } } },
    account: { rate_limits: [
      { limit_id: 'other-bucket', primary_limit: windowOf(1, 99) },
      { limit_id: 'codex', primary_limit: windowOf(300, 28), secondary_limit: windowOf(10080, 44) },
    ] },
  };
  const b = {
    config: { profile: 'synthetic-b' },
    thread: { id: 'synthetic-thread-b', model: { display_name: 'Example B' },
      usage: { context: { used_tokens: 12, context_window_size: 100 } } },
    account: { rate_limits: [
      { limit_id: 'codex', primary_limit: windowOf(300, 115), secondary_limit: windowOf(10080, 99, 1) },
    ] },
  };
  const ordered = ['6.2-sol high', 'ctx 38%', '5h 72% left', '7d 56% left', 'HUD: imp asks'];
  assert.deepEqual(footerText(await readFooter(f, a)), ordered);
  assert.deepEqual(footerText(await readFooter(f, b)), ['Example B', 'ctx 12%', '5h 0% left', 'HUD: imp asks']);
  assert.deepEqual(footerText(await readFooter(f, a)), ordered);
  assert.deepEqual(footerText(await readFooter(f, {
    thread: { model: { id: null, display_name: null }, usage: { context: { used_percentage: -1 } } },
    account: { rate_limits: [{ limit_id: 'codex', primary_limit: windowOf(null, 9) }] },
  })), ['HUD: imp asks']);

  // Time across stdio with a warmed jobs cache and EXP enabled, including the first last-seen write.
  const exp = join(f.env.HUD_HOME, 'exp');
  fs.mkdirSync(exp);
  fs.writeFileSync(join(exp, 'config.json'), JSON.stringify({ version: 1, codex: { enabled: true } }));
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ experiments: true }));
  for (let batch = 0; batch < 3; batch++) {
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      await readFooter(f, a);
      samples.push(performance.now() - start);
    }
    samples.sort((x, y) => x - y);
    const stats = [15, 29, 30].map((rank) => samples[rank - 1].toFixed(3)).join('/');
    t.diagnostic(`footer stdio n=30 p50/p95/p99=max ${stats} ms`);
    assert.ok(samples.at(-1) < 250, `footer RPC too slow: ${stats} ms`);
  }
  fs.writeFileSync(current, JSON.stringify({ state: 'done', output_written: true }));
  assert.deepEqual(footerText(await readFooter(f)), [], 'no cached facts from another pane or stale STATUS');
  assert.equal(fs.existsSync(join(f.env.HOME, 'footer-scans')), false);
  assert.deepEqual(f.commands(), []);
  assert.deepEqual(f.socketRequests, []);
});

test('Codex footer last-seen is opt-in, private, throttled and reaches only its canonical local EXP profile', { timeout: 8000 }, async (t) => {
  const f = await fixture(t, false, `
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    process.env.CODEX_HOME = join(process.env.HOME, '.codex-link');
    const now = Date.now;
    Date.now = () => {
      try { return Number(readFileSync(join(process.env.HOME, 'footer-clock'), 'utf8')); }
      catch { return now(); }
    };
  `);
  const exp = join(f.env.HUD_HOME, 'exp');
  const own = join(f.env.HOME, '.codex-local'), other = join(f.env.HOME, '.codex-other');
  for (const dir of [own, other]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(join(dir, 'config.toml'), '# synthetic\n');
  }
  fs.symlinkSync(own, join(f.env.HOME, '.codex-link'));
  const seen = expNativePath(f.env.HUD_HOME, fs.realpathSync(own));
  const clock = (now) => fs.writeFileSync(join(f.env.HOME, 'footer-clock'), String(now));
  const config = (enabled) => {
    const data = defaultExpConfig();
    data.codex.enabled = enabled;
    data.proxy.profile = other;
    data.codex.aliases[fs.realpathSync(own)] = 'Local';
    fs.writeFileSync(join(exp, 'config.json'), JSON.stringify(data));
  };
  const master = (experiments) => fs.writeFileSync(join(f.env.HUD_HOME, 'hud-settings.json'), JSON.stringify({ experiments }));
  const state = { config: { profile: other }, thread: { model: { display_name: 'Example' } } };
  const firstAt = 1_768_000_000_000;
  clock(firstAt);
  master(true);
  assert.deepEqual(footerText(await readFooter(f, state)), ['Example']);
  assert.equal(fs.existsSync(exp), false);
  fs.mkdirSync(exp);
  config(false);
  await readFooter(f, state);
  assert.equal(fs.existsSync(seen), false);
  config(true);
  master(false);
  await readFooter(f, state);
  assert.equal(fs.existsSync(seen), false);
  master(true);

  await readFooter(f);
  assert.equal(fs.existsSync(seen), false, 'a discovery read without statusline state is not a native observation');
  await readFooter(f, state);
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), { version: 1, lastSeenAt: firstAt });
  const first = fs.statSync(seen);
  assert.equal(first.mode & 0o777, 0o600);
  clock(firstAt + 59_999);
  await readFooter(f, state);
  assert.equal(fs.statSync(seen).ino, first.ino);
  clock(firstAt + 60_000);
  await readFooter(f, state);
  const second = fs.statSync(seen);
  assert.notEqual(second.ino, first.ino, 'update atomically replaces the file');
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), { version: 1, lastSeenAt: firstAt + 60_000 });
  master(false);
  clock(firstAt + 120_000);
  await readFooter(f, state);
  assert.equal(fs.statSync(seen).ino, second.ino);
  assert.deepEqual(fs.readdirSync(exp).sort(), [basename(seen), 'config.json']);
  const expData = readExpData(f.env.HUD_HOME, f.env, firstAt + 120_000);
  assert.deepEqual(expData.profiles.map(({ home, lastNativeSeenAt }) => [home, lastNativeSeenAt]), [
    [fs.realpathSync(own), firstAt + 60_000], [fs.realpathSync(other), undefined],
  ]);
  const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(0) };
  const frame = renderMonitor({ tree, state: { ...initialMonitorState(), experiments: true, mainTab: 'exp' },
    expData, width: 40, height: 24, nowMs: firstAt + 120_000 });
  const date = new Date(firstAt + 60_000).toISOString().slice(5, 16).replace('T', ' ');
  const lines = frame.lines.map((line) => stripAnsi(line).trimEnd()).join('\n');
  assert.ok(frame.lines.every((line) => visualLength(line) === 40));
  assert.match(lines, /Track native status line +on/);
  assert.match(lines, new RegExp(`^  Local \\(\\.codex-link\\) +seen ${date}$`, 'm'));
  assert.match(lines, /^  \.codex-other +bar not seen yet$/m);
  assert.equal(fs.readFileSync(join(own, 'config.toml'), 'utf8'), '# synthetic\n');
  assert.equal(fs.readFileSync(join(other, 'config.toml'), 'utf8'), '# synthetic\n');
});

const fallbackPlaces = [
  { harness: 'cli', agent: 'grok', model: 'synthetic-first' },
  { harness: 'pi', pi_role: 'implementer', model: 'synthetic/second' },
];
function fallbackRole(f, role, run = fallbackPlaces, presets) {
  const root = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(join(root, `${role}.json`), JSON.stringify({ role, instructions: 'implementer', can_continue: false, run, presets }));
}

test('hud_create closes a pre-input failure and starts the next place in the same job', async (t) => {
  const f = await fixture(t);
  fallbackRole(f, 'fallback-check');
  const reason = 'rate limit reached; retry after 5m';
  fs.writeFileSync(join(f.env.HOME, 'fail-start-grok'), reason);
  const job = await f.call('hud_create', { role: 'fallback-check', request_key: 'fallback', task: 'Synthetic fallback.' });
  assert.equal(job.state, 'working');
  assert.deepEqual(job.attempts, [
    { index: 0, place: 'cli/grok (synthetic-first)', reason },
    { index: 1, place: 'pi (synthetic/second)' },
  ]);
  assert.equal(job.used_place, 'pi (synthetic/second)');
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')), [job.job]);
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  assert.deepEqual(receipt.attempts, job.attempts);
  assert.equal(receipt.cli, undefined);
  const launches = f.commands().filter(({ args }) =>
    (args[0] === 'agent' && args[1] === 'start') || (args[0] === 'tab' && args[1] === 'close'));
  assert.deepEqual(launches.map(({ args }) => [args[1], args[2]]), [
    ['start', `${job.job}-primary`], ['close', 'w4E:t2'], ['start', `${job.job}-primary`],
  ]);
  const exhausted = JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'exhausted.json'))).places;
  assert.deepEqual(Object.keys(exhausted), ['cli:grok:synthetic-first']);
  assert.equal(exhausted['cli:grok:synthetic-first'].reason, reason);
});

test('hud_create retry_of reuses a failed job brief and options on an available place', async (t) => {
  const f = await fixture(t);
  const places = ['synthetic/primary', 'synthetic/fallback'].map((model) => ({ harness: 'pi', pi_role: 'implementer', model }));
  fallbackRole(f, 'retry-check', places, [{ name: 'two', run: places }]);
  const cwd = join(f.root, 'retry-project');
  fs.mkdirSync(cwd);
  fs.writeFileSync(join(cwd, 'notes.md'), 'Synthetic notes.');
  const original = await f.call('hud_create', {
    role: 'retry-check', preset: 'two', cwd, task: 'Synthetic task: 重试.\n\n', context_files: ['notes.md'], tps: false, checks: ['true'],
  });
  const statusFile = join(original.task_dir, 'STATUS.json');
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'failed', exit_reason: 'rate limit reached; retry after 5m' }));
  const retry = { retry_of: original.job };
  const next = await f.call('hud_create', retry);
  assert.notEqual(next.job, original.job);
  assert.equal(next.used_place, 'pi (synthetic/fallback)');
  assert.equal(next.role, original.role);
  assert.equal(fs.readFileSync(join(next.task_dir, 'brief.md'), 'utf8'), fs.readFileSync(join(original.task_dir, 'brief.md'), 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(join(next.task_dir, 'job.json'), 'utf8'));
  assert.equal(receipt.cwd, cwd);
  assert.equal(receipt.preset, 'two');
  assert.equal(receipt.tps, false);
  assert.deepEqual(receipt.checks, ['true']);
  assert.equal((await f.call('hud_create', retry)).job, next.job);
});

test('hud_create retains every pre-input cause on one failed job and stays within the requested preset', async (t) => {
  const f = await fixture(t);
  fallbackRole(f, 'fallback-check', [{ harness: 'cli', agent: 'codex' }], [{ name: 'two', run: fallbackPlaces }]);
  const cwd = join(f.root, 'untrusted');
  fs.mkdirSync(cwd);
  const trust = `grok has not trusted ${cwd}; run hud trust ${cwd}`;
  fs.writeFileSync(join(f.env.HOME, 'fail-start-pi'), 'synthetic Pi launcher failure');
  const args = { role: 'fallback-check', preset: 'two', request_key: 'all-fail', task: 'Synthetic fallback.', cwd };
  const job = await f.call('hud_create', args);
  assert.equal(job.ok, false);
  assert.equal(job.state, 'failed');
  assert.equal(job.used_place, null);
  assert.deepEqual(job.attempts, [
    { index: 0, place: 'cli/grok (synthetic-first)', reason: trust },
    { index: 1, place: 'pi (synthetic/second)', reason: 'synthetic Pi launcher failure' },
  ]);
  assert.ok(job.reason.includes(trust) && job.reason.includes('synthetic Pi launcher failure'));
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')), [job.job]);
  assert.deepEqual(await f.call('hud_create', args), withoutHint(job));
  assert.equal(f.commands().filter(({ args }) => args[0] === 'agent' && args[1] === 'start').length, 1);
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
});

test('worker MCP resolves its non-default HUD home and starts sonic with fallback without HUD_HOME', async (t) => {
  const f = await fixture(t);
  const parent = await f.call('hud_create', { role: 'imp', request_key: 'no-home-parent', task: 'Synthetic parent.' });
  const call = workerClient(t, { ...f, env: { ...f.env, HUD_HOME: undefined } }, parent.task_dir);
  assert.equal(resultValue(await call('hud_progress', { message: 'Synthetic milestone.' })).ok, true);
  assert.match(fs.readFileSync(join(parent.task_dir, 'progress.jsonl'), 'utf8'), /Synthetic milestone/);
  fallbackRole(f, 'sonic');
  fs.writeFileSync(join(f.env.HOME, 'fail-start-grok'), 'synthetic sonic startup failure');
  const sonic = resultValue(await call('hud_sonic', { task: 'Synthetic child.' }));
  assert.deepEqual(sonic.attempts, [
    { index: 0, place: 'cli/grok (synthetic-first)', reason: 'synthetic sonic startup failure' },
    { index: 1, place: 'pi (synthetic/second)' },
  ]);
  assert.equal(sonic.used_place, 'pi (synthetic/second)');
  assert.deepEqual(fs.readdirSync(join(parent.task_dir, '.sonic')), [sonic.job]);
  const child = join(f.env.HUD_HOME, 'jobs', sonic.job);
  assert.equal(JSON.parse(fs.readFileSync(join(child, 'job.json'))).parent_job, parent.job);
  assert.equal(cliState(child).state, 'working');
});

test('working worker STATUS survives a nonzero prompt result', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'fail-prompt'), '');
  const job = await f.call('hud_create', { role: 'imp', request_key: 'prompt-timeout', task: 'Synthetic task.' });
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  assert.equal(receipt.dispatch_exit_code, 1);
  assert.match(receipt.stderr_tail, /synthetic prompt timeout/);
  assert.equal(job.attempts.length, 1, 'uncertain input must not be retried on another place');
  assert.equal(
    fs.readFileSync(join(job.task_dir, 'STATUS.json'), 'utf8'),
    JSON.stringify({ state: 'working', exit_reason: null })
  );
  assert.equal((await f.call('hud_read', { job: job.job })).state, 'working');
});

test('startup failure closes the tab, reports the pi-roles cause instead of the timeout, and is reaped', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'fail-start'), 'timed out waiting for agent startup');
  fs.writeFileSync(join(f.env.HOME, 'pane-read'), '[roles] synthetic start failed: unsupported thinking\n');
  const job = await f.call('hud_create', { role: 'imp', on: 'pi', request_key: 'failed-launch', task: 'Synthetic task.' });
  assert.equal(job.ok, false);
  assert.equal(job.code, 'dispatch_failed');
  assert.match(job.reason, /synthetic start failed/);
  const status = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json')));
  assert.equal(status.state, 'failed');
  assert.match(status.exit_reason, /synthetic start failed/);
  assert.ok(Number.isFinite(Date.parse(status.ended_at)));
  assert.match(cardText(workerFor(f, job.job)), /synthetic start failed/);
  assert.deepEqual(f.commands().find(({ args }) => args[0] === 'tab' && args[1] === 'close')?.args,
    ['tab', 'close', 'w4E:t2']);
  assert.equal(f.commands().some(({ args }) => args[0] === 'agent' && args[1] === 'prompt'), false);
  await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
  assert.ok(f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir));
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
});

test('stopped jobs read immediately, render neutral and are terminal to the watcher', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', { role: 'imp', request_key: 'stopped', task: 'Synthetic stop.' });
  fs.writeFileSync(
    join(job.task_dir, 'STATUS.json'),
    JSON.stringify({ state: 'stopped', ended_at: new Date().toISOString() })
  );
  assert.equal((await f.call('hud_read', { job: job.job, wait_ms: 120000 })).state, 'stopped');
  const worker = workerFor(f, job.job);
  assert.equal(worker.state, 'stopped');
  assert.equal(worker.work.failed, false);
  assert.equal(projectWorkCard(worker, Date.now()).state, 'done');
  assert.equal(workStateInk(projectWorkCard(worker, Date.now())), theme.board.muted);
  assert.match(cardText(worker), /stopped/);
  await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
});

test('failed STATUS uses its mtime when ended_at is absent or invalid', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  for (const ended_at of [undefined, 'not-a-date']) {
    const job = await f.call('hud_create', { role: 'imp', request_key: String(ended_at), task: 'Synthetic task.' });
    const file = join(job.task_dir, 'STATUS.json');
    fs.writeFileSync(file, JSON.stringify({ state: 'failed', ended_at }));
    const mtime = fs.statSync(file).mtimeMs;
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at, undefined);
    assert.ok(fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
    await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
    assert.ok(Date.parse(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at) >= mtime + 999);
  }
});

test('watcher subscribes to herdr and fails only a nonfinal job whose tab closes', { timeout: 7000 }, async (t) => {
  const f = await fixture(t);
  let socket, request;
  const server = createServer((client) => {
    socket = client;
    createInterface({ input: client }).on('line', (line) => {
      request = JSON.parse(line);
      client.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
    });
  });
  t.after(() => {
    socket?.destroy();
    server.close();
  });
  server.listen(f.env.HERDR_SOCKET_PATH);
  await once(server, 'listening');
  const job = await f.call('hud_create', { role: 'imp', request_key: 'tab-close', task: 'Synthetic task.' });
  await until(() => request);
  assert.equal(request.method, 'events.subscribe');
  assert.deepEqual(request.params, { subscriptions: [{ type: 'tab.closed' }] });
  const statusFile = join(job.task_dir, 'STATUS.json');
  const emit = (tab_id) =>
    socket.write(
      JSON.stringify({
        event: 'tab.closed',
        data: {
          type: 'tab_closed',
          tab_id,
          workspace_id: 'w4E',
        },
      }) + '\n'
    );
  emit('foreign-tab');
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(JSON.parse(fs.readFileSync(statusFile)).state, 'working');
  const finalDir = join(f.env.HUD_HOME, 'jobs', 'j0000000000000000');
  fs.mkdirSync(finalDir);
  fs.writeFileSync(join(finalDir, 'SESSION.txt'), 'TAB=w4E:t2\n');
  fs.writeFileSync(
    join(finalDir, 'STATUS.json'),
    JSON.stringify({ state: 'failed', exit_reason: 'original', ended_at: new Date().toISOString() })
  );
  emit('w4E:t2');
  await until(() => JSON.parse(fs.readFileSync(statusFile)).state === 'failed');
  assert.equal(JSON.parse(fs.readFileSync(statusFile)).exit_reason, 'tab closed');
  assert.equal(JSON.parse(fs.readFileSync(join(finalDir, 'STATUS.json'))).exit_reason, 'original');
  await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));
  assert.ok(f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir));
  assert.ok(!f.commands().some((c) => c.command === 'herdr' && c.args[1] === 'get' && c.args[2] !== 'w4E:p1'));
});

test('thin watcher catches up without a new file event and exits', { timeout: 5000 }, async (t) => {
  const f = await fixture(t),
    dir = join(f.env.HUD_HOME, 'jobs', 'j0000000000000000');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: 'j0000000000000000' }));
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'TAB=synthetic-catchup\n');
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], {
    env: f.env,
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  await until(() => f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === dir));
  await exited;
  assert.equal(child.exitCode, 0);
});

test(
  'thin watcher starts once, catches up, respects grace and failed deadline, then exits',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const jobs = join(f.env.HUD_HOME, 'jobs');
    const caught = join(jobs, 'j0000000000000000');
    fs.mkdirSync(caught, { recursive: true });
    fs.writeFileSync(join(caught, 'job.json'), JSON.stringify({ job: 'j0000000000000000' }));
    fs.writeFileSync(join(caught, 'SESSION.txt'), 'TAB=synthetic-catchup\n');
    fs.writeFileSync(join(caught, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
    const first = await f.call('hud_create', { role: 'imp', request_key: 'watch-one', task: 'Synthetic task.' });
    const reaped = (dir) => f.commands().filter((c) => c.command === 'pi-role-reap' && c.args[0] === dir).length;
    await until(() => reaped(caught) === 1);
    const pidFile = join(f.env.HUD_HOME, 'watch.pid');
    const pid = fs.readFileSync(pidFile, 'utf8');
    process.kill(Number(pid), 0);
    assert.ok(fs.readFileSync(`/proc/${pid.trim()}/cmdline`, 'utf8').includes('hud-watch.mjs'));
    const second = await f.call('hud_create', { role: 'imp', request_key: 'watch-two', task: 'Synthetic task.' });
    assert.equal(fs.readFileSync(pidFile, 'utf8'), pid);
    const watchLog = () => fs.readFileSync(join(f.env.HUD_HOME, 'watch.log'), 'utf8');
    assert.equal(
      watchLog()
        .split('\n')
        .filter((l) => l.includes('start pid=')).length,
      1
    );
    fs.writeFileSync(join(first.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    fs.writeFileSync(join(second.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(reaped(first.task_dir), 0);
    assert.equal(fs.existsSync(pidFile), true, 'grace jobs must keep the watcher alive');
    assert.equal(watchLog().match(/herdr events unavailable/g)?.length, 1);
    fs.writeFileSync(join(second.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
    fs.writeFileSync(join(first.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
    await until(() => reaped(first.task_dir) === 1);
    const ended = Date.now();
    fs.writeFileSync(
      join(second.task_dir, 'STATUS.json'),
      JSON.stringify({ state: 'failed', ended_at: new Date(ended).toISOString() })
    );
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(reaped(second.task_dir), 0);
    assert.equal(fs.existsSync(pidFile), true);
    await until(() => reaped(second.task_dir) === 1);
    assert.ok(Date.now() >= ended + 1000);
    await until(() => !fs.existsSync(pidFile));
    await until(() => {
      try {
        process.kill(Number(pid), 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.match(watchLog(), /no open jobs or failed deadlines/);
    assert.equal(JSON.parse(fs.readFileSync(join(second.task_dir, 'job.json'))).reaped_at !== undefined, true);
    console.log('Synthetic watch.log:\n' + watchLog());
  }
);

// Breaks if roster omits the shipped convention/path, merges overrides, or reverses project/home/default precedence.
test('thin roster returns the convention and its path with whole-file overrides', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const initialized = await f.rpc('initialize');
  assert.match(initialized.result.instructions, /hud_roster when project dispatch context is missing or stale/);
  const shipped = resolve('packages/hud-mcp/hud-convention.md');
  assert.deepEqual((await f.call('hud_roster')).convention, {
    path: shipped,
    text: fs.readFileSync(shipped, 'utf8'),
    truncated: false,
  });
  const owner = join(f.env.HUD_HOME, 'hud-convention.md');
  fs.writeFileSync(owner, 'Synthetic owner convention.');
  assert.deepEqual((await f.call('hud_roster')).convention, {
    path: owner,
    text: 'Synthetic owner convention.',
    truncated: false,
  });
  const project = join(f.root, 'hud-convention.md');
  fs.writeFileSync(project, 'Synthetic project convention.');
  assert.deepEqual((await f.call('hud_roster')).convention, {
    path: project,
    text: 'Synthetic project convention.',
    truncated: false,
  });
  const first = await f.call('hud_roster');
  const refresh = (version = first.convention_version, cwd = f.root) =>
    f.call('hud_roster', { cwd, convention_version: version });
  const checked = await refresh();
  assert.equal(checked.convention_unchanged, true);
  assert.equal(checked.convention, undefined);
  fs.writeFileSync(project, 'Changed project convention.');
  const changed = await refresh();
  assert.equal(changed.convention.text, 'Changed project convention.');
  fs.writeFileSync(owner, changed.convention.text);
  fs.unlinkSync(project);
  const source = await refresh(changed.convention_version);
  assert.equal(source.convention.path, owner, 'identical text from a new source must be returned');
  const other = join(f.root, 'other-project');
  fs.mkdirSync(other);
  const different = await refresh(source.convention_version, other);
  assert.deepEqual(different.convention, source.convention, 'another project must get the body');
  const model = first.roles.find(({ role }) => role === 'flow').runs_on;
  markExhausted(f.env.HUD_HOME, placeKey(model), 'quota exceeded');
  const refreshed = await refresh(source.convention_version);
  assert.equal(refreshed.convention_unchanged, true);
  const flow = refreshed.roles.find(({ role }) => role === 'flow');
  assert.equal(flow.available, false);
  assert.match(flow.reason, /quota exceeded.*until/);
  const failure = await f.call('hud_create', { role: 'flow', request_key: 'unavailable-flow', task: 'Synthetic.' });
  assert.equal(failure.code, 'no_available_place');
  assert.equal(failure.reason, flow.reason);
  assert.deepEqual(withoutCallerLookups(f.commands()), [], 'unavailable roles do not launch');
  fs.writeFileSync(project, 'x'.repeat(20001));
  const capped = await f.call('hud_roster');
  assert.deepEqual(capped.convention, {
    path: project,
    text: 'x'.repeat(20000),
    truncated: true,
  });
  fs.appendFileSync(project, 'beyond cap');
  assert.deepEqual((await refresh(capped.convention_version)).convention, capped.convention);
});

test('request and place pi_args cannot override the inherited caller notification binding', async (t) => {
  const f = await fixture(t);
  for (const pi_args of [
    ['--orchestrator', 'wBAD:p99'],
    ['--orchestrator=wBAD:p99'],
    ['--notify', 'fake command'],
    ['--notify=fake command'],
  ]) {
    const result = await f.call('hud_create', {
      role: 'imp',
      request_key: 'reserved-' + pi_args[0],
      task: 'Synthetic task',
      pi_args,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_arguments');
    assert.match(result.error, /caller binding/);
  }
  fallbackRole(f, 'reserved-place', [{ harness: 'pi', pi_role: 'implementer', pi_args: ['--notify=fake command'] }]);
  const place = { role: 'reserved-place', task: 'Synthetic configured binding.' };
  assert.match((await f.call('hud_create', place)).error, /caller binding/);
  assert.deepEqual(withoutCallerLookups(f.commands()), [], 'no launcher or herdr mutation for a rejected binding');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'jobs')), false);
});

test('pi dispatch falls back to the role name for HUD instructions and passes the bound HUD home to the tab', async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'));
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'general.json'), JSON.stringify({
    role: 'general', can_continue: true, run: [{ harness: 'pi', pi_role: 'implementer' }],
  }));
  const env = { ...f.env };
  delete env.HUD_HOME;
  const client = new PiRoleClient({ release: resolve('.'), node: process.execPath, hudHome: f.env.HUD_HOME }, env, f.root);
  try {
    const result = await client.call('hud_create', { role: 'general', request_key: 'bound-home', task: 'Synthetic task.' });
    const job = JSON.parse(result.content[0].text);
    assert.match(job.job, /^j[0-9a-f]{16}$/);
    const argv = f.commands().find(({ command }) => command === 'pi-role').args;
    const instructions = argv.indexOf('--hud-instructions');
    assert.notEqual(instructions, -1);
    assert.equal(argv[instructions + 1], resolve('packages/hud-mcp/instructions/general.md'));
    const tab = f.commands().find(({ command, args }) => command === 'herdr' && args[0] === 'tab' && args[1] === 'create').args;
    const at = tab.indexOf('--env');
    assert.deepEqual(tab.slice(at, at + 4), ['--env', `HUD_JOB_DIR=${job.task_dir}`, '--env', `HUD_HOME=${f.env.HUD_HOME}`]);
  } finally {
    await client.stop();
  }
});

test('thin roles MCP main path over stdio', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const initialized = await f.rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.capabilities.tools !== undefined, true);
  const listed = await f.rpc('tools/list');
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['hud_roster', 'hud_create', 'hud_read', 'hud_wait', 'hud_peek', 'hud_send', 'hud_respond', 'hud_close', 'hud_lease', 'hud_tickets', 'hud_statusline']
  );
  const feature = 'synthetic-feature';
  const drafts = [
    { title: 'First slice', what: 'Write the data.', blocked_by: [], acceptance: ['Data is written.', 'Data is visible.'] },
    { title: 'Second slice', what: 'Read the data.', blocked_by: [1], acceptance: ['Data is read.'], status: 'needs-info' },
  ];
  const ticketCall = (args) => f.call('hud_tickets', { feature, ...args });
  const refusedTicketCall = async (args, error) => {
    const { result } = await f.rpc('tools/call', { name: 'hud_tickets', arguments: { feature, ...args } });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, error);
  };
  const scratch = join(f.root, '.scratch');
  await refusedTicketCall({ op: 'add', tickets: [drafts[0], { ...drafts[1], blocked_by: [999] }] }, /unknown blocked_by ticket: 999/);
  assert.equal(fs.existsSync(scratch), false);
  const issues = join(scratch, feature, 'issues');
  const first = join(issues, '01-first-slice.md'), second = join(issues, '02-second-slice.md');
  assert.deepEqual(await ticketCall({ op: 'add', tickets: drafts }), {
    ok: true, tickets: [{ number: 1, path: first }, { number: 2, path: second }],
  });
  const collector = new ProjectCollector(f.root, f.env.HUD_HOME, f.env, f.env.HOME);
  const { tickets: [{ tickets }] } = await collector.collect('home', { workers: [] }, Date.now());
  assert.deepEqual(tickets.map(({ number, status, blockers, items }) => ({ number, status, blockers, items })), [
    { number: '01', status: 'ready-for-agent', blockers: [], items: drafts[0].acceptance.map((text) => ({ text, done: false })) },
    { number: '02', status: 'needs-info', blockers: ['01'], items: [{ text: 'Data is read.', done: false }] },
  ]);
  fs.appendFileSync(first, '\n- [ ] Synthetic comment, not acceptance.\n');
  const original = fs.readFileSync(first, 'utf8');
  await refusedTicketCall({ op: 'update', ticket: 1, status: 'wontfix', tick: [1, 3] }, /unknown acceptance item: 3/);
  assert.equal(fs.readFileSync(first, 'utf8'), original);
  assert.deepEqual(await ticketCall({ op: 'update', ticket: 1, status: 'ready-for-human', tick: [2] }), {
    ok: true, number: 1, path: first,
  });
  assert.equal(fs.readFileSync(first, 'utf8'), original.replace('ready-for-agent', 'ready-for-human').replace('- [ ] Data is visible.', '- [x] Data is visible.'));
  assert.deepEqual((await ticketCall({ op: 'add', tickets: [{ ...drafts[0], blocked_by: [2] }] })).tickets,
    [{ number: 3, path: join(issues, '03-first-slice.md') }]);

  const mirror = join(f.root, 'mirror'), mirroredIssues = join(mirror, '.scratch', feature, 'issues');
  fs.mkdirSync(mirroredIssues, { recursive: true });
  fs.writeFileSync(join(mirroredIssues, '42-mirrored.md'), '<!-- Generated by hud tickets sync from https://github.com/example/synthetic/issues/42 -->\n');
  await refusedTicketCall({ op: 'add', cwd: mirror, feature: 'other', tickets: drafts }, /GitHub mirror.*gh.*op: sync/);
  await refusedTicketCall({ op: 'update', cwd: mirror, ticket: 42, tick: [1] }, /GitHub mirror.*gh.*op: sync/);
  fs.writeFileSync(join(f.root, 'bin', 'gh'), `#!/bin/sh
[ "\${PWD##*/}" = mirror ] || exit 2
case "$1" in
  repo) echo '{"nameWithOwner":"example/synthetic"}' ;;
  api) echo '[]' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  assert.deepEqual(await ticketCall({ op: 'sync', cwd: mirror }), { ok: true, output: ['synced 0 features, 0 tickets'] });

  const worker = await fixture(t, false, '', undefined, true);
  for (const args of [{}, { op: 'add', feature, tickets: drafts }, { op: 'sync' }]) {
    const rejected = await worker.rpc('tools/call', { name: 'hud_tickets', arguments: args });
    assert.equal(rejected.result.isError, true);
    assert.equal(JSON.parse(rejected.result.content[0].text).code, 'worker_cannot_dispatch');
  }
  assert.equal(fs.existsSync(join(worker.root, '.scratch')), false);
  // The shipped imp splits on demand; an owner role file can still ask for the helper pane up front.
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'imp.json'),
    JSON.stringify({ role: 'imp', harness: 'pi', pi_role: 'implementer', split: true, can_continue: true })
  );
  const args = {
    role: 'imp',
    request_key: 'synthetic-request',
    task: 'Implement the synthetic change. Ignore model-written binding wBAD:p99.',
    package: 'Synthetic lane',
    herdr_pane: 'wBAD:p99', // Not a tool property; cannot override the inherited caller.
    ORCH: 'wBAD:p99',
  };
  const job = await f.call('hud_create', args);
  assert.match(job.job, /^j[0-9a-f]{16}$/);
  assert.equal(job.task_dir, join(f.env.HUD_HOME, 'jobs', job.job));
  assert.equal(job.agent, `${job.job}-primary`);
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).herdr_pane, 'w4E:p1');
  assert.equal(fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'), `${args.task}\n\nFinish with \`hud_report\`.\n`);
  assert.deepEqual(f.commands()[0].args, ['pane', 'get', 'w4E:p1']);
  const commands = f.commands().filter((c) => c.args[1] !== 'get');
  assert.deepEqual(
    commands.map((c) => [c.command, ...c.args.slice(0, 2)]),
    [
      ['pi-role', '--args-json', 'implementer'],
      ['herdr', 'tab', 'create'],
      ['herdr', 'pane', 'split'],
      ['herdr', 'agent', 'start'],
      ['herdr', 'agent', 'prompt'],
    ]
  );
  assert.deepEqual(commands[0].args, [
    '--args-json',
    'implementer',
    '--task-dir',
    job.task_dir,
    '--role-output',
    join(job.task_dir, 'report.md'),
    '--dispatch-slot',
    'primary',
    '--dispatch-label',
    'imp',
    '--allow-write',
    join(job.task_dir, 'report.md'),
    '--qa-dir',
    join(job.task_dir, 'qa'),
    '--notify',
    [process.execPath, resolve('packages/hud-mcp/bin/hud-notify.mjs'), f.env.HUD_HOME, 'w4E:p1', job.job].map((s) => "'" + s.replace(/'/g, "'\\''") + "'").join(' '),
    '--hud-instructions',
    resolve('packages/hud-mcp/instructions/implementer.md'),
    '--hud-sonic-jobs',
    resolve('packages/hud-mcp/bin/sonic-jobs.mjs'),
    '--',
    '--tui-mode',
    'regular',
    '--hud-worker-tools',
    '-e',
    resolve('integrations/pi/package/extensions/hud.mjs'),
  ]);
  assert.equal(commands.find((c) => c.args[1] === 'start').args.includes('--session-dir'), false);
  const session = Object.fromEntries(
    fs
      .readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split('='))
  );
  assert.deepEqual(session, {
    TASK: job.job,
    TAB: 'w4E:t2',
    TAB_NAME: session.TAB_NAME,
    LEFT: 'w4E:p2',
    RIGHT: 'w4E:p3',
    ORCH: 'w4E:p1',
    BASE: 'HEAD',
    PRIMARY: job.agent,
  });
  assert.ok(commands[1].args.includes('--no-focus'));
  assert.equal(commands[1].args[commands[1].args.indexOf('--env') + 1], `HUD_JOB_DIR=${job.task_dir}`);
  assert.equal(commands[1].args[commands[1].args.indexOf('--label') + 1], 'imp Synthetic lane');
  assert.equal(commands[1].args[commands[1].args.indexOf('--workspace') + 1], 'w4E');
  assert.deepEqual(commands[2].args.slice(2), [
    'w4E:p2',
    '--direction',
    'right',
    '--ratio',
    '0.5',
    '--cwd',
    f.root,
    '--no-focus',
  ]);
  assert.deepEqual(commands[3].args, [
    'agent',
    'start',
    job.agent,
    '--kind',
    'pi',
    '--pane',
    'w4E:p2',
    '--',
    ...commands[0].args.slice(2),
  ]);
  assert.deepEqual(commands[4].args, [
    'agent',
    'prompt',
    job.agent,
    `Read ${job.task_dir}/brief.md and do exactly what it asks.`,
    '--wait',
    '--until',
    'working',
    '--timeout',
    '30000',
  ]);
  assert.deepEqual(await f.call('hud_create', args), withoutHint(job));
  assert.equal(f.commands().filter((c) => c.args[1] !== 'get').length, commands.length, 'retry does not dispatch again');
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  assert.equal(receipt.dispatch_exit_code, 0);
  assert.equal(receipt.stderr_tail, '');
  assert.equal(receipt.cwd, f.root);
  assert.equal(receipt.request_key, args.request_key);
  assert.equal(receipt.package, args.package);
  assert.equal((await f.call('hud_read', { job: job.job })).report, 'Synthetic implementation report.');
  assert.ok(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).read_at);
  const waiting = f.call('hud_read', { job: job.job, wait_ms: 2000 });
  const settle = setTimeout(
    () =>
      fs.writeFileSync(
        join(job.task_dir, 'STATUS.json'),
        JSON.stringify({ state: 'idle_grace', exit_reason: 'settled' })
      ),
    100
  );
  t.after(() => clearTimeout(settle));
  const read = await waiting;
  assert.equal(read.state, 'idle_grace');
  assert.equal(read.exit_reason, 'settled');
  assert.equal(read.report_exists, true);
  assert.equal(read.report, undefined);
  assert.equal(read.report_unchanged, true);
  const stamp = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).read_at;
  assert.equal(new Date(stamp).toISOString(), stamp);
  await f.call('hud_read', { job: job.job });
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).read_at, stamp);
  const answer = { job: job.job, request_id: 'q1', answer: 'Synthetic answer.' };
  assert.deepEqual(await f.call('hud_respond', answer), { ok: true, written: true });
  assert.deepEqual(await f.call('hud_respond', { ...answer, answer: 'Do not overwrite.' }), {
    ok: true,
    written: false,
  });
  assert.equal(fs.readFileSync(join(job.task_dir, 'qa', 'q1.answer.md'), 'utf8'), answer.answer);
  assert.deepEqual(await f.call('hud_close', { job: job.job }), { exit_code: 0, last_line: 'Synthetic reap complete' });
  assert.deepEqual(f.commands().at(-1), { command: 'pi-role-reap', args: [job.task_dir] });
});

test('a slow CLI launch blocks only retries with the same request key, not other job mutations', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const old = await f.call('hud_create', { role: 'imp', request_key: 'already-working', task: 'Synthetic task.' });
  fs.writeFileSync(join(f.env.HOME, 'hold-grok-start'), '');
  const args = { role: 'imp', on: 'grok', request_key: 'slow-launch', task: 'Slow synthetic launch.' };
  let launchFinished = false;
  let retryFinished = false;
  const launch = f.call('hud_create', args).finally(() => { launchFinished = true; });
  const grokStarts = () => f.commands().filter(({ args }) => args[1] === 'start' && args.includes('grok'));
  await until(() => grokStarts().length > 0);
  const retry = f.call('hud_create', args).finally(() => { retryFinished = true; });
  const release = join(f.env.HOME, 'release-prompt-result');
  try {
    const [other, answer, send, close] = await Promise.all([
      f.call('hud_create', { role: 'imp', request_key: 'unrelated-create', task: 'Another synthetic task.' }),
      f.call('hud_respond', { job: old.job, request_id: 'q1', answer: 'Synthetic answer.' }),
      f.call('hud_send', { job: old.job, message_key: 'unrelated-send', text: 'Synthetic message.' }),
      f.call('hud_close', { job: old.job }),
    ]);
    assert.notEqual(other.job, old.job);
    assert.equal(answer.written, true);
    assert.equal(send.sent, true);
    assert.equal(close.exit_code, 0);
    assert.equal(launchFinished, false, 'unrelated calls finish while herdr is still starting Grok');
    assert.equal(retryFinished, false, 'duplicate waits for the original result');
  } finally {
    fs.writeFileSync(release, '');
    await Promise.all([launch, retry]);
  }
  assert.equal((await launch).code, 'dispatch_failed');
  assert.equal((await retry).job, (await launch).job);
  assert.equal((await retry).code, 'dispatch_failed');
  assert.equal(grokStarts().length, 1);
});

test('worker MCP lists only the worker tools and refuses main-session calls', async (t) => {
  const f = await fixture(t, true, '', undefined, true);
  const dir = f.env.HUD_JOB_DIR;
  const job = basename(dir);
  const args = { role: 'imp', request_key: 'worker-child', task: 'Synthetic task.' };
  const receipt = {
    job,
    role: 'imp',
    request_key: 'worker-self',
    cwd: f.root,
    herdr_pane: f.env.HERDR_PANE_ID,
    created_at: new Date().toISOString(),
    dispatch_exit_code: 0,
    message_keys: [],
    place_key: 'pi:implementer:synthetic/default',
  };
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify(receipt));
  fs.writeFileSync(join(dir, 'SESSION.txt'), `PRIMARY=${job}-primary\n`);
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  fs.writeFileSync(join(dir, 'qa', 'q1.md'), 'Synthetic question.');
  const listed = await f.rpc('tools/list');
  assert.deepEqual(listed.result.tools.map(({ name }) => name), ['hud_report', 'hud_ask', 'hud_sonic', 'hud_progress', 'hud_lease']);
  const call = (name, args) => f.rpc('tools/call', { name, arguments: args });
  assert.equal(resultValue((await call('hud_progress', { message: 'Synthetic milestone' })).result).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'progress.jsonl'), 'utf8')).text, 'Synthetic milestone');
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'quota exceeded' }));
  for (const [name, payload] of [
    ['hud_roster', {}], ['hud_read', { job }], ['hud_create', args], ['hud_close', { job }],
    ['hud_send', { job, message_key: 'worker-send', text: 'Synthetic message.' }],
    ['hud_respond', { job, request_id: 'q1', answer: 'Synthetic answer.' }],
  ]) {
    const { result } = await call(name, payload);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, 'worker_cannot_dispatch');
  }
  assert.deepEqual(f.commands(), []);
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')), [job]);
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
  assert.equal(fs.existsSync(join(dir, 'qa', 'q1.answer.md')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8')), receipt);
});

function leaseWorker(t, f, number, cwd = f.root, pid = process.pid) {
  const job = `j${String(number).padStart(16, '0')}`, dir = join(f.env.HUD_HOME, 'jobs', job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job, cwd, role: 'imp', herdr_pane: 'w4E:p2', created_at: new Date().toISOString() }));
  const status = (state) => fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state, pid }));
  status('working');
  const rpc = workerClient(t, f, dir);
  return { job, dir, status, lease: async (args) => resultValue(await rpc('hud_lease', { name: 'install', ...args })) };
}

test('hud_lease grants one worker per Git root, then wakes a waiter after release', async (t) => {
  const f = await fixture(t);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: f.root, env: f.env }).status, 0);
  const sub = join(f.root, 'sub');
  fs.mkdirSync(sub);
  const workers = [leaseWorker(t, f, 1), leaseWorker(t, f, 2, sub)];
  const results = await Promise.all(workers.map((w) => w.lease({ wait_s: 0 })));
  const winner = results.findIndex((r) => r.granted), loser = 1 - winner;
  assert.equal(results.filter((r) => r.granted).length, 1);
  const held_by = results[loser].held_by;
  assert.equal(held_by.holder, workers[winner].job);
  assert.ok(Number.isFinite(Date.parse(held_by.since)));
  assert.deepEqual(await workers[loser].lease({ release: true }), { released: false, held_by });
  const waiting = workers[loser].lease({ wait_s: 3 });
  assert.deepEqual(await workers[winner].lease({ release: true }), { released: true });
  assert.deepEqual(await waiting, { granted: true });
  assert.deepEqual(await workers[loser].lease({ release: true }), { released: true });
});

test('hud_lease reclaims terminal jobs and dead processes without granting twice', async (t) => {
  const f = await fixture(t);
  const main = (args = {}) => f.call('hud_lease', { name: 'install', wait_s: 0, ...args });
  const closed = leaseWorker(t, f, 1);
  assert.deepEqual(await closed.lease({ wait_s: 0 }), { granted: true });
  closed.status('closed');
  assert.deepEqual(await main(), { granted: true });
  assert.deepEqual(await main({ release: true }), { released: true });

  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = once(proc, 'exit');
  t.after(() => proc.kill());
  const dead = leaseWorker(t, f, 2, f.root, proc.pid);
  // The fallback command must record the worker's PID, not its own short-lived PID.
  const fallback = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-lease.mjs'), '--dir', dead.dir, '--wait-s', '0', 'install'],
    { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.deepEqual(JSON.parse(fallback.stdout), { granted: true });
  assert.equal((await main()).held_by.holder, dead.job);
  proc.kill();
  await exited;
  const other = leaseWorker(t, f, 3);
  const results = await Promise.all([main(), other.lease({ wait_s: 0 })]);
  assert.equal(results.filter((r) => r.granted).length, 1);
  assert.equal(results.find((r) => !r.granted).held_by.holder, results[0].granted ? 'w4E:p1' : other.job);
});

test('main sessions can hold and release a lease by pane', async (t) => {
  const f = await fixture(t);
  const name = 'shared install';
  assert.ok((await f.rpc('tools/list')).result.tools.some((tool) => tool.name === 'hud_lease'));
  assert.deepEqual(await f.call('hud_lease', { name }), { granted: true });
  const folder = join(f.env.HUD_HOME, 'leases'), [file] = fs.readdirSync(folder);
  const lease = JSON.parse(fs.readFileSync(join(folder, file), 'utf8'));
  assert.equal(lease.project, f.root);
  assert.equal(lease.name, name);
  assert.equal(lease.holder, f.env.HERDR_PANE_ID);
  assert.deepEqual(await f.call('hud_lease', { name, release: true }), { released: true });
  assert.deepEqual(await f.call('hud_lease', { name, release: true }), { released: false });
  const missing = spawnSync(process.execPath, [entry], { cwd: f.root, env: { ...f.env, PATH: join(f.root, 'empty') },
    encoding: 'utf8', input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'hud_lease', arguments: { name },
    } }) + '\n' });
  assert.equal(missing.status, 0, missing.stderr);
  const reply = JSON.parse(missing.stdout).result;
  assert.equal(reply.isError, true);
  assert.match(JSON.parse(reply.content[0].text).error, /requires util-linux flock/);
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('hud_read compact lists actionable jobs without losing unread reports or hidden changes', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.call('hud_read'), { jobs: [] });
  function seed(n) {
    const job = `j${n.toString(16).padStart(16, '0')}`;
    const created_at = new Date(n * 1000).toISOString();
    const role = n === 1 ? 'sonic' : 'imp';
    const working = n >= 2 && n <= 5;
    const state = working ? 'working' : 'closed';
    const reason = working ? 'Reading synthetic files' : 'settled';
    const dir = join(f.env.HUD_HOME, 'jobs', job);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({
      job, role, created_at, cwd: f.root, herdr_pane: 'w4E:p1',
      ...(n === 1 ? { parent_job: 'j0000000000000002' } : {}),
      ...(n > 5 ? { read_at: created_at } : {}),
    }));
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state, reason }));
    if (!working) {
      const report = join(dir, 'report.md');
      fs.writeFileSync(report, 'Synthetic report.');
      fs.utimesSync(report, n, n);
    }
    return {
      job, role, state, display_state: working ? 'working' : 'done', reason,
      blocked: false, open_questions: 0, report_present: !working, report_unread: n === 1, created_at,
    };
  }
  const legacy = Array.from({ length: 20 }, (_, i) => seed(i + 1)).reverse();
  const expected = legacy.slice(-5).map(({ job, role, state, report_unread }) => ({
    job, role, state, ...(report_unread ? { report_unread: true } : {}),
  }));
  assert.deepEqual((await f.call('hud_read')).jobs, expected);

  // Measure the model-visible text of both quiet polls on exactly the same fixture.
  async function listText(args) {
    const response = await f.rpc('tools/call', { name: 'hud_read', arguments: args });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined);
    return response.result.content[0].text;
  }
  const compactText = await listText({});
  const recentText = await listText({ view: 'recent' });
  assert.deepEqual(JSON.parse(compactText), { jobs: expected }, 'quiet poll keeps the report unread');
  assert.deepEqual(JSON.parse(recentText), { jobs: legacy });
  const compactBytes = Buffer.byteLength(compactText, 'utf8');
  const recentBytes = Buffer.byteLength(recentText, 'utf8');
  t.diagnostic(`hud_read quiet list UTF-8 bytes: default=${compactBytes}, recent=${recentBytes}, saved=${((1 - compactBytes / recentBytes) * 100).toFixed(2)}%`);

  const newer = Array.from({ length: 6 }, (_, i) => seed(i + 21)).reverse();
  assert.deepEqual(await f.call('hud_read', { view: 'compact' }), {
    jobs: expected,
    changes: newer.map(({ job }) => `${job} imp: closed | settled`),
  });
  assert.deepEqual(await f.call('hud_read', { view: 'recent' }), { jobs: [...newer, ...legacy].slice(0, 20) });
  assert.deepEqual(await f.call('hud_read'), { jobs: expected });
  const receipt = JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'jobs', expected.at(-1).job, 'job.json')));
  assert.equal(receipt.read_at, undefined);
  assert.equal(receipt.observed_at, undefined);
});

test('hud_read rejects invalid views and views on single-job reads', async (t) => {
  const f = await fixture(t);
  for (const [args, error] of [
    [{ view: 'history' }, 'invalid_arguments: view'],
    [{ view: null }, 'invalid_arguments: view'],
    [{ view: 'recent', job: 'j0000000000000001' }, 'invalid_arguments: view is list-only'],
  ]) {
    const response = await f.rpc('tools/call', { name: 'hud_read', arguments: args });
    assert.equal(response.result.isError, true);
    assert.deepEqual(JSON.parse(response.result.content[0].text), { ok: false, code: 'tool_error', error });
  }
});

function waitFixtureJob(f, n, state = 'working', herdr_pane = 'w4E:p1', cwd = f.root) {
  const job = `j${n.toString(16).padStart(16, '0')}`;
  const dir = join(f.env.HUD_HOME, 'jobs', job);
  const receipt = { job, role: 'imp', herdr_pane, cwd, created_at: new Date(n * 1000).toISOString() };
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify(receipt));
  const status = (state) => {
    const file = join(dir, 'STATUS.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ state }));
    fs.renameSync(`${file}.tmp`, file);
  };
  status(state);
  return { job, dir, receipt, status };
}

test('hud_read lists only the caller project, including its linked worktrees', async (t) => {
  const f = await fixture(t);
  git(f.root, 'init', '-qb', 'trunk');
  git(f.root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@invalid', 'commit', '--allow-empty', '-qm', 'base');
  const linked = join(f.root, 'linked');
  git(f.root, 'worktree', 'add', '-qb', 'linked', linked);
  const foreign = waitFixtureJob(f, 1, 'working', 'w4E:p1', initRepo(f.root));
  const legacy = waitFixtureJob(f, 2, 'working', 'w4E:p8', linked);
  const created = await f.call('hud_create', { role: 'imp', on: 'pi', cwd: linked, task: 'Synthetic worktree job.' });
  assert.equal(JSON.parse(fs.readFileSync(join(created.task_dir, 'job.json'))).project_root, fs.realpathSync(f.root));
  assert.equal(created.changes, undefined, 'foreign project changes do not ride on this pane’s response');
  for (const args of [{}, { view: 'recent' }]) {
    assert.deepEqual((await f.call('hud_read', args)).jobs.map(({ job }) => job), [created.job, legacy.job]);
  }
  assert.equal((await f.call('hud_read', { job: foreign.job })).job, foreign.job);
});

const ownerOf = ({ dir }) => JSON.parse(fs.readFileSync(join(dir, 'job.json'))).herdr_pane;
const paneList = (f, ...ids) => fs.writeFileSync(join(f.env.HOME, 'pane-list.json'), JSON.stringify({
  result: { panes: ids.map((pane_id) => ({ pane_id })) },
}));

test('MCP adopts same-project orphan jobs in one scan and pushes questions to the new pane', async (t) => {
  const f = await fixture(t);
  const adopted = [waitFixtureJob(f, 1, 'working', 'w4E:p8'), waitFixtureJob(f, 2, 'working', 'w4E:p7')];
  const live = waitFixtureJob(f, 3, 'working', 'wOTHER:p1');
  const foreign = waitFixtureJob(f, 4, 'working', 'w4E:p8', initRepo(f.root));
  const unread = waitFixtureJob(f, 5, 'closed', 'w4E:p8');
  const unseen = waitFixtureJob(f, 6, 'failed', 'w4E:p8');
  const read = waitFixtureJob(f, 7, 'closed', 'w4E:p8');
  const observed = waitFixtureJob(f, 8, 'failed', 'w4E:p8');
  const question = waitFixtureJob(f, 9, 'closed', 'w4E:p8');
  for (const { dir } of [unread, read]) fs.writeFileSync(join(dir, 'report.md'), 'Synthetic report.');
  fs.writeFileSync(join(question.dir, 'qa/q1.md'), 'Synthetic question.');
  const at = new Date(Date.now() + 1000).toISOString();
  fs.writeFileSync(join(read.dir, 'job.json'), JSON.stringify({ ...read.receipt, read_at: at }));
  fs.writeFileSync(join(observed.dir, 'job.json'), JSON.stringify({ ...observed.receipt, observed_at: at }));
  fs.writeFileSync(join(adopted[0].dir, 'SESSION.txt'), 'ORCH=w4E:p8\n');
  fs.writeFileSync(join(f.env.HOME, 'pane-list.json'), '{"result":{"panes":[{"pane_id":"w4E:p1"},{}]}}');
  await f.call('hud_read');
  assert.deepEqual(adopted.map(ownerOf), ['w4E:p8', 'w4E:p7'], 'incomplete pane list cannot transfer ownership');

  const lists = () => f.commands().filter(({ args }) => args[0] === 'pane' && args[1] === 'list').length;
  const before = lists();
  paneList(f, 'w4E:p1', 'wOTHER:p1');
  const handoff = await f.call('hud_read');
  assert.equal(lists() - before, 1);
  const owed = [...adopted, unread, unseen, question];
  assert.deepEqual(handoff.changes.map((line) => line.split(' ')[0]).sort(), owed.map(({ job }) => job).sort());
  assert.ok(owed.every((job) => ownerOf(job) === 'w4E:p1'));
  assert.deepEqual([read, observed].map(ownerOf), ['w4E:p8', 'w4E:p8']);
  assert.equal(ownerOf(live), 'wOTHER:p1');
  assert.equal(ownerOf(foreign), 'w4E:p8');

  const ask = workerClient(t, f, adopted[0].dir, '0');
  const answer = await ask('hud_ask', { question: 'Which synthetic layout?', default: 'Rows.' });
  assert.equal(answer.isError, undefined, JSON.stringify(answer));
  const pi = spawnSync(process.execPath, [resolve('packages/hud-mcp/bin/hud-notify.mjs'), f.env.HUD_HOME, 'w4E:p8',
    adopted[0].job, '[imp@demo] QUESTION q99: Another question'], { env: f.env, encoding: 'utf8' });
  assert.equal(pi.status, 0, pi.stderr);
  assert.deepEqual(f.commands().filter(({ args }) => args[0] === 'agent' && args[1] === 'prompt')
    .map(({ args }) => args[2]), ['w4E:p1', 'w4E:p1']);
});

test('hud watch adopts on catch-up and delivers an already pending question', async (t) => {
  const f = await fixture(t);
  const orphan = waitFixtureJob(f, 1, 'working', 'w4E:p8');
  paneList(f, 'w4E:p1');
  fs.writeFileSync(join(orphan.dir, 'qa/q1.md'), '# Question q1 from imp@demo\n\nWhich layout?\n\nDefault if unanswered: Rows.\n');
  const child = spawn(process.execPath, [resolve('bin/hud'), 'watch'], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (text) => { output += text; });
  await until(() => output.includes(`reply: hud_respond job=${orphan.job} request_id=q1`));
  assert.equal(ownerOf(orphan), 'w4E:p1');
});

const progressRecord = (text) => ({ at: '2026-11-18T12:00:00.000Z', text });
const jsonLines = (rows) => rows.map((row) => JSON.stringify(row) + '\n').join('');

test('hud-progress validates the job directory, normalizes text, and retains the newest 50', async (t) => {
  const f = await fixture(t);
  const { dir, job } = waitFixtureJob(f, 1);
  const log = join(dir, 'progress.jsonl');
  const run = (...args) => runProgress(f, dir, ...args);
  const outside = join(f.root, job);
  fs.cpSync(dir, outside, { recursive: true });
  assert.notEqual(run('--dir', outside, 'outside').status, 0);
  assert.notEqual(run(' \x07\n ').status, 0);
  assert.equal(fs.existsSync(join(outside, 'progress.jsonl')), false);
  assert.equal(fs.existsSync(log), false);
  const first = run('  Scanned\r\nnotes\x07\u0085  ');
  assert.equal(first.status, 0, first.stderr);
  const read = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(read()[0].text, 'Scanned notes');
  assert.ok(Number.isFinite(Date.parse(read()[0].at)));
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  const seed = Array.from({ length: 49 }, (_, i) => progressRecord(`Step ${i}`));
  fs.appendFileSync(log, jsonLines(seed));
  const inode = fs.statSync(log).ino;
  const rotated = run('--dir', dir, '进'.repeat(245));
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.notEqual(fs.statSync(log).ino, inode, 'rotation publishes a fresh inode');
  assert.deepEqual(read().map((r) => r.text), [...seed.map((r) => r.text), '进'.repeat(240)]);
});

test('hud_report binds a fresh report to the turn token in the current CLI prompt', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'done-command', 20, true, 'claude');
  const job = await f.call('hud_create', { role: 'done-command', request_key: 'done-command', task: 'Synthetic task.' });
  const dir = job.task_dir, file = join(dir, 'done.json'), report = join(dir, 'report.md');
  const call = workerClient(t, f, dir);
  const finish = (text, turn) => call('hud_report', { text, turn });
  const first = cliToken(dir);
  const prompts = () => f.commands().filter((c) => c.args[0] === 'agent' && c.args[1] === 'prompt');
  assert.match(prompts()[0].args[3], /Finish with hud_report/);
  assert.ok(prompts()[0].args[3].includes(`turn: ${first}`));
  assert.equal(fs.readFileSync(join(dir, 'brief.md'), 'utf8').trim(), 'Synthetic task.');
  assert.equal((await finish(' ', first)).isError, true, 'missing report');
  assert.equal((await finish('Synthetic first turn.\n')).isError, true, 'must supply the prompt token');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(report), false);
  assert.deepEqual(resultValue(await finish('Synthetic first turn.\n', first)), { path: report });
  const done = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(turnToken(done), first);
  assert.equal(done.report_sig, reportSignature(dir));
  assert.ok(Number.isFinite(Date.parse(done.at)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await until(() => cliState(dir)?.state === 'idle_grace');
  assert.equal((await f.call('hud_send', { job: job.job, message_key: 'continue', text: 'Synthetic continuation.' })).sent, true);
  const second = cliToken(dir);
  assert.notEqual(first, second);
  assert.ok(prompts().at(-1).args[3].includes(`turn: ${second}`));
  assert.notEqual(runProgress(f, dir, '--done', '--turn', second).status, 0, 'fallback rejects unchanged baseline report');
  assert.equal((await finish('Late report for first turn.\n', first)).isError, true, 'old turn cannot declare the new one');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), done, 'rejection leaves the previous receipt untouched');
  assert.equal(fs.readFileSync(report, 'utf8'), 'Synthetic first turn.\n', 'stale call does not replace the report');
  assert.deepEqual(resultValue(await finish('Synthetic second turn.\n', second)), { path: report });
  assert.equal(turnToken(JSON.parse(fs.readFileSync(file, 'utf8'))), second);
});

test('single-job reads and the panel get progress without changes or narration in list/wait rows', async (t) => {
  const f = await fixture(t);
  const { dir, job, status } = waitFixtureJob(f, 1);
  await f.call('hud_roster');
  const streamed = [], ac = new AbortController();
  const watching = watchCommand(['--verbose'], { env: f.env, stdout: (s) => streamed.push(s.trim()), stderr: () => {} },
    { signal: ac.signal, rescanMs: 60 });
  try {
    const records = Array.from({ length: 12 }, (_, i) => progressRecord(`Step ${i}`));
    const log = join(dir, 'progress.jsonl');
    fs.writeFileSync(log, jsonLines(records.slice(0, -1)));
    assert.deepEqual(workerFor(f, job).latest_progress, records.at(-2));
    fs.appendFileSync(log, jsonLines(records.slice(-1)));
    const detail = await f.call('hud_read', { job });
    assert.deepEqual(detail.progress, records.slice(-10));
    assert.deepEqual(detail.latest_progress, records.at(-1));
    assert.equal(detail.changes, undefined);
    assert.deepEqual(workerFor(f, job).progress, detail.progress);
    const compact = [{ job, role: 'imp', state: 'working' }];
    assert.deepEqual(await f.call('hud_read'), { jobs: compact });
    assert.deepEqual((await f.call('hud_wait', { jobs: [job], wait_ms: 0 })).jobs, compact);
    status('done');
    await until(() => streamed.length > 0);
    assert.deepEqual(streamed, [`${job} imp: done`]);
  } finally {
    ac.abort(); await watching;
  }
});

test('hud_peek returns a bounded pane tail and does not acknowledge, exhaust or close jobs', async (t) => {
  const f = await fixture(t);
  const { dir, job } = waitFixtureJob(f, 1, 'idle_grace');
  const fault = waitFixtureJob(f, 2, 'failed');
  const faultStatus = JSON.stringify({ state: 'failed', reason: 'HTTP 429 quota' });
  fs.writeFileSync(join(fault.dir, 'STATUS.json'), faultStatus);
  fs.writeFileSync(join(fault.dir, 'job.json'), JSON.stringify({ ...fault.receipt, place_key: 'synthetic-quota' }));
  fs.writeFileSync(join(dir, 'report.md'), 'Synthetic report not read.');
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'PRIMARY=synthetic\nLEFT=w4E:p2\nRIGHT=w4E:p3\n');
  const milestone = progressRecord('Tested the change');
  fs.writeFileSync(join(dir, 'progress.jsonl'), jsonLines([milestone]));
  const pane = Array.from({ length: 121 }, (_, i) => `pane line ${i}`);
  fs.writeFileSync(join(f.env.HOME, 'pane-read'), pane.join('\r\n') + '\r\n');
  const paths = [join(dir, 'job.json'), join(dir, 'STATUS.json'), join(fault.dir, 'job.json'), join(fault.dir, 'STATUS.json')];
  const before = paths.map((path) => fs.readFileSync(path, 'utf8'));
  const peek = await f.call('hud_peek', { job });
  assert.deepEqual(peek.status, { job, role: 'imp', state: 'idle_grace', report_unread: true });
  assert.deepEqual(peek.progress, [milestone]);
  assert.equal(Object.hasOwn(peek, 'pane_lines'), false);
  assert.deepEqual(f.commands(), [], 'status and progress do not fetch the pane');
  const rich = await f.call('hud_peek', { job, detail: true });
  assert.equal(rich.diagnostics.display_state, 'done');
  assert.equal(rich.status.report_unread, true);
  assert.equal(Object.hasOwn(rich, 'report'), false);
  assert.deepEqual(f.commands(), [], 'diagnostics do not fetch the pane either');
  assert.deepEqual((await f.call('hud_peek', { job, lines: 40 })).pane_lines, pane.slice(-40));
  assert.deepEqual((await f.call('hud_peek', { job, lines: 120 })).pane_lines, pane.slice(-120));
  const noPane = await f.call('hud_peek', { job: fault.job, lines: 1 });
  assert.equal(noPane.pane_lines, null);
  assert.equal(noPane.pane_reason, 'no pane');
  assert.equal(noPane.status.reason, 'HTTP 429 quota');
  for (const lines of [0, 121, 2.5, '3']) {
    const response = await f.rpc('tools/call', { name: 'hud_peek', arguments: { job, lines } });
    assert.equal(response.result.isError, true);
    assert.equal(JSON.parse(response.result.content[0].text).error, 'invalid_arguments: lines');
  }
  assert.deepEqual(paths.map((path) => fs.readFileSync(path, 'utf8')), before);
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
  assert.deepEqual(f.commands(), Array.from({ length: 2 }, () => ({
    command: 'herdr', args: ['pane', 'read', 'w4E:p2', '--source', 'recent'],
  })));
});

test('hud_wait any wakes on a settlement among the caller’s initially unsettled jobs', { timeout: 4000 }, async (t) => {
  const f = await fixture(t);
  const first = waitFixtureJob(f, 1), second = waitFixtureJob(f, 2);
  waitFixtureJob(f, 3, 'done');
  const foreign = waitFixtureJob(f, 4, 'working', 'w4E:p9');
  await f.call('hud_roster'); // Advance the cursor before writing the settlement.
  const waiting = f.call('hud_wait', { wait_ms: 5000 });
  await f.rpc('ping'); // The wait is active and does not hold up another call.
  foreign.status('done');
  fs.writeFileSync(join(second.dir, 'report.md'), 'Synthetic report.');
  second.status('idle_grace');
  const result = await waiting;
  result.jobs.sort((a, b) => a.job.localeCompare(b.job));
  assert.deepEqual(result, {
    ready: true, timed_out: false, triggered: [second.job],
    jobs: [
      { job: first.job, role: 'imp', state: 'working' },
      { job: second.job, role: 'imp', state: 'idle_grace', report_unread: true },
    ],
    changes: [`${second.job} imp: idle_grace | report`],
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(join(second.dir, 'job.json'), 'utf8')), second.receipt);
});

test('hud_wait all wakes after the last explicit target settles', { timeout: 4000 }, async (t) => {
  const f = await fixture(t);
  const first = waitFixtureJob(f, 1), second = waitFixtureJob(f, 2);
  const args = { jobs: [first.job, second.job], mode: 'all' };
  const waiting = f.call('hud_wait', { ...args, wait_ms: 5000 });
  await f.rpc('ping');
  first.status('stopped');
  assert.equal((await f.call('hud_wait', { ...args, wait_ms: 0 })).ready, false);
  second.status('done');
  const result = await waiting;
  assert.equal(result.ready, true);
  assert.equal(result.timed_out, false);
  assert.deepEqual(result.triggered, args.jobs);
  assert.deepEqual(result.jobs.map((job) => job.state), ['stopped', 'done']);
});

test('hud_wait all wakes early for a question and previews only its ID', { timeout: 4000 }, async (t) => {
  const f = await fixture(t);
  const first = waitFixtureJob(f, 1), second = waitFixtureJob(f, 2);
  const waiting = f.call('hud_wait', { jobs: [first.job, second.job], mode: 'all', wait_ms: 5000 });
  await f.rpc('ping');
  fs.writeFileSync(join(first.dir, 'qa', 'q1.md'), 'Synthetic question.');
  const result = await waiting;
  assert.equal(result.ready, true);
  assert.equal(result.timed_out, false);
  assert.deepEqual(result.triggered, [first.job]);
  assert.deepEqual(result.jobs, [
    { job: first.job, role: 'imp', state: 'working', question_ids: ['q1'] },
    { job: second.job, role: 'imp', state: 'working' },
  ]);
});

test('hud_wait returns a compact snapshot on timeout and rejects invalid targets', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.call('hud_wait'), { ready: true, timed_out: false, triggered: [], jobs: [] });
  const { job } = waitFixtureJob(f, 1);
  await f.call('hud_roster');
  const start = performance.now();
  assert.deepEqual(await f.call('hud_wait', { jobs: [job], wait_ms: 100 }), {
    ready: false, timed_out: true, triggered: [], jobs: [{ job, role: 'imp', state: 'working' }],
  });
  assert.ok(performance.now() - start >= 100);
  for (const args of [{ jobs: ['../outside'] }, { jobs: ['j0000000000000002'] }, { mode: 'some' }, { wait_ms: 120001 }]) {
    const response = await f.rpc('tools/call', { name: 'hud_wait', arguments: args });
    assert.equal(response.result.isError, true);
    assert.match(JSON.parse(response.result.content[0].text).error, /^invalid_arguments:/);
  }
});

test('hud_read returns unread reports in idle grace, omits read bodies, supports full and observes a second report', async (t) => {
  const f = await fixture(t), id = 'j0000000000000099';
  const dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: id, role: 'imp', cwd: f.root, created_at: '2026-01-01', herdr_pane: 'w4E:p1', cli: { idle_grace_s: 120 } }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  fs.writeFileSync(join(dir, 'report.md'), 'First report.');
  fs.writeFileSync(join(dir, 'qa/q1.md'), 'Question?');
  const recent = (await f.call('hud_read', { view: 'recent' })).jobs[0];
  assert.equal(recent.open_questions, 1);
  assert.equal(recent.report_unread, true);
  assert.equal(recent.report, undefined);
  const first = await f.call('hud_read', { job: id, detail: true });
  assert.equal(first.report, 'First report.');
  assert.equal(first.idle_grace_s, 120);
  const stamp = JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at;
  assert.ok(stamp);
  const unchanged = await f.call('hud_read', { job: id });
  assert.equal(unchanged.report, undefined);
  assert.equal(unchanged.report_unchanged, true);
  assert.equal(unchanged.observed_at, undefined);
  assert.equal((await f.call('hud_read', { view: 'recent' })).jobs[0].report_unread, false);
  assert.deepEqual((await f.call('hud_read')).jobs, [{ job: id, role: 'imp', state: 'idle_grace', question_ids: ['q1'] }]);
  assert.equal((await f.call('hud_read', { job: id, full: true })).report, 'First report.');
  await new Promise((r) => setTimeout(r, 10));
  fs.writeFileSync(join(dir, 'report.md'), 'Second report.');
  assert.equal((await f.call('hud_read', { job: id })).report, 'Second report.');
  assert.ok(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at > stamp);
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
  assert.equal((await f.call('hud_read', { job: id })).report_unchanged, true);
});

test('failed job without a report catches up once, then hud_read marks attention seen without marking a report read', async (t) => {
  const f = await fixture(t), id = 'j0000000000000098', dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: id, role: 'imp', cwd: f.root, herdr_pane: 'w4E:p1', created_at: '2026-01-01' }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'failed', reason: 'worker gone' }));
  const catchup = async () => {
    const lines = [], ac = new AbortController();
    const watching = watchCommand([], { env: f.env, stdout: (s) => lines.push(s.trim()), stderr: () => {} }, { signal: ac.signal, rescanMs: 60 });
    await new Promise((r) => setTimeout(r, 150)); ac.abort(); await watching;
    const [, ignored] = fs.readFileSync('/proc/self/status', 'utf8').match(/^SigIgn:\s+([\da-f]+)$/m);
    const sigpipe = 1n << BigInt(constants.signals.SIGPIPE - 1);
    assert.equal(BigInt(`0x${ignored}`) & sigpipe, sigpipe, 'watchCommand must leave SIGPIPE ignored');
    return lines;
  };
  assert.deepEqual(await catchup(), [`${id} imp: failed | worker gone`]);
  assert.deepEqual((await f.call('hud_read')).jobs, [{ job: id, role: 'imp', state: 'failed', reason: 'worker gone' }]);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).observed_at, undefined);
  const read = await f.call('hud_read', { job: id });
  assert.equal(read.report_exists, false);
  assert.equal(read.observed_at, undefined);
  const receipt = JSON.parse(fs.readFileSync(join(dir, 'job.json')));
  assert.ok(receipt.observed_at);
  assert.equal(receipt.read_at, undefined);
  assert.deepEqual(await catchup(), []);
  assert.deepEqual((await f.call('hud_read')).jobs, []);
  assert.equal((await f.call('hud_read', { view: 'recent' })).jobs[0].state, 'failed');
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'failed', reason: 'new failure' }));
  assert.deepEqual(await catchup(), [`${id} imp: failed | new failure`]);
  assert.deepEqual((await f.call('hud_read')).jobs, [{ job: id, role: 'imp', state: 'failed', reason: 'new failure' }]);
});

test('hud_create idle_grace_s overrides CLI grace at both bounds and refuses invalid/pi/browser overrides', async (t) => {
  const f = await fixture(t);
  for (const value of [59, 3601, 60.5, '60']) {
    const result = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: `bad-${value}`, task: 'Synthetic.', idle_grace_s: value });
    assert.equal(result.code, 'invalid_arguments');
    assert.match(result.error, /integer from 60 to 3600/);
  }
  const pi = await f.call('hud_create', { role: 'imp', request_key: 'pi-grace', task: 'Synthetic.', idle_grace_s: 60 });
  assert.equal(pi.code, 'invalid_arguments');
  assert.match(pi.error, /pi grace follows the model's cache lifetime/);
  const bro = await f.call('hud_create', { role: 'pro', on: 'chatgpt', request_key: 'bro-grace', task: 'Synthetic.', idle_grace_s: 60 });
  assert.equal(bro.code, 'invalid_arguments');
  assert.match(bro.error, /browser jobs have no idle grace/);
  for (const value of [60, 3600]) {
    const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: `grace-${value}`, task: 'Synthetic.', idle_grace_s: value });
    assert.ok(job.job, JSON.stringify(job));
    assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).cli.idle_grace_s, value);
    assert.equal((await f.call('hud_read', { job: job.job, detail: true })).idle_grace_s, value);
    const brief = fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8');
    assert.match(brief, /run the --done command from the prompt/);
    assert.doesNotMatch(brief, /report written:/);
    assert.match(brief, /^Optional milestone: node .*\/hud-progress\.mjs" --dir /m);
  }
});

test('thin read lists and waits without opening discarded bodies, preserving observations', async (t) => {
  const f = await fixture(
    t,
    true,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync;
fs.openSync = function(path, ...args) {
  if (/\\/(report\\.md|qa\\/q\\d+\\.md)$/.test(String(path)))
    fs.appendFileSync(process.env.HOME + '/reads', String(path) + '\\n');
  return open.call(this, path, ...args);
};
syncBuiltinESMExports();`
  );
  const job = 'j0000000000000001',
    dir = join(f.env.HUD_HOME, 'jobs', job);
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  const receipt = { job, role: 'imp', cwd: f.root, created_at: '2026-01-01', dispatch_exit_code: 0, stderr_tail: '' };
  const save = () => fs.writeFileSync(join(dir, 'job.json'), JSON.stringify(receipt));
  const status = (state) => fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state, exit_reason: null }));
  const reads = () =>
    fs.existsSync(join(f.env.HOME, 'reads'))
      ? fs.readFileSync(join(f.env.HOME, 'reads'), 'utf8').trim().split('\n')
      : [];
  const read = (wait_ms = 0) => f.call('hud_read', { job, wait_ms, detail: true });
  save();
  status('working');
  fs.writeFileSync(join(dir, 'report.md'), 'r'.repeat(65537));
  fs.writeFileSync(join(dir, 'qa', 'q1.md'), 'Synthetic question.');
  assert.deepEqual((await f.call('hud_read')).jobs, [{
    job, role: 'imp', state: 'working', report_unread: true, question_ids: ['q1'],
  }]);
  assert.equal((await f.call('hud_read', { view: 'recent' })).jobs[0].open_questions, 1);
  assert.deepEqual(reads(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, 'job.json'))), receipt);
  const question = await read();
  assert.deepEqual(question.questions, [{ id: 'q1', text: 'Synthetic question.' }]);
  await f.call('hud_respond', { job, request_id: 'q1', answer: 'Synthetic answer.' });
  const before = reads().length,
    waiting = read(1100);
  await new Promise((done) => setTimeout(done, 600));
  assert.equal(reads().length, before);
  const timeout = await waiting;
  const omitted = { ...question, questions: [], report_unread: false, report_unchanged: true };
  delete omitted.report;
  delete omitted.report_truncated;
  assert.deepEqual(timeout, omitted);
  assert.equal(reads().length, before, 'already-read report is not reopened');
  assert.equal(question.report.length, 65536);
  assert.equal(question.report_truncated, true);
  assert.ok(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at);
  const newQuestion = read(3000);
  setTimeout(() => fs.writeFileSync(join(dir, 'qa', 'q2.md'), 'New question.'), 100);
  assert.deepEqual(await newQuestion, { ...timeout, questions: [{ id: 'q2', text: 'New question.' }] });
  await f.call('hud_respond', { job, request_id: 'q2', answer: 'Answered.' });
  for (const [state, display_state] of [
    ['idle_grace', 'done'],
    ['closed', 'done'],
    ['failed', 'failed'],
    ['stopped', 'stopped'],
    [null, 'working'],
  ]) {
    save();
    status('working');
    const pending = read(700);
    const timer = setTimeout(() => (state === null ? fs.unlinkSync(join(dir, 'STATUS.json')) : status(state)), 100);
    t.after(() => clearTimeout(timer));
    assert.deepEqual(await pending, { ...question, questions: [], state, display_state });
    assert.ok(JSON.parse(fs.readFileSync(join(dir, 'job.json'))).read_at);
  }
  receipt.dispatch_exit_code = 1;
  save();
  assert.deepEqual(await read(), { ...question, questions: [], state: 'failed', display_state: 'failed', dispatch_exit_code: 1 });
});

test('hud_create and hud_send derive keys for concurrent identical calls', async (t) => {
  const f = await fixture(t);
  const create = { role: 'imp', task: 'Synthetic task without a key.' };
  const [job, duplicate] = await Promise.all([f.call('hud_create', create), f.call('hud_create', create)]);
  assert.equal(duplicate.job, job.job);
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')), [job.job]);
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  const send = { job: job.job, text: 'Synthetic message without a key.' };
  const [first, second] = await Promise.all([f.call('hud_send', send), f.call('hud_send', send)]);
  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(second.ok, true);
  const file = join(job.task_dir, 'job.json');
  const receipt = JSON.parse(fs.readFileSync(file));
  assert.equal(receipt.message_keys, undefined);
  assert.equal(receipt.send_outcomes.length, 1);
  fs.writeFileSync(file, JSON.stringify({ ...receipt, message_keys: ['legacy-key'] }));
  assert.deepEqual(await f.call('hud_send', { ...send, message_key: 'legacy-key' }), { ok: false, sent: false, code: 'send_failed' });
  assert.equal(f.commands().filter(({ args }) => args[1] === 'prompt' && args[3] === send.text).length, 1);
});

test('hud_create starts a new job after the derived key window expires', async (t) => {
  const f = await fixture(t);
  const create = { role: 'imp', task: 'Synthetic task to run again later.' };
  const first = await f.call('hud_create', create);
  const file = join(first.task_dir, 'job.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  receipt.created_at = new Date(Date.now() - 11 * 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(receipt));
  const second = await f.call('hud_create', create);
  assert.notEqual(second.job, first.job);
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).sort(), [first.job, second.job].sort());
  assert.equal((await f.call('hud_create', create)).job, second.job);
});

test('hud_send sends again after the derived key window expires', async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', { role: 'imp', task: 'Synthetic working task.' });
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  const send = { job: job.job, text: 'Synthetic message to send again later.' };
  assert.equal((await f.call('hud_send', send)).sent, true);
  const file = join(job.task_dir, 'job.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  receipt.send_outcomes[0].recorded_at = new Date(Date.now() - 11 * 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.equal((await f.call('hud_send', send)).sent, true);
  assert.deepEqual(await f.call('hud_send', send), { ok: true, sent: false });
  assert.equal(f.commands().filter(({ args }) => args[1] === 'prompt' && args[3] === send.text).length, 2);
});

test('hud_send to several jobs sends once per working job and skips read-closed jobs', async (t) => {
  const f = await fixture(t);
  await f.startCliSocket();
  const create = (task) => f.call('hud_create', { role: 'imp', task });
  const working = await create('Synthetic working task.');
  const closed = await create('Synthetic settled task.');
  fs.writeFileSync(join(working.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  await publishPiGrace(closed);
  await f.call('hud_read', { job: closed.job });
  await until(() => cliState(closed.task_dir)?.exit_reason === 'closed after report read');
  const text = 'Synthetic shared message.';
  const result = await f.call('hud_send', { jobs: [closed.job, working.job, working.job], text });
  assert.deepEqual(result.sent, [working.job]);
  assert.deepEqual(result.skipped, [{ job: closed.job, reason: 'not_continuable' }]);
  assert.equal(f.commands().filter(({ args }) => args[1] === 'prompt' && args[3] === text).length, 1);
  assert.equal(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).length, 2);
});

test('thin send queues a message for a working pi job and refuses a finished one', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', { role: 'reviewer', request_key: 'send-queue', task: 'Synthetic task.' });
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  const sent = await f.call('hud_send', { job: job.job, message_key: 'queued', text: 'Synthetic addendum.' });
  assert.equal(sent.sent, true);
  assert.equal(sent.queued, true);
  const prompted = f.commands().filter((c) => c.args[0] === 'agent' && c.args[1] === 'prompt').at(-1);
  assert.deepEqual(prompted.args, ['agent', 'prompt', job.agent, 'Synthetic addendum.']);
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed' }));
  const late = await f.call('hud_send', { job: job.job, message_key: 'late', text: 'Synthetic late.' });
  assert.equal(late.code, 'not_continuable');
});

test(
  'thin send records failed and successful outcomes without retrying a message key',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const job = await f.call('hud_create', { role: 'imp', request_key: 'send-outcomes', task: 'Synthetic task.' });
    const dispatches = () => f.commands().filter((c) => c.command === 'herdr' && c.args[0] !== 'pane');
    const before = dispatches().length;
    await f.call('hud_read', { job: job.job });
    const receiptFile = join(job.task_dir, 'job.json');
    const stamp = JSON.parse(fs.readFileSync(receiptFile)).read_at;
    assert.ok(stamp);
    // An earlier read stamp survives sends; a newer, unread settled report still permits continuation.
    await new Promise((done) => setTimeout(done, 10));
    fs.writeFileSync(join(job.task_dir, 'report.md'), 'Unread settled report.');
    fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
    const herdr = join(f.root, 'bin', 'herdr');
    const fake = `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: 'herdr', args: process.argv.slice(2) }) + '\\n');
`;
    fs.writeFileSync(herdr, fake + "console.error('Synthetic prompt failure'); process.exit(9);\n");
    const args = { job: job.job, message_key: 'failed-send', text: 'Synthetic continuation.' };
    const failed = await f.call('hud_send', args);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'send_failed');
    assert.equal(failed.exit_code, 9);
    assert.match(failed.stderr_tail, /Synthetic prompt failure/);
    assert.equal(JSON.parse(fs.readFileSync(receiptFile)).read_at, stamp);
    // The transport is now healthy, but retrying the failed key must not claim delivery or resend.
    fs.writeFileSync(herdr, fake);
    const retry = await f.call('hud_send', args);
    assert.equal(retry.ok, false);
    assert.equal(retry.sent, false);
    assert.equal(retry.code, 'send_failed');
    assert.equal(retry.exit_code, failed.exit_code);
    assert.equal(retry.stderr_tail, failed.stderr_tail);
    assert.equal(dispatches().length, before + 1);
    const success = await f.call('hud_send', { ...args, message_key: 'successful-send' });
    assert.equal(success.ok, true);
    assert.equal(success.sent, true);
    assert.equal(JSON.parse(fs.readFileSync(receiptFile)).read_at, stamp);
    fs.writeFileSync(join(job.task_dir, 'report.md'), 'Second report after repairs.');
    const settled = Date.now();
    fs.writeFileSync(
      join(job.task_dir, 'STATUS.json'),
      JSON.stringify({ state: 'idle_grace', settled_at: new Date(settled).toISOString() })
    );
    // Settled is done, read or not: the panel has no "report unread" stage (owner, 2026-11-11).
    const unread = workerFor(f, job.job);
    assert.equal(projectWorkCard(unread, settled).state, 'done');
    assert.doesNotMatch(cardText(unread), /report ready/);
    assert.equal((await f.call('hud_read', { job: job.job })).report, 'Second report after repairs.');
    const secondStamp = JSON.parse(fs.readFileSync(receiptFile)).read_at;
    assert.ok(secondStamp);
    assert.deepEqual(await f.call('hud_send', { ...args, message_key: 'successful-send' }), { ok: true, sent: false });
    assert.equal(JSON.parse(fs.readFileSync(receiptFile)).read_at, secondStamp);
    assert.equal(dispatches().length, before + 2);
    const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
    assert.deepEqual(
      receipt.send_outcomes.map(({ key, exit_code }) => ({ key, exit_code })),
      [
        { key: 'failed-send', exit_code: 9 },
        { key: 'successful-send', exit_code: 0 },
      ]
    );
  }
);

test('thin roles load a custom role file and dispatch its mapped pi role', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const role = {
    role: 'synthetic-writer',
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    model: 'synthetic/override',
    thinking: 'high',
  };
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'));
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'writer.json'), JSON.stringify(role));
  const roster = await f.call('hud_roster', { detail: true });
  const place = {
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    model: 'synthetic/override',
    thinking: 'high',
  };
  assert.deepEqual(
    roster.roles.find((entry) => entry.role === role.role),
    {
      ...role,
      instructions: 'implementer',
      run: [place],
      presets: [],
      preset: null,
      runs_on: place,
      places: [{ index: 0, place, state: 'active', key: 'pi:synthetic/override', provider: 'synthetic', provider_source: 'model',
        switch_ids: ['pi', 'pi:synthetic'], pi_role_file: join(f.root, 'roles', 'implementer.md'),
        model: { value: 'synthetic/override', source: join(f.env.HUD_HOME, 'roles', 'writer.json') },
        thinking: { value: 'high', source: join(f.env.HUD_HOME, 'roles', 'writer.json') } }],
      exhausted: [],
      accepts_options: ['on', 'model', 'thinking', 'lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split', 'pi_args'],
      available: true,
      source_file: join(f.env.HUD_HOME, 'roles', 'writer.json'),
      model_source: join(f.env.HUD_HOME, 'roles', 'writer.json'),
      thinking_source: join(f.env.HUD_HOME, 'roles', 'writer.json'),
      pi_role_file: join(f.root, 'roles', 'implementer.md'),
    }
  );
  const imp = roster.roles.find((entry) => entry.role === 'imp');
  assert.equal(imp.model, 'synthetic/default');
  assert.equal(imp.thinking, 'low');
  assert.equal(imp.model_source, join(f.root, 'roles', 'implementer.md'));
  assert.equal(imp.thinking_source, imp.model_source);
  assert.equal(roster.roles.some((r) => r.role === 'architect'), false);
  const oracle = roster.roles.find((r) => r.role === 'oracle');
  assert.equal(oracle.preset, 'fable');
  assert.deepEqual(oracle.accepts_options, ['on', 'preset', 'model', 'thinking']);
  assert.deepEqual(oracle.presets, [
    { name: 'fable', run: oracle.run },
    { name: 'architect', run: [{ harness: 'pi', pi_role: 'architect', split: false }] },
  ]);
  for (const name of ['imp', 'reviewer']) {
    const r = roster.roles.find((r) => r.role === name);
    assert.equal(r.preset, 'default');
    assert.deepEqual(r.presets[0].run, r.run);
  }
  assert.deepEqual(imp.presets.map((p) => p.name), ['default', 'hydrogen']);
  for (const name of ['sonic', 'pro', 'flow', 'general']) {
    const r = roster.roles.find((r) => r.role === name);
    if (r) assert.deepEqual([r.presets, r.preset], [[], null]);
  }
  assert.deepEqual(withoutHint(await f.call('hud_create', { role: 'unknown', request_key: 'unknown', task: 'Synthetic task.' })), {
    ok: false,
    code: 'role_unavailable',
    reason: 'Role unknown is not configured or is hidden in this project',
  });
  const job = await f.call('hud_create', { role: role.role, request_key: 'custom-role', task: 'Synthetic task.' });
  const argv = f.commands().find((c) => c.command === 'pi-role').args;
  assert.ok(argv.includes('--dispatch-effort-source'));
  assert.equal(argv[argv.indexOf('--dispatch-label') + 1], role.role);
  assert.deepEqual(argv.slice(-4), ['--model', 'synthetic/override', '--thinking', 'high']);
  assert.equal(
    f.commands().some((c) => c.command === 'pi-dispatch' || c.args[1] === 'split'),
    false
  );
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  assert.equal(Object.hasOwn(receipt, 'package'), false);
  assert.equal(Object.hasOwn(receipt, 'preset'), false);
  fs.writeFileSync(join(job.task_dir, 'STATUS.json'), JSON.stringify({ state: 'idle_grace' }));
  assert.equal(
    (await f.call('hud_send', { job: job.job, message_key: 'custom-send', text: 'Synthetic follow-up.' })).sent,
    true
  );
  assert.equal(Object.hasOwn(await f.call('hud_read', { job: job.job }), 'preset'), false);
});

test(
  'thin create overrides pi argv and records the job assignment without changing defaults',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const args = {
      role: 'imp',
      request_key: 'model-override',
      task: 'Synthetic task.',
      model: 'synthetic/any-model',
      thinking: 'max',
    };
    const job = await f.call('hud_create', args);
    const argv = f.commands().find((c) => c.command === 'pi-role').args;
    assert.deepEqual(argv.slice(-4), ['--model', args.model, '--thinking', args.thinking]);
    assert.ok(argv.indexOf('--model') > argv.indexOf('--'));
    assert.ok(
      f
        .commands()
        .find((c) => c.args[0] === 'agent' && c.args[1] === 'start')
        .args.includes(args.model)
    );
    const receipt = () => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
    for (const value of [receipt(), await f.call('hud_read', { job: job.job, detail: true })]) {
      assert.equal(value.model, args.model);
      assert.equal(value.thinking, args.thinking);
      assert.equal(value.model_source, 'hud_create');
    }
    const launches = () => f.commands().filter((c) => c.command === 'pi-role').length;
    assert.deepEqual(await f.call('hud_create', { ...args, model: '', thinking: 'low' }), withoutHint(job));
    assert.equal(launches(), 1);
    assert.equal(receipt().model, args.model);
    const defaults = await f.call('hud_create', { role: 'imp', request_key: 'model-default', task: 'Synthetic task.' });
    const original = JSON.parse(fs.readFileSync(join(defaults.task_dir, 'job.json')));
    assert.equal(original.model, 'synthetic/default');
    assert.equal(original.thinking, 'low');
    assert.equal(launches(), 2);
    const thinkingOnly = await f.call('hud_create', {
      role: 'imp',
      request_key: 'thinking-only',
      task: 'Synthetic task.',
      thinking: 'max',
    });
    for (const value of [
      JSON.parse(fs.readFileSync(join(thinkingOnly.task_dir, 'job.json'))),
      await f.call('hud_read', { job: thinkingOnly.job, detail: true }),
    ]) {
      assert.equal(value.model, 'synthetic/default');
      assert.equal(value.thinking, 'max');
      assert.equal(value.model_source, join(f.root, 'roles', 'implementer.md'));
    }
  }
);

test('hud_create uses a merged preset for one job and falls back within it without editing roles', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const roles = join(f.env.HUD_HOME, 'roles');
  const file = join(roles, 'imp.json');
  const role = {
    role: 'imp', instructions: 'implementer', can_continue: true,
    run: [{ harness: 'pi', model: 'synthetic/normal', skills: ['normal-only'] }],
    presets: [{ name: 'default', run: [
      { harness: 'pi', model: 'synthetic/primary', thinking: 'low' },
      { harness: 'pi', pi_role: 'reviewer', model: 'synthetic/backup', thinking: 'high', split: true },
    ] }],
  };
  const original = JSON.stringify(role, null, 2) + '\n';
  fs.mkdirSync(roles);
  fs.writeFileSync(file, original);
  const roster = async () => (await f.call('hud_roster', { detail: true })).roles.find((r) => r.role === 'imp');
  const before = await roster();
  assert.equal(before.runs_on.model, 'synthetic/normal');
  assert.ok(before.accepts_options.includes('preset'));

  const args = { role: 'imp', preset: 'default', task: 'Synthetic task.' };
  const receipt = (job) => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  const piArgv = () => f.commands().filter((c) => c.command === 'pi-role').at(-1).args;
  const first = await f.call('hud_create', { ...args, request_key: 'preset-primary' });
  assert.equal(receipt(first).dispatch_exit_code, 0);
  assert.equal(receipt(first).preset, 'default');
  assert.deepEqual(piArgv().slice(-4), ['--model', 'synthetic/primary', '--thinking', 'low']);
  assert.equal((await f.call('hud_read', { job: first.job, detail: true })).preset, 'default');
  assert.deepEqual(receipt(first).skipped_skills, []); // No skills inherited from the unselected default run.

  markExhausted(f.env.HUD_HOME, 'pi:synthetic/primary', 'rate limit');
  const fallback = await f.call('hud_create', {
    ...args, request_key: 'preset-fallback', lens: false, split: false,
  });
  const record = receipt(fallback);
  assert.equal(record.dispatch_exit_code, 0);
  assert.equal(record.preset, 'default');
  assert.equal(record.place.pi_role, 'reviewer');
  assert.equal(record.model_source, file);
  assert.deepEqual(piArgv().slice(-4), ['--model', 'synthetic/backup', '--thinking', 'high']);
  assert.ok(piArgv().includes('--no-lens'));
  const read = await f.call('hud_read', { job: fallback.job, detail: true });
  assert.deepEqual([read.preset, read.model, read.split], ['default', 'synthetic/backup', false]);
  const override = await f.call('hud_create', { ...args, request_key: 'preset-override', model: 'synthetic/override' });
  assert.equal(receipt(override).place.pi_role, 'implementer', 'quota on the old model does not exhaust an override');
  assert.equal(receipt(override).place_key, 'pi:synthetic/override');
  assert.equal(receipt(override).model_source, 'hud_create');
  assert.deepEqual(piArgv().slice(-4), ['--model', 'synthetic/override', '--thinking', 'low']);
  assert.equal((await f.call('hud_create', { ...args, request_key: 'preset-fallback', preset: 'hydrogen' })).job, fallback.job);

  markExhausted(f.env.HUD_HOME, 'pi:synthetic/backup', 'rate limit');
  const unavailable = await f.call('hud_create', { ...args, request_key: 'preset-unavailable' });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'no_available_place');
  assert.deepEqual(unavailable.exhausted.map((p) => p.key), ['pi:synthetic/primary', 'pi:synthetic/backup']);
  assert.equal(f.commands().filter((c) => c.command === 'pi-role').length, 3);
  assert.deepEqual(await roster(), before);
  assert.deepEqual(fs.readdirSync(roles), ['imp.json']);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('roster and default create route the active selector, while explicit preset is read-only and one-job', async (t) => {
  const f = await fixture(t);
  const roles = join(f.env.HUD_HOME, 'roles'), file = join(roles, 'imp.json');
  const run = [{ harness: 'pi', model: 'synthetic/file' }];
  fs.mkdirSync(roles);
  fs.writeFileSync(file, JSON.stringify({ role: 'imp', instructions: 'implementer', can_continue: true, run,
    active_preset: 'same-b', hidden_presets: ['hydrogen'], presets: [
      { name: 'same-a', run: [{ harness: 'pi', model: 'synthetic/named', thinking: 'high' }] },
      { name: 'same-b', run: [{ harness: 'pi', model: 'synthetic/named', thinking: 'high' }] },
      { name: 'file-copy', run },
    ] }));
  const start = fs.readFileSync(file, 'utf8');
  const roster = async (detail) => (await f.call('hud_roster', { detail })).roles.find((r) => r.role === 'imp');
  const selected = await roster(true);
  assert.equal((await roster(false)).preset, 'same-b');
  assert.equal(selected.preset, 'same-b');
  assert.equal(selected.run[0].model, 'synthetic/named');
  assert.equal(selected.runs_on.model, 'synthetic/named');
  assert.equal(selected.presets.some((p) => p.name === 'hydrogen'), false);
  const create = async (key, preset) => {
    const job = await f.call('hud_create', { role: 'imp', request_key: key, preset, task: 'Synthetic task.' });
    return JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  };
  assert.equal((await create('selector')).model, 'synthetic/named');
  assert.equal((await create('named-override', 'file-copy')).model, 'synthetic/file');
  assert.deepEqual(await roster(true), selected);
  assert.equal(fs.readFileSync(file, 'utf8'), start);
});

test('hud_create rejects unknown, conflicting and malformed preset arguments before dispatch', async (t) => {
  const f = await fixture(t);
  const args = { role: 'imp', request_key: 'invalid-preset', task: 'Synthetic task.' };
  assert.deepEqual(withoutHint(await f.call('hud_create', { ...args, preset: 'missing' })), {
    ok: false, code: 'invalid_arguments', error: 'unknown preset: missing',
  });
  assert.deepEqual(await f.call('hud_create', { ...args, preset: 'default', on: 'pi' }), {
    ok: false, code: 'invalid_arguments', error: 'preset and on are mutually exclusive',
  });
  for (const preset of ['', 42, null]) {
    const { result } = await f.rpc('tools/call', { name: 'hud_create', arguments: { ...args, preset } });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      ok: false, code: 'tool_error', error: 'invalid_arguments: preset',
    });
  }
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
});

test('hud_create prepends resolved local references and does not revalidate an existing request', async (t) => {
  const f = await fixture(t);
  const cwd = join(f.root, 'workspace');
  const path = join(cwd, 'source notes.md');
  fs.mkdirSync(cwd);
  const line = 'Synthetic context that the worker reads directly.\n';
  fs.writeFileSync(path, line.repeat(1500)); // Local references have no browser byte cap.
  fs.symlinkSync(path, join(cwd, 'alias.md'));
  const args = { role: 'imp', request_key: 'context-pi', cwd, task: '# Synthetic task', context_files: ['alias.md'] };
  const job = await f.call('hud_create', args);
  const briefPath = join(job.task_dir, 'brief.md');
  const brief = fs.readFileSync(briefPath, 'utf8');
  assert.equal(brief, `${args.task}\n\n## Context References\n\nRead these files for task context:\n\n- ${JSON.stringify(path)}\n\nFinish with \`hud_report\`.\n`);
  assert.ok(!brief.includes(line));
  const receiptPath = join(job.task_dir, 'job.json');
  const receipt = fs.readFileSync(receiptPath, 'utf8');
  assert.deepEqual(JSON.parse(receipt).context_files, [path]);
  fs.unlinkSync(path);
  assert.equal((await f.call('hud_create', { ...args, from_jobs: ['malformed'] })).job, job.job);
  assert.equal(fs.readFileSync(briefPath, 'utf8'), brief);
  assert.equal(fs.readFileSync(receiptPath, 'utf8'), receipt);
  assert.deepEqual(f.commands().filter(({ command, args }) => command === 'herdr' && args[0] === 'tab' && args[1] === 'create')
    .map(({ args }) => args[args.indexOf('--label') + 1]), ['imp Synthetic task']);
});

test('local dispatch uses standing briefs only in registered projects without changing task labels', async (t) => {
  const f = await fixture(t);
  git(f.root, 'init', '-q');
  const cwd = join(f.root, 'workspace'), hud = join(f.root, '.hud');
  fs.mkdirSync(cwd);
  fs.mkdirSync(hud);
  const standing = join(hud, 'brief.md');
  fs.writeFileSync(standing, '# Standing rules\nSynthetic project-wide instructions.\n');
  const task = 'Synthetic task title.';
  const unregistered = await f.call('hud_create', { role: 'imp', cwd, task });
  assert.equal(fs.readFileSync(join(unregistered.task_dir, 'brief.md'), 'utf8'), `${task}\n\nFinish with \`hud_report\`.\n`);
  registerBriefProject(f);
  const job = await f.call('hud_create', { role: 'imp', cwd, task, request_key: 'registered' });
  assert.equal(fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'),
    `${task}\n\nRead the project standing brief: ${JSON.stringify(standing)}.\n\nFinish with \`hud_report\`.\n`);
  assert.equal(workerFor(f, job.job).task, task);
  const tab = f.commands().find(({ args }) => args[0] === 'tab' && args[1] === 'create').args;
  assert.equal(tab[tab.indexOf('--label') + 1], `imp ${task}`);
});

function registerBriefProject(f) {
  fs.writeFileSync(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({
    version: 1, projects: [{ root: fs.realpathSync(f.root), registered_at: new Date().toISOString() }],
  }));
}

test('browser dispatch inlines the registered standing brief once through the bounded context block', async (t) => {
  const f = await fixture(t);
  const hud = join(f.root, '.hud'), standing = join(hud, 'brief.md');
  fs.mkdirSync(hud);
  const args = { role: 'pro', task: 'Synthetic browser task' };
  fs.writeFileSync(standing, 'é'.repeat(32 * 1024) + 'x');
  const unregistered = await f.call('hud_create', { ...args, request_key: 'unregistered' });
  assert.equal(fs.readFileSync(join(unregistered.task_dir, 'brief.md'), 'utf8'), `${args.task}\n`);
  registerBriefProject(f);
  assert.equal((await f.call('hud_create', args)).code, 'context_too_large');
  const body = 'Synthetic standing instructions.\n';
  fs.writeFileSync(standing, body);
  const job = await f.call('hud_create', { ...args, context_files: ['.hud/brief.md'] });
  assert.equal(fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'),
    `${args.task}\n\n## Context\n\n### ${JSON.stringify(standing)}\n\n\`\`\`\n${body}\`\`\`\n`);
  assert.equal(workerFor(f, job.job).task, args.task);
});

test('hud_create inlines browser context with safe fences and caps both file and total bytes', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const max = 64 * 1024;
  const upstream = waitFixtureJob(f, 1, 'idle_grace');
  const report = join(upstream.dir, 'report.md');
  const sample = 'Synthetic file; cost: 90 credits.\n`````\nSynthetic code.\n`````\n';
  const body = sample.padEnd(max, 'x');
  fs.writeFileSync(join(f.root, 'sample.md'), body);
  for (const path of [report, join(f.root, 'a.md'), join(f.root, 'b.md')]) fs.writeFileSync(path, 'é'.repeat(max / 2));
  fs.writeFileSync(join(f.root, 'extra.md'), 'x');
  fs.writeFileSync(join(f.root, 'big.md'), 'é'.repeat(max / 2) + 'x');
  const args = { role: 'pro', request_key: 'context-bro', task: 'Synthetic browser task.' };
  const files = ['sample.md', 'a.md', 'b.md'];
  for (const input of [{ context_files: ['big.md'] }, { context_files: [...files, 'extra.md'], from_jobs: [upstream.job] }]) {
    const result = await f.call('hud_create', { ...args, ...input });
    assert.equal(result.code, 'context_too_large', JSON.stringify(result));
  }
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')), [upstream.job]);
  assert.deepEqual(withoutCallerLookups(f.commands()), []);

  const job = await f.call('hud_create', { ...args, context_files: files, from_jobs: [upstream.job] });
  const brief = fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8');
  assert.ok(brief.startsWith(`${args.task}\n\n## Context\n\n### ${JSON.stringify(join(f.root, 'sample.md'))}\n\n` +
    '``````\n' + body + '\n``````\n'));
  assert.ok(brief.includes(`### ${upstream.job} report: ${JSON.stringify(report)}\n\n\`\`\`\n${'é'.repeat(max / 2)}\n\`\`\`\n`));
  const flow = await f.call('hud_create', {
    role: 'flow', kind: 'video', request_key: 'context-flow', task: 'Synthetic video.', context_files: ['sample.md'],
  });
  assert.equal(flow.code, 'dispatch_failed');
  const flowArgs = f.commands().find(({ command }) => command === 'jev-flow').args;
  assert.ok(!flowArgs.includes('--confirm-credits'), 'an attached cost statement does not confirm spending');
});

test('hud_create rejects invalid context paths, symlinks and binary content without dispatch', async (t) => {
  const f = await fixture(t);
  const cwd = join(f.root, 'workspace');
  const sibling = join(f.root, 'workspace-other');
  fs.mkdirSync(cwd);
  fs.mkdirSync(sibling);
  const outside = join(sibling, 'outside.md');
  fs.writeFileSync(outside, 'Synthetic outside text.');
  fs.symlinkSync(sibling, join(cwd, 'escape'));
  fs.writeFileSync(join(cwd, 'binary'), Buffer.from([65, 0, 66]));
  fs.writeFileSync(join(cwd, 'invalid-utf8'), Buffer.concat([Buffer.alloc(64 * 1024, 65), Buffer.from([0xc3])]));
  const empty = waitFixtureJob(f, 1);
  const escaped = waitFixtureJob(f, 2);
  fs.symlinkSync(outside, join(escaped.dir, 'report.md'));
  const args = { role: 'imp', request_key: 'invalid-context', task: 'Synthetic task.', cwd };
  for (const input of [
    ...['missing', '.', 'nul\0.md', '../workspace-other/outside.md', 'escape/outside.md', 'binary', 'invalid-utf8']
      .map((path) => ({ context_files: [path] })),
    { context_files: [1] }, { context_files: Array(33).fill('missing') },
    { from_jobs: ['../report.md'] }, { from_jobs: [empty.job] }, { from_jobs: [escaped.job] },
    { from_jobs: Array(17).fill(empty.job) },
  ]) {
    const result = await f.call('hud_create', { ...args, ...input });
    assert.equal(result.code, 'invalid_arguments', JSON.stringify(input));
  }
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).sort(), [empty.job, escaped.job]);
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
});

test('hud_create references an upstream report without marking it read or closing its worker', async (t) => {
  const f = await fixture(t);
  const upstream = await f.call('hud_create', { role: 'imp', request_key: 'context-upstream', task: 'Synthetic upstream task.' });
  await publishPiGrace(upstream);
  const receiptPath = join(upstream.task_dir, 'job.json');
  const original = fs.readFileSync(receiptPath, 'utf8');
  const downstream = await f.call('hud_create', {
    role: 'imp', request_key: 'context-downstream', task: 'Synthetic downstream task.', from_jobs: [upstream.job],
  });
  const brief = fs.readFileSync(join(downstream.task_dir, 'brief.md'), 'utf8');
  assert.ok(brief.includes(`- ${upstream.job} report: ${JSON.stringify(join(upstream.task_dir, 'report.md'))}`));
  assert.ok(!brief.includes('Synthetic settled pi report.'));
  assert.deepEqual(JSON.parse(fs.readFileSync(join(downstream.task_dir, 'job.json'), 'utf8')).from_jobs, [upstream.job]);
  assert.equal(fs.readFileSync(receiptPath, 'utf8'), original);
  assert.equal(cliState(upstream.task_dir).state, 'idle_grace');
  assert.equal(reapAttempts(f, upstream), 0);
});

test('thin resume forwards the session ID without overriding pi default lookup', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.call('hud_create', {
    role: 'imp',
    request_key: 'synthetic-resume',
    task: 'Continue synthetic history',
    pi_args: ['--session', '11111111-2222-4333-8444-555555555555'],
  });
  const start = f.commands().find((c) => c.args[0] === 'agent' && c.args[1] === 'start').args;
  assert.deepEqual(start.slice(-2), ['--session', '11111111-2222-4333-8444-555555555555']);
  assert.equal(start.includes('--session-dir'), false);
});
test('thin pi launch switches and verbatim arguments reach argv, receipts and reads', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const enabled of [false, true]) {
    const options = {
      lens: enabled,
      mcp: !enabled,
      tps: enabled,
      ui_ext: enabled,
      skills: !enabled,
      split: !enabled,
      pi_args: ['--tools', 'read', 'literal space;$(not-a-command)'],
    };
    const args = { role: 'imp', request_key: `launch-${enabled}`, task: 'Synthetic task.', ...options };
    const job = await f.call('hud_create', args);
    const argv = f
      .commands()
      .filter((c) => c.command === 'pi-role')
      .at(-1).args;
    const before = argv.slice(0, argv.indexOf('--'));
    for (const key of ['lens', 'mcp', 'tps']) assert.ok(before.includes(`--${options[key] ? '' : 'no-'}${key}`));
    assert.equal(before.includes('--no-ui-ext'), !enabled);
    assert.equal(before.includes('--skills'), !enabled);
    assert.deepEqual(argv.slice(-options.pi_args.length), options.pi_args);
    assert.ok(argv.indexOf('--tools') > argv.indexOf('--'));
    const start = f
      .commands()
      .filter((c) => c.args[0] === 'agent' && c.args[1] === 'start')
      .at(-1).args;
    assert.deepEqual(start.slice(-options.pi_args.length), options.pi_args);
    assert.equal(start[start.indexOf('--pane') + 1], 'w4E:p2');
    const receipt = () => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
    for (const value of [receipt(), await f.call('hud_read', { job: job.job, detail: true })])
      for (const [key, expected] of Object.entries(options)) assert.deepEqual(value[key], expected);
    assert.match(fs.readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8'), enabled ? /^RIGHT=$/m : /^RIGHT=w4E:p3$/m);
    assert.deepEqual(await f.call('hud_create', { ...args, lens: !enabled, pi_args: [] }), withoutHint(job));
    assert.equal(receipt().lens, enabled);
    assert.deepEqual(receipt().pi_args, options.pi_args);
  }
  assert.equal(f.commands().filter((c) => c.command === 'pi-role').length, 2);
  const defaults = await f.call('hud_create', { role: 'imp', request_key: 'launch-default', task: 'Synthetic task.' });
  const original = await f.call('hud_read', { job: defaults.job, detail: true });
  assert.equal(original.split, false);
  assert.equal(original.lens, undefined);
  assert.deepEqual(original.pi_args, []);
});

test('thin launch options reject Jev roles and invalid pi values before dispatch', async (t) => {
  const f = await fixture(t);
  const keys = ['lens', 'mcp', 'tps', 'ui_ext', 'skills', 'split', 'pi_args'];
  assert.deepEqual((await f.call('hud_roster', { detail: true })).roles.find((r) => r.role === 'pro').accepts_options, ['on']);
  for (const key of keys) {
    const value = key === 'pi_args' ? ['--tools', 'read'] : false;
    assert.deepEqual(
      withoutHint(await f.call('hud_create', { role: 'pro', request_key: 'jev-launch', task: 'Synthetic.', [key]: value })),
      { ok: false, code: 'invalid_arguments' }
    );
    assert.deepEqual(
      await f.call('hud_create', { role: 'imp', request_key: 'bad-launch', task: 'Synthetic.', [key]: 'invalid' }),
      { ok: false, code: 'invalid_arguments' }
    );
  }
  for (const pi_args of [[1], Array(129).fill('a'), ['a'.repeat(4097)], null])
    assert.deepEqual(
      await f.call('hud_create', { role: 'imp', request_key: 'bad-args', task: 'Synthetic.', pi_args }),
      { ok: false, code: 'invalid_arguments' }
    );
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
});

test('thin create rejects model or thinking overrides for Jev roles', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const override of [{ model: 'synthetic/other' }, { thinking: 'max' }]) {
    assert.deepEqual(
      withoutHint(await f.call('hud_create', {
        role: 'pro',
        request_key: 'jev-override',
        task: 'Synthetic question.',
        ...override,
      })),
      {
        ok: false,
        code: 'invalid_arguments',
      }
    );
  }
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
});

test('thin Jev roles run the real wrapper in an unfocused tab and deduplicate sends', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const args = { role: 'pro', request_key: 'pro-once', task: 'Synthetic question.' };
  const job = await f.call('hud_create', args);
  assert.equal(fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'), `${args.task}\n`);
  assert.deepEqual(await f.call('hud_create', args), withoutHint(job));
  const asks = f.commands().filter(({ command }) => command === 'jev-ask');
  assert.deepEqual(
    asks.map(({ args }) => args[0]),
    ['key', 'send', 'wait']
  );
  assert.equal(asks[1].args[asks[1].args.indexOf('--effort') + 1], '6 Pro');
  assert.equal(asks[2].args[asks[2].args.indexOf('--answer-file') + 1], join(job.task_dir, 'report.md'));
  assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic Jev answer.');
  const tab = f.commands().find(({ command, args }) => command === 'herdr' && args[0] === 'tab' && args[1] === 'create').args;
  assert.ok(tab.includes('--no-focus'));
  assert.equal(tab[tab.indexOf('--workspace') + 1], 'w4E');
  assert.equal(tab[tab.indexOf('--env') + 1], `HUD_JOB_DIR=${job.task_dir}`);
  // Spec §2.1: the end reaches the main session through the job row, never typed into its pane.
  assert.equal(
    f.commands().some(({ command, args }) => command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt'),
    false
  );
  const state = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json')));
  assert.equal(state.state, 'closed');
  assert.equal(state.harness, 'bro');
  assert.equal(state.provider, 'openai');
  assert.equal(workerFor(f, job.job).harness, 'bro');
  assert.match(cardText(workerFor(f, job.job)), /pro.*Synthetic question/);
  assert.equal(state.output_written, true);
  assert.equal(state.exit_reason, 'settled');
  assert.equal((await f.call('hud_read', { job: job.job })).report, 'Synthetic Jev answer.');
  assert.equal(
    (await f.call('hud_send', { job: job.job, message_key: 'no-send', text: 'Synthetic follow-up.' })).code,
    'not_continuable'
  );
  assert.equal((await f.call('hud_roster')).roles.find(({ role }) => role === 'pro').can_continue, false);
  assert.equal((await f.call('hud_close', { job: job.job })).exit_code, 0);
  assert.deepEqual(f.commands().at(-1), { command: 'pi-role-reap', args: [job.task_dir] });
  for (const args of [
    { role: 'pro', on: 'gemini', request_key: 'gemini', task: 'Synthetic request.' },
    { role: 'pro', on: 'argon', request_key: 'argon', task: 'Synthetic request.' },
    { role: 'flow', request_key: 'flow', task: 'Synthetic request.' },
  ]) {
    const other = await f.call('hud_create', args);
    assert.equal((await f.call('hud_read', { job: other.job })).state, 'closed');
  }
});

test(
  'worker tab labels read as role and title on one line, with a suffix only on a clash',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const create = (request_key, task) => f.call('hud_create', { role: 'sonic', request_key, task });
    const task = '# Fix the panel footer\n\nA longer description.';
    const [first, second] = [await create('a', task), await create('b', task)];
    const cjk = await create('c', '大型任务：请把面板底部的按键提示改成不会被截断的版本，并且保持中文宽度正确');
    const labels = f
      .commands()
      .filter((c) => c.command === 'herdr' && c.args[0] === 'tab' && c.args[1] === 'create')
      .map((c) => c.args[c.args.indexOf('--label') + 1]);
    assert.equal(labels[0], 'sonic Fix the panel footer');
    assert.match(labels[1], /^sonic Fix the panel \S+ [0-9a-f]{4}$/);
    assert.ok(labels[1].endsWith(second.job.slice(-4)));
    assert.match(labels[2], /^sonic 大型任务.*…$/);
    for (const label of labels) assert.ok(label.replace(/[\u2e80-\ua4cf\uff00-\uff60]/g, 'xx').length <= 28, label);
    // pi-role-reap compares the recorded name with the tab, so it must be the same single line.
    for (const [job, label] of [
      [first, labels[0]],
      [second, labels[1]],
      [cjk, labels[2]],
    ])
      assert.match(fs.readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8'), new RegExp(`^TAB_NAME=${label}$`, 'm'));
  }
);

test('thin Flow video confirms only a stated credit cost', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  for (const [key, task, confirmed] of [
    ['no-cost', 'Synthetic video.', false],
    ['cost', 'Synthetic video; cost: 20 credits', true],
  ]) {
    const job = await f.call('hud_create', { role: 'flow', kind: 'video', request_key: key, task });
    const args = f
      .commands()
      .filter(({ command }) => command === 'jev-flow')
      .at(-1).args;
    assert.equal(args.includes('--confirm-credits'), confirmed);
    const read = await f.call('hud_read', { job: job.job });
    assert.equal(read.state, confirmed ? 'closed' : 'failed');
    if (confirmed) {
      assert.equal(args[args.indexOf('--confirm-credits') + 1], '20');
      assert.match(read.report, /synthetic-media.mp4/);
      assert.equal(fs.existsSync(join(job.task_dir, 'media', 'synthetic-media.mp4')), true);
    } else assert.equal(read.report_exists, false);
  }
});

test('thin create requires herdr without dispatching', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, false);
  const roster = await f.call('hud_roster');
  assert.equal(Object.hasOwn(roster, 'watcher_alive'), false);
  assert.match(roster.hint, /^Without live delivery, .*`hud_wait`/);
  assert.deepEqual(
    await f.call('hud_create', {
      role: 'imp',
      request_key: 'no-herdr',
      task: 'Synthetic task.',
    }),
    { ok: false, code: 'herdr_required', hint: roster.hint }
  );
  assert.deepEqual(f.commands(), []);
});

test('a running job says what its role does: only an implementer builds', () => {
  assert.equal(runningVerb('imp', 'pi'), 'build');
  assert.equal(runningVerb('glm-imp', 'pi'), 'build');
  assert.equal(runningVerb('reviewer', 'pi'), 'reviewing');
  assert.equal(runningVerb('architect', 'pi'), 'researching');
  assert.equal(runningVerb('oracle', 'bro'), 'asking web');
  assert.equal(runningVerb('pro', 'bro'), 'asking web');
  assert.equal(runningVerb('flow', 'bro'), 'generating');
  assert.equal(runningVerb('sonic', 'pi'), 'working');
  assert.equal(runningVerb('grok-imp', 'cli'), 'build');
});

const cliStatusKeys = [
  'version',
  'task_dir',
  'slot',
  'harness',
  'agent',
  'role',
  'model',
  'thinking',
  'state',
  'output_path',
  'output_written',
  'pid',
  'pid_start_time',
  'agent_session_id',
  'started_at',
  'settled_at',
  'idle_deadline_at',
  'ended_at',
  'exit_reason',
  'error',
  'updated_at',
];
function assertCliStatus(status, dir) {
  for (const key of cliStatusKeys) assert.equal(Object.hasOwn(status, key), true, key);
  assert.equal(Object.hasOwn(status, 'session_id'), false);
  assert.equal(status.version, 1);
  assert.equal(status.slot, 'primary');
  assert.equal(status.harness, 'cli');
  assert.equal(status.agent, 'grok');
  assert.equal(status.task_dir, fs.realpathSync(dir));
}

test('cli kind table holds launch facts and the registry accepts only a valid cli role', async (t) => {
  assert.deepEqual(cliKinds.grok.model('grok-4.7'), ['-m', 'grok-4.7']);
  assert.deepEqual(cliKinds.grok.effort('high'), ['--reasoning-effort', 'high']);
  assert.deepEqual(cliKinds.grok.bypass, ['--permission-mode', 'bypassPermissions']);
  assert.equal(cliKinds.grok.trust.decline[0], 'n');
  assert.equal(cliKinds.grok.startTimeoutMs, null);
  assert.equal(cliKinds.agy.startupQuirk, 'done-before-prompt');
  assert.equal(cliKinds.agy.trust.text, 'Do you trust the contents of this project?');
  assert.deepEqual([...cliKinds.agy.trust.decline], ['down', 'enter']);
  assert.deepEqual(cliKinds.agy.model('gemini-4-hydrogen-high'), ['--model', 'gemini-4-hydrogen-high']);
  assert.deepEqual(cliKinds.agy.bypass, ['--dangerously-skip-permissions']);
  assert.equal(cliKinds.claude.trust.text, 'Is this a project you created or one you trust?');
  assert.deepEqual([...cliKinds.claude.trust.decline], ['enter']);
  assert.deepEqual(cliKinds.claude.model('opus'), ['--model', 'opus']);
  assert.deepEqual(cliKinds.claude.effort('high'), ['--effort', 'high']);
  assert.deepEqual(cliKinds.claude.bypass, ['--dangerously-skip-permissions']);
  assert.equal(cliKinds.codex.startTimeoutMs, 90000);
  assert.equal(cliKinds.codex.startupQuirk, 'phantom-working');
  assert.equal(cliKinds.codex.trust, null);
  assert.deepEqual(cliKinds.codex.model('gpt-6.1-sol'), ['-m', 'gpt-6.1-sol']);
  assert.deepEqual(cliKinds.codex.effort('high'), ['-c', 'model_reasoning_effort=high']);
  assert.deepEqual(cliKinds.codex.bypass, ['--dangerously-bypass-approvals-and-sandbox']);
  const f = await fixture(t);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  const customCli = join(f.env.HUD_HOME, 'roles', 'cli-check.json');
  fs.writeFileSync(
    customCli,
    JSON.stringify({ role: 'cli-check', harness: 'cli', agent: 'grok', model: 'grok-4.7', thinking: 'high', can_continue: true })
  );
  const roster = (await f.call('hud_roster', { detail: true })).roles;
  for (const deleted of ['grok-imp', 'agy-imp', 'claude-imp', 'codex-imp', 'argon', 'gemini', 'flow-video']) {
    assert.equal(roster.some((entry) => entry.role === deleted), false, deleted);
  }
  const role = roster.find((entry) => entry.role === 'cli-check');
  assert.equal(role.harness, 'cli');
  assert.equal(role.agent, 'grok');
  assert.equal(role.model, 'grok-4.7');
  assert.equal(role.thinking, 'high');
  assert.equal(role.can_continue, true);
  assert.deepEqual(role.accepts_options, ['on', 'model', 'thinking']);
  assert.equal(role.pi_role_file, null);
  const imp = roster.find((entry) => entry.role === 'imp');
  assert.deepEqual(imp.run.map((place) => place.harness), ['pi']);
  const reviewer = roster.find((entry) => entry.role === 'reviewer');
  assert.deepEqual(reviewer.run.map((place) => place.harness), ['pi', 'cli']);
  fs.unlinkSync(customCli);
  const bad = async (body) => {
    fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
    const path = join(f.env.HUD_HOME, 'roles', 'bad.json');
    fs.writeFileSync(path, JSON.stringify(body));
    const roster = await f.call('hud_roster');
    assert.equal(
      roster.roles.some((entry) => entry.role === 'imp'),
      true
    );
    assert.deepEqual(roster.invalid, [{ path, reason: 'bad cli fields' }]);
    assert.equal(JSON.stringify(roster.invalid).includes('not-an-array'), false);
  };
  await bad({ role: 'bad', harness: 'cli', agent: 'nope', can_continue: true });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok' });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok', can_continue: true, idle_grace_s: -1 });
  await bad({ role: 'bad', harness: 'cli', agent: 'grok', can_continue: true, args: 'not-an-array' });
  fs.unlinkSync(join(f.env.HUD_HOME, 'roles', 'bad.json'));
  const cleared = await f.call('hud_roster');
  assert.equal(
    cleared.roles.some((entry) => entry.role === 'imp'),
    true
  );
  assert.equal(cleared.invalid, undefined);
});

test('a bad role file is skipped; roster and create name it without dropping other roles', async (t) => {
  const f = await fixture(t);
  const rolesDir = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(rolesDir, { recursive: true });
  const writer = { role: 'synthetic-writer', harness: 'pi', pi_role: 'implementer', split: false, can_continue: true };
  fs.writeFileSync(join(rolesDir, 'writer.json'), JSON.stringify(writer));
  const badPath = join(rolesDir, 'bad.json');
  const secret = 'SECRET_ROLE_FILE_BODY_MUST_NOT_LEAK';
  const cases = [
    [`{${secret}`, 'unparseable JSON', null],
    [JSON.stringify({ role: 'bad', harness: 'browser' }), 'unknown harness browser', 'bad'],
    [JSON.stringify({ role: 'bad', harness: secret }), 'unknown harness invalid', 'bad'],
    [JSON.stringify({ harness: 'pi', note: secret }), 'missing role', null],
    [JSON.stringify({ role: 'bad', harness: 'pi', split: false, can_continue: true }), 'bad pi fields', 'bad'],
    [JSON.stringify({ role: 'bad', harness: 'cli', agent: 'nope', can_continue: true }), 'bad cli fields', 'bad'],
    [JSON.stringify({ role: 'bad', harness: 'jev', tool: 'jev-ask' }), 'bad bro fields', 'bad'],
    [
      JSON.stringify({
        role: 'bad',
        harness: 'pi',
        pi_role: 'implementer',
        split: false,
        can_continue: true,
        model: 1,
      }),
      'bad model/thinking/effort',
      'bad',
    ],
  ];
  for (const [body, reason, roleName] of cases) {
    fs.writeFileSync(badPath, body);
    const roster = await f.call('hud_roster');
    assert.equal(
      roster.roles.some((entry) => entry.role === 'imp'),
      true,
      reason
    );
    assert.equal(
      roster.roles.some((entry) => entry.role === 'synthetic-writer'),
      true,
      reason
    );
    assert.deepEqual(roster.invalid, [{ path: badPath, reason }], reason);
    assert.equal(JSON.stringify(roster.invalid).includes(secret), false, reason);
    assert.deepEqual(
      withoutHint(await f.call('hud_create', { role: roleName ?? 'bad', request_key: `bad-${reason}`, task: 'Synthetic task.' })),
      roleName ? { ok: false, code: 'role_unavailable', path: badPath, reason } :
        { ok: false, code: 'role_unavailable', reason: 'Role bad is not configured or is hidden in this project' },
      reason
    );
  }
  assert.deepEqual(
    await f.call('hud_create', { role: 'missing-entirely', request_key: 'none', task: 'Synthetic task.' }),
    {
      ok: false,
      code: 'role_unavailable',
      reason: 'Role missing-entirely is not configured or is hidden in this project',
    }
  );
  assert.deepEqual(await f.call('hud_read'), { jobs: [] });
  fs.writeFileSync(join(rolesDir, 'imp.json'), '{');
  const kept = await f.call('hud_roster', { detail: true });
  assert.equal(
    kept.roles.find((entry) => entry.role === 'imp').source_file,
    resolve('packages/hud-mcp/roles/imp.json')
  );
  assert.ok(
    kept.invalid.some((item) => item.path === join(rolesDir, 'imp.json') && item.reason === 'unparseable JSON')
  );
  fs.writeFileSync(badPath, secret);
  fs.chmodSync(badPath, 0);
  const blocked = await f.call('hud_roster');
  assert.ok(blocked.invalid.some((item) => item.path === badPath && item.reason === 'unreadable'));
  assert.equal(JSON.stringify(blocked).includes(secret), false);
  assert.equal(
    blocked.roles.some((entry) => entry.role === 'imp'),
    true
  );
  fs.chmodSync(badPath, 0o600);
});

test(
  'a grok role runs a brief through idle grace and the watcher reaps the closed tab',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const job = await f.call('hud_create', {
      role: 'imp',
      on: 'grok',
      request_key: 'grok-life',
      task: 'Synthetic grok task.',
    });
    const tab = f.commands().find(({ command, args }) => command === 'herdr' && args[0] === 'tab' && args[1] === 'create').args;
    assert.equal(tab[tab.indexOf('--env') + 1], `HUD_JOB_DIR=${job.task_dir}`);
    const start = f.commands().find((c) => c.args[0] === 'agent' && c.args[1] === 'start').args;
    const dash = start.indexOf('--');
    assert.deepEqual(start.slice(0, dash), [
      'agent',
      'start',
      `${job.job}-primary`,
      '--kind',
      'grok',
      '--pane',
      'w4E:p2',
    ]);
    assert.deepEqual(start.slice(dash + 1), [
      '-m',
      'grok-4.7',
      '--reasoning-effort',
      'high',
      '--permission-mode',
      'bypassPermissions',
    ]);
    assert.equal(
      start.some((arg) => /^--(home|session|config|profile|worktree)/.test(arg)),
      false
    );
    const prompt = f.commands().find((c) => c.args[1] === 'prompt' && c.args[3] !== '/quit').args[3];
    assert.match(prompt, /instructions\/implementer\.md/);
    assert.match(prompt, /brief\.md/);
    assert.match(prompt, /do exactly what the brief asks/);
    const session = Object.fromEntries(
      fs
        .readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('='))
    );
    assert.equal(session.TASK, job.job);
    assert.equal(session.TAB, 'w4E:t2');
    assert.ok(session.TAB_NAME);
    assert.equal(session.LEFT, 'w4E:p2');
    assert.equal(session.RIGHT, '');
    assert.equal(session.ORCH, 'w4E:p1');
    assert.equal(session.BASE, 'HEAD');
    assert.equal(session.PRIMARY, `${job.job}-primary`);
    await until(() => fs.existsSync(join(f.env.HOME, 'seen-grace.json')));
    const grace = JSON.parse(fs.readFileSync(join(f.env.HOME, 'seen-grace.json'), 'utf8'));
    assertCliStatus(grace, job.task_dir);
    assert.equal(grace.state, 'idle_grace');
    assert.equal(grace.output_written, true);
    assert.equal(grace.model, 'grok-4.7');
    assert.equal(grace.thinking, 'high');
    assert.equal(grace.agent_session_id, 'synthetic-grok-session');
    assert.equal(typeof grace.pid, 'number');
    assert.match(grace.pid_start_time, /^\d+$/);
    assert.equal(String(grace.supervisor_pid), fs.readFileSync(join(job.task_dir, 'supervisor.pid'), 'utf8').trim());
    assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
    assert.ok(f.socketRequests.some((req) => req.method === 'agent.get'));
    await until(() => {
      const file = join(job.task_dir, 'STATUS.json');
      return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).state === 'closed';
    });
    const closed = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json'), 'utf8'));
    assertCliStatus(closed, job.task_dir);
    assert.equal(closed.state, 'closed');
    assert.equal(closed.exit_reason, 'settled');
    assert.equal(closed.output_written, true);
    assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
    assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
    assert.match(cardText(workerFor(f, job.job)), /\bimp\b/);
    assert.match(cardText(workerFor(f, job.job)), /Synthetic grok report/);
    await until(() => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'))).reaped_at);
    assert.ok(f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir));
  }
);

test('cli launch accepts model and thinking overrides and refuses pi-only switches', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (const [key, value] of [
    ['pi_args', ['--tools', 'read']],
    ['lens', true],
  ])
    assert.deepEqual(
      withoutHint(await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'reject-' + key, task: 'Synthetic.', [key]: value })),
      { ok: false, code: 'invalid_arguments' }
    );
  assert.deepEqual(withoutCallerLookups(f.commands()), []);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'plain.json'),
    JSON.stringify({
      role: 'plain-grok',
      harness: 'cli',
      agent: 'grok',
      can_continue: false,
      args: ['--extra', 'literal space'],
    })
  );
  const job = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'grok-override',
    task: 'Synthetic override.',
    model: 'grok-4.7-build-fast',
    thinking: 'low',
  });
  const start = f.commands().find((c) => c.args[1] === 'start').args;
  assert.deepEqual(start.slice(start.indexOf('--') + 1), [
    '-m',
    'grok-4.7-build-fast',
    '--reasoning-effort',
    'low',
    '--permission-mode',
    'bypassPermissions',
  ]);
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8'));
  assert.equal(receipt.model, 'grok-4.7-build-fast');
  assert.equal(receipt.thinking, 'low');
  assert.equal(receipt.model_source, 'hud_create');
  await until(() => {
    const file = join(job.task_dir, 'STATUS.json');
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).state === 'closed';
  });
  const plain = await f.call('hud_create', { role: 'plain-grok', request_key: 'plain', task: 'Synthetic plain.' });
  const plainStart = f
    .commands()
    .filter((c) => c.args[1] === 'start')
    .at(-1).args;
  assert.deepEqual(plainStart.slice(plainStart.indexOf('--') + 1), [
    '--permission-mode',
    'bypassPermissions',
    '--extra',
    'literal space',
  ]);
  await until(() => {
    const file = join(plain.task_dir, 'STATUS.json');
    return fs.existsSync(file) && ['closed', 'failed'].includes(JSON.parse(fs.readFileSync(file, 'utf8')).state);
  });
});

test('local CLI trust refuses missing grants without creating a tab', async (t) => {
  const f = await fixture(t);
  const cwd = join(f.root, 'quota fixtures');
  fs.mkdirSync(cwd);
  fs.unlinkSync(join(f.env.HOME, '.gemini', 'antigravity-cli', 'settings.json'));
  for (const agent of ['grok', 'agy', 'claude']) {
    const args = { role: 'imp', on: agent, request_key: `not-trusted-${agent}`, task: 'Synthetic task.', cwd };
    const job = await f.call('hud_create', args);
    assert.equal(job.ok, false);
    assert.equal(job.code, 'untrusted_cwd');
    assert.equal(job.reason, `${agent} has not trusted ${cwd}; run hud trust ${cwd}`);
    assert.equal(job.agent, null);
    assert.equal(cliState(job.task_dir).state, 'failed');
    assert.deepEqual(await f.call('hud_create', args), withoutHint(job));
  }
  assert.equal(f.commands().some(({ args }) => args[0] === 'tab' && args[1] === 'create'), false);
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
});

test('hud watch catch-up does not replay reportless failures after hud_read or hud_close', async (t) => {
  const f = await fixture(t);
  const cwd = join(f.root, 'untrusted checkout');
  fs.mkdirSync(cwd);
  const jobs = [];
  for (const method of ['hud_read', 'hud_close', 'unhandled']) {
    const job = await f.call('hud_create', { role: 'imp', on: 'claude', request_key: method, task: 'Synthetic attempt.', cwd });
    assert.equal(job.code, 'untrusted_cwd');
    jobs.push(job);
    if (method === 'hud_read') {
      // A failed dispatch can also have only a job receipt, not a STATUS file.
      fs.unlinkSync(join(job.task_dir, 'STATUS.json'));
      assert.equal((await f.call(method, { job: job.job })).state, 'failed');
    } else if (method === 'hud_close') {
      assert.equal((await f.call(method, { job: job.job })).exit_code, 0);
    }
  }
  for (let i = 0; i < 2; i++) {
    const lines = [], ac = new AbortController();
    t.after(() => ac.abort());
    const watch = watchCommand([], { env: f.env, stdout: (line) => lines.push(line.trim()), stderr: () => {} }, { signal: ac.signal });
    await until(() => lines.length);
    ac.abort();
    await watch;
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(jobs[2].job));
  }
});

test('a grok trust dialog is declined and the job fails naming the directory', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), '');
  const args = { role: 'imp', on: 'grok', request_key: 'grok-trust', task: 'Synthetic trust.' };
  const job = await f.call('hud_create', args);
  const status = JSON.parse(fs.readFileSync(join(job.task_dir, 'STATUS.json'), 'utf8'));
  const cwd = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).cwd;
  assert.equal(job.ok, false);
  assert.equal(job.code, 'dispatch_failed');
  assert.equal(job.reason, `grok has not trusted ${cwd}; run hud trust ${cwd}`);
  assert.deepEqual(await f.call('hud_create', args), withoutHint(job));
  assertCliStatus(status, job.task_dir);
  assert.equal(status.state, 'failed');
  assert.equal(status.error, `grok has not trusted ${cwd}; run hud trust ${cwd}`);
  assert.equal(status.exit_reason, status.error);
  const commands = f.commands();
  const decline = commands.find((c) => c.args[1] === 'send-keys');
  assert.deepEqual(decline.args.slice(3), ['n']);
  assert.ok(commands.some((c) => c.args[1] === 'wait' && c.args.includes('idle')));
  assert.equal(
    commands.some((c) => c.args[1] === 'prompt'),
    false
  );
  assert.equal(fs.existsSync(join(job.task_dir, 'supervisor.pid')), false);
  assert.ok(commands.some((c) => c.args[0] === 'tab' && c.args[1] === 'close' && c.args[2] === 'w4E:t2'));
});

function writeCliRole(f, role, idle_grace_s = 1, can_continue = true, agent = 'grok') {
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', `${role}.json`),
    JSON.stringify({ role, harness: 'cli', agent, ...(agent === 'grok' ? { model: 'grok-4.7' } : {}), thinking: 'high', can_continue, idle_grace_s: idle_grace_s * 20 })
  );
}

test('done without report keeps the job open and a later report settles it', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'short-cli', 4, true);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const job = await f.call('hud_create', { role: 'short-cli', request_key: 'grok-missing', task: 'Synthetic missing.' });
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.pid);
  assertCliStatus(cliState(job.task_dir), job.task_dir);
  assert.equal(cliState(job.task_dir).output_written, false);
  assert.equal(cliState(job.task_dir).reason, null);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
  assert.equal(f.commands().filter((c) => c.args[1] === 'prompt').length, 1);
  // done -> working -> done + report
  fs.unlinkSync(join(f.env.HOME, 'missing-report'));
  fs.writeFileSync(join(f.env.HOME, 'wake-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
  const closed = cliState(job.task_dir);
  assert.equal(closed.exit_reason, 'settled');
  assert.equal(closed.output_written, true);
  assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
  // A report written directly while done (without a self-wake) also settles the turn.
  fs.unlinkSync(join(f.env.HOME, 'wake-turn'));
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const job2 = await f.call('hud_create', { role: 'short-cli', request_key: 'grok-late-report', task: 'Synthetic late report.' });
  await until(() => cliState(job2.task_dir)?.state === 'working' && cliState(job2.task_dir)?.pid);
  fs.writeFileSync(join(job2.task_dir, 'report.md'), 'Synthetic direct report.\n');
  await until(() => cliState(job2.task_dir)?.state === 'closed', 8000);
  assert.equal(cliState(job2.task_dir).output_written, true);
});

function cliState(dir) {
  const file = join(dir, 'STATUS.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function graceArmed(env, dir) {
  const seen = join(env.HOME, 'seen-grace.json');
  return (
    cliState(dir)?.state === 'idle_grace' &&
    fs.existsSync(seen) &&
    fs.readFileSync(seen, 'utf8').includes(dir.split('/').at(-1))
  );
}

test("a cli continuation in grace is judged against the report at that turn's start", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  const job = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'grok-cont',
    task: 'Synthetic continuation.',
  });
  await until(() => graceArmed(f.env, job.task_dir), 5000);
  const sent = await f.call('hud_send', { job: job.job, message_key: 'more', text: 'Synthetic continuation.' });
  assert.equal(sent.sent, true);
  assert.equal(sent.queued, undefined);
  await until(() => fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8').includes('two'), 5000);
  await until(
    () => cliState(job.task_dir)?.state === 'idle_grace' && cliState(job.task_dir)?.output_written === true,
    5000
  );
});

for (const mode of ['rejected-prompt', 'fast-ambiguous-prompt']) {
  test(`hud_send: preserves the right turn on ${mode}`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
    writeCliRole(f, 'cli-send-outcome', 8);
    const job = await f.call('hud_create', { role: 'cli-send-outcome', request_key: mode, task: 'Synthetic task.' });
    const dir = job.task_dir, turn = () => JSON.parse(fs.readFileSync(join(dir, 'turn.json'), 'utf8'));
    const receipt = () => JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
    await until(() => cliState(dir)?.agent_session_id);
    fs.writeFileSync(join(dir, 'report.md'), 'Synthetic first report.\n');
    f.push(job.job, 'idle');
    await until(() => cliState(dir)?.state === 'idle_grace');
    const prior = turn(), grace = cliState(dir);
    const args = { job: job.job, message_key: 'cont', text: 'Synthetic continuation.' };
    fs.writeFileSync(join(f.env.HOME, mode), '');
    const prompts = () => f.commands().filter((c) => c.args[1] === 'prompt' && c.args[3]?.split('\n')[0] === args.text);
    const sent = f.call('hud_send', args);
    await until(() => prompts().length > 0);
    const provisional = turn();
    assert.equal(provisional.seq, prior.seq + 1);
    assert.equal(receipt().send_outcomes.at(-1).exit_code, null);
    const pendingQueries = statusQueries(f, job);
    await until(() => statusQueries(f, job) > pendingQueries); // Sample while Herdr has not replied yet.
    assert.equal(cliState(dir).settled_at, grace.settled_at);
    fs.writeFileSync(join(f.env.HOME, 'release-prompt-result'), '');
    assert.equal((await sent).code, 'send_failed');
    assert.equal((await f.call('hud_send', args)).code, 'send_failed');
    assert.equal(prompts().length, 1);
    assert.equal(receipt().send_outcomes.at(-1).exit_code, 1);
    if (mode === 'rejected-prompt') {
      assert.deepEqual(turn(), prior);
      const queries = statusQueries(f, job);
      await until(() => statusQueries(f, job) > queries);
      const listing = (await f.call('hud_read')).jobs.find((row) => row.job === job.job);
      assert.equal(listing.report_unread, true);
      assert.equal(listing.state, 'idle_grace');
      assert.equal(cliState(dir).settled_at, grace.settled_at);
      assert.equal(cliState(dir).idle_deadline_at, grace.idle_deadline_at);
    } else {
      assert.deepEqual(turn(), provisional);
      await until(() => cliState(dir)?.state === 'idle_grace' && cliState(dir).settled_at !== grace.settled_at);
      assert.equal(cliState(dir).output_written, true);
      assert.match((await f.call('hud_read', { job: job.job })).report, /fast report after input/);
    }
  });
}

test('an unchanged cli report after continuation stays open without failing', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'short-cont', 1, true);
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  fs.writeFileSync(join(f.env.HOME, 'unchanged-report'), '');
  const job = await f.call('hud_create', { role: 'short-cont', request_key: 'grok-same', task: 'Synthetic same.' });
  await until(() => graceArmed(f.env, job.task_dir), 5000);
  await f.call('hud_send', { job: job.job, message_key: 'same', text: 'Synthetic continuation.' });
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.output_written === false, 5000);
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 5000);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'Synthetic grok report two.\n');
  await until(() => cliState(job.task_dir)?.state === 'idle_grace' && cliState(job.task_dir)?.output_written === true, 5000);
});

test('quiet without a report and an in-turn child makes no Decision API call and types no prompt', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  writeCliRole(f, 'bg-cli', 0.25, false);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  fs.writeFileSync(join(f.env.HOME, 'write-on-report-prompt'), '');
  const server = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.95));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'bg-cli', request_key: 'bg-child', task: 'Synthetic bg child.' });
  await until(() => cliState(job.task_dir)?.agent_session_id);
  await worker.start();
  const prompts = () => f.commands().filter((c) => c.args[1] === 'prompt' && String(c.args[3]).startsWith('Write your report to '));
  f.push(job.job, 'idle');
  const before = statusQueries(f, job);
  await until(() => statusQueries(f, job) > before);
  assert.equal(server.requests.length, 0);
  assert.equal(prompts().length, 0);
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).quiet_decision, undefined);

  worker.stop();
  await until(() => prompts().length === 1, 5000);
  assert.equal(server.requests.length, 1, 'the real quiet-decision path runs once the child is gone');
});

test('quiet past grace turns waiting_orchestrator without pane notices and self-wake returns to working', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'quiet-cli', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const notices = () =>
    f.commands().filter((c) => c.args[1] === 'prompt' && String(c.args.at(-1)).includes('quiet without a report'));
  const job = await f.call('hud_create', { role: 'quiet-cli', request_key: 'quiet-grace', task: 'Synthetic quiet grace.' });
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 5000);
  assert.equal(notices().length, 0);
  const asking = workerFor(f, job.job);
  assert.equal(asking.homeNeedsHuman, true);
  assert.equal(asking.phase, 'asking');
  assert.match(cardText(asking), /quiet without a report/);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
  assert.equal(f.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);
  await new Promise((done) => setTimeout(done, 350));
  assert.equal(notices().length, 0);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  fs.writeFileSync(join(f.env.HOME, 'wake-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.reason === null, 5000);
  assert.equal(workerFor(f, job.job).homeNeedsHuman, false);
  fs.unlinkSync(join(f.env.HOME, 'missing-report'));
  fs.writeFileSync(join(f.env.HOME, 'release-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'closed', 5000);
  assert.equal(notices().length, 0);
});

test('hud_send queues into a working cli job', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-queue', task: 'Synthetic queue.' });
  await until(() => cliState(job.task_dir)?.state === 'working');
  const sent = await f.call('hud_send', { job: job.job, message_key: 'q', text: 'Synthetic addendum.' });
  assert.equal(sent.queued, true);
  assert.equal(sent.sent, true);
  assert.equal(
    f
      .commands()
      .filter((c) => c.args[1] === 'prompt')
      .at(-1)
      .args[3].split('\n')[0],
    'Synthetic addendum.'
  );
});

test('hud_close stops a working cli job and closes an idle-grace one', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const working = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-stop', task: 'Synthetic stop.' });
  await until(() => cliState(working.task_dir)?.state === 'working');
  assert.equal(typeof cliState(working.task_dir).pid, 'number');
  assert.match(cliState(working.task_dir).pid_start_time, /^\d+$/);
  const { exit_code, last_line } = await f.call('hud_close', { job: working.job });
  assert.equal(exit_code, 0);
  assert.equal(last_line, 'Synthetic reap complete');
  await until(() => cliState(working.task_dir)?.state === 'stopped');
  assert.equal(cliState(working.task_dir).exit_reason, 'stop requested');
  assert.equal(fs.existsSync(join(working.task_dir, 'STATUS.json.stop-requested')), true);
  fs.unlinkSync(join(f.env.HOME, 'hold-turn'));
  fs.writeFileSync(join(f.env.HOME, 'hold-grace'), '');
  const grace = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-close', task: 'Synthetic close.' });
  await until(() => cliState(grace.task_dir)?.state === 'idle_grace');
  await f.call('hud_close', { job: grace.job });
  await until(() => cliState(grace.task_dir)?.state === 'closed');
  assert.equal(cliState(grace.task_dir).exit_reason, 'settled');
  assert.equal(fs.existsSync(join(grace.task_dir, 'STATUS.json.close-requested')), true);
});

test('a cli that exits fails, and a closed tab fails', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-exit'), '');
  const exited = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-exit', task: 'Synthetic exit.' });
  await until(() => cliState(exited.task_dir)?.state === 'failed');
  assert.equal(cliState(exited.task_dir).error, 'worker exited');
  fs.unlinkSync(join(f.env.HOME, 'cli-exit'));
  fs.writeFileSync(join(f.env.HOME, 'cli-gone'), '');
  const missing = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-gone', task: 'Synthetic gone.' });
  await until(() => cliState(missing.task_dir)?.state === 'failed');
  assert.equal(cliState(missing.task_dir).error, 'worker exited');
});

test('closing a cli job tab fails it', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-tab', task: 'Synthetic tab.' });
  await until(() => cliState(job.task_dir)?.pid);
  f.closeTab();
  await until(() => cliState(job.task_dir)?.exit_reason === 'tab closed');
  assert.equal(cliState(job.task_dir).state, 'failed');
});

for (const first of ['watcher', 'supervisor']) {
  for (const fact of ['stop', 'exit with report']) {
    test(`CLI tab-close: ${first} writes first for ${fact}`, { timeout: 10000 }, async (t) => {
      const f = await fixture(t);
      const worker = fakeCliWithChild(t, f);
      fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
      writeCliRole(f, 'tab-fact', 8);
      const job = await f.call('hud_create', { role: 'tab-fact', request_key: fact, task: 'Synthetic tab race.' });
      const dir = job.task_dir;
      await until(() => cliState(dir)?.pid === worker.pid && f.socketRequests.some((r) => r.id === 'hud-watch'));
      const supervisor = cliState(dir).supervisor_pid;
      const watcher = Number(fs.readFileSync(join(f.env.HUD_HOME, 'watch.pid'), 'utf8'));
      const second = first === 'watcher' ? supervisor : watcher;
      process.kill(second, 'SIGSTOP');
      let terminal;
      try {
        fs.writeFileSync(join(dir, 'report.md'), 'Synthetic report before loss of tab.\n');
        if (fact === 'stop') fs.writeFileSync(join(dir, 'STATUS.json.stop-requested'), '');
        else { await worker.exit(); assert.equal(procStat(worker.pid), null); }
        f.closeTab();
        await until(() => cliState(dir)?.ended_at);
        terminal = cliState(dir);
        assert.equal(terminal.state, fact === 'stop' ? 'stopped' : 'closed');
        assert.equal(terminal.exit_reason, fact === 'stop' ? 'stop requested' : 'settled');
        assert.equal(terminal.output_written, true);
      } finally {
        process.kill(second, 'SIGCONT');
      }
      await until(() => readCloseReaped(job));
      await until(() => !procStat(supervisor) || procStat(supervisor)?.state === 'Z');
      assert.deepEqual(cliState(dir), terminal);
    });
  }
}

test('supervisor preserves the watcher tab-close fact when its own push socket was lost', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'lost-close', 10);
  const job = await f.call('hud_create', { role: 'lost-close', request_key: 'lost-close', task: 'Synthetic tab-close outage.' });
  await until(() => cliState(job.task_dir)?.pid);
  f.dropWorker(job.job);
  f.closeTab();
  await until(() => cliState(job.task_dir)?.exit_reason === 'tab closed');
  fs.writeFileSync(join(job.task_dir, 'report.md'), 'A late report must not overwrite tab closure.\n');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(cliState(job.task_dir).state, 'failed');
  assert.equal(cliState(job.task_dir).exit_reason, 'tab closed');
});

function runAsk(env, args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-ask.mjs'), ...args], {
      env: { ...process.env, PATH: env.PATH, FAKE_LOG: env.FAKE_LOG, HOME: env.HOME, HUD_HOME: env.HUD_HOME },
    });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => done({ code, stdout, stderr }));
  });
}

test('implementer instructions tell workers to ask through hud_ask', () => {
  const text = fs.readFileSync(resolve('packages/hud-mcp/instructions/implementer.md'), 'utf8');
  assert.match(text, /hud_ask/);
  assert.doesNotMatch(text, /hud-ask|ask_orchestrator/);
  assert.match(text, /never a terminal prompt/i);
  assert.match(text, /Keep working/);
  assert.doesNotMatch(text, /write the question in your report and stop/);
});

test(
  'hud_ask round trip notifies the orchestrator and returns the hud_respond answer',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const id = 'j00000000000000a1',
      dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, 'job.json'),
      JSON.stringify({
        job: id,
        role: 'grok-imp',
        cwd: '/synthetic/MyHUD',
        herdr_pane: 'w4E:p1',
        created_at: new Date().toISOString(),
      })
    );
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working', harness: 'cli', agent: 'grok' }));
    fs.writeFileSync(join(dir, 'brief.md'), '# Synthetic ask\n');
    fs.writeFileSync(join(dir, 'SESSION.txt'), 'LEFT=w4E:p2\nORCH=w4E:p1\n');
    const call = workerClient(t, f, dir);
    const pending = call('hud_ask', { question: 'Which layout?', options: ['rows', 'columns'], default: 'rows', context: 'card width' });
    await until(() => fs.existsSync(join(dir, 'qa', 'q1.md')));
    const body = fs.readFileSync(join(dir, 'qa', 'q1.md'), 'utf8');
    assert.match(body, /^# Question q1 from grok-imp@MyHUD\n/);
    assert.match(body, /Which layout\?/);
    assert.match(body, /Options:\n- rows\n- columns/);
    assert.match(body, /Default if unanswered: rows/);
    assert.match(body, /Context: card width/);
    assert.match(body, /Answer: write the answer to .*q1\.answer\.md/);
    await until(() => f.commands().some((c) => String(c.args.at(-1)).includes('QUESTION q1')));
    const notice = f.commands().find((c) => String(c.args.at(-1)).includes('QUESTION q1'));
    assert.equal(notice.args[2], 'w4E:p1');
    assert.match(
      notice.args.at(-1),
      /^\[grok-imp@MyHUD\] QUESTION q1: Which layout\? \| options: rows \/ columns \| default: rows \| full text: /
    );
    const read = await f.call('hud_read', { job: id });
    assert.equal(read.questions[0].id, 'q1');
    assert.match(read.questions[0].text, /Which layout\?/);
    const asking = workerFor(f, id);
    assert.equal(asking.homeNeedsHuman, true);
    assert.equal(asking.ask, 'Which layout?');
    await f.call('hud_respond', { job: id, request_id: 'q1', answer: 'columns' });
    const result = await pending;
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /ANSWER from the orchestrator \(q1, after \d+s\):\n\ncolumns/);
    assert.equal((await f.call('hud_read', { job: id })).questions, undefined);
  }
);

test('hud-ask prints the default when no answer arrives', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const id = 'j00000000000000a2',
    dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    join(dir, 'job.json'),
    JSON.stringify({
      job: id,
      role: 'grok-imp',
      cwd: '/synthetic/MyHUD',
      herdr_pane: 'w4E:p1',
      created_at: new Date().toISOString(),
    })
  );
  fs.writeFileSync(join(dir, 'SESSION.txt'), 'ORCH=w4E:p1\n');
  const result = await runAsk(f.env, [
    '--dir',
    dir,
    '--question',
    'Which layout?',
    '--default',
    'rows',
    '--timeout',
    '1',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /No answer to q1 within 1s \(pushed via "herdr agent prompt w4E:p1"\)\. Proposed default: rows\. Proceed on the default only if it is reversible and inside the brief; otherwise leave that part and name it as blocked in your report/
  );
  assert.equal(fs.existsSync(join(dir, 'qa', 'q1.md')), true);
});

test('a blocked CLI turn needs the owner once, then returns to working', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-blocked'), '');
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grok-blocked', task: 'Synthetic blocked.' });
  assert.match(
    fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'),
    /node ".*\/hud-ask\.mjs" --dir ".*" --question/
  );
  const notices = () =>
    f.commands().filter((c) => c.args[1] === 'prompt' && String(c.args.at(-1)).includes('BLOCKED:'));
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator');
  const blocked = cliState(job.task_dir);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.harness, 'cli');
  assert.equal(notices().length, 0);
  const worker = workerFor(f, job.job);
  assert.equal(worker.homeNeedsHuman, true);
  assert.equal(worker.phase, 'asking');
  assert.equal(worker.ask, 'grok needs input in its pane');
  assert.match(cardText(worker), /grok needs input in its pane/);
  assert.match(cardText(worker), /asking/);
  fs.writeFileSync(join(f.env.HOME, 'release-blocked'), '');
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.blocked === false, 5000);
  assert.equal(notices().length, 0);
  const resumed = workerFor(f, job.job);
  assert.equal(resumed.homeNeedsHuman, false);
  assert.equal(resumed.ask, undefined);
  fs.writeFileSync(join(f.env.HOME, 'release-turn'), '');
  await until(() => cliState(job.task_dir)?.state === 'closed', 5000);
});

test(
  'an agy role launches without an effort flag, and a startup done does not settle the job',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'startup-done'), '');
    const job = await f.call('hud_create', { role: 'imp', on: 'agy', request_key: 'agy-life', task: 'Synthetic agy task.' });
    const start = f.commands().find((c) => c.args[1] === 'start').args;
    assert.deepEqual(start.slice(start.indexOf('--') + 1), [
      '--model',
      'gemini-4-argon-high',
      '--dangerously-skip-permissions',
    ]);
    assert.equal(start.includes('--effort'), false);
    await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
    const commands = f.commands();
    const promptAt = commands.findIndex((c) => c.args[1] === 'prompt' && c.args[3] !== '/quit');
    assert.ok(promptAt >= 0);
    assert.equal(commands.some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
    const closed = cliState(job.task_dir);
    assert.equal(closed.agent, 'agy');
    assert.equal(closed.model, 'gemini-4-argon-high');
    assert.equal(closed.thinking, null);
    assert.equal(closed.state, 'closed');
    assert.equal(closed.exit_reason, 'settled');
    assert.equal(closed.error, null);
    assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
    assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
  }
);

test(
  'agent_not_ready runs the trust check for any kind, and a start error without that text is unchanged',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'start-not-ready'), '');
    fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), 'Do you trust the contents of this project?');
    const agy = await f.call('hud_create', { role: 'imp', on: 'agy', request_key: 'agy-trust', task: 'Synthetic trust.' });
    const agyStatus = cliState(agy.task_dir);
    const cwd = JSON.parse(fs.readFileSync(join(agy.task_dir, 'job.json'), 'utf8')).cwd;
    assert.equal(agyStatus.state, 'failed');
    assert.equal(agyStatus.error, `agy has not trusted ${cwd}; run hud trust ${cwd}`);
    assert.deepEqual(
      f
        .commands()
        .find((c) => c.args[1] === 'send-keys')
        .args.slice(3),
      ['down', 'enter']
    );
    assert.equal(
      f.commands().some((c) => c.args[1] === 'prompt'),
      false
    );
    assert.equal(fs.existsSync(join(agy.task_dir, 'supervisor.pid')), false);
    fs.unlinkSync(join(f.env.HOME, 'trust-dialog'));
    const bare = await f.call('hud_create', {
      role: 'imp',
      on: 'agy',
      request_key: 'agy-not-ready',
      task: 'Synthetic not ready.',
    });
    assert.equal(f.commands().filter((c) => c.args[1] === 'send-keys').length, 1);
    assert.match(cliState(bare.task_dir).exit_reason, /agent_not_ready/);
    assert.equal(fs.existsSync(join(bare.task_dir, 'supervisor.pid')), false);
    fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), '');
    const grok = await f.call('hud_create', {
      role: 'imp',
      on: 'grok',
      request_key: 'grok-not-ready',
      task: 'Synthetic grok trust.',
    });
    assert.deepEqual(
      f
        .commands()
        .filter((c) => c.args[1] === 'send-keys')
        .at(-1)
        .args.slice(3),
      ['n']
    );
    assert.match(cliState(grok.task_dir).error, /^grok has not trusted /);
  }
);

test('a claude role launches with its flags and settles through idle grace', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const job = await f.call('hud_create', {
    role: 'imp',
    on: 'claude',
    request_key: 'claude-life',
    task: 'Synthetic claude task.',
  });
  const start = f.commands().find((c) => c.args[1] === 'start').args;
  const dash = start.indexOf('--');
  assert.deepEqual(start.slice(0, dash), [
    'agent',
    'start',
    `${job.job}-primary`,
    '--kind',
    'claude',
    '--pane',
    'w4E:p2',
  ]);
  assert.deepEqual(start.slice(dash + 1), ['--model', 'opus', '--effort', 'high', '--dangerously-skip-permissions']);
  assert.equal(start.includes('--timeout'), false);
  await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
  const closed = cliState(job.task_dir);
  assert.equal(closed.agent, 'claude');
  assert.equal(closed.model, 'opus');
  assert.equal(closed.thinking, 'high');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.exit_reason, 'settled');
  assert.equal(closed.error, null);
  assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
  assert.equal(
    f.commands().some((c) => c.args[1] === 'send-keys'),
    false
  );
});

test(
  'a claude trust dialog is declined with enter and the launch fails with the reason',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'start-not-ready'), '');
    fs.writeFileSync(join(f.env.HOME, 'trust-dialog'), 'Is this a project you created or one you trust?');
    const job = await f.call('hud_create', {
      role: 'imp',
      on: 'claude',
      request_key: 'claude-trust',
      task: 'Synthetic trust.',
    });
    const status = cliState(job.task_dir);
    const cwd = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).cwd;
    assert.equal(status.state, 'failed');
    assert.equal(status.error, `claude has not trusted ${cwd}; run hud trust ${cwd}`);
    assert.deepEqual(
      f
        .commands()
        .find((c) => c.args[1] === 'send-keys')
        .args.slice(3),
      ['enter']
    );
    assert.equal(
      f.commands().some((c) => c.args[1] === 'prompt'),
      false
    );
    assert.equal(fs.existsSync(join(job.task_dir, 'supervisor.pid')), false);
  }
);

test('idle and unknown with a live agent settle only a stable new report', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  for (const status of ['idle', 'unknown']) {
    fs.writeFileSync(join(f.env.HOME, 'quiet-hold'), status);
    const job = await f.call('hud_create', {
      role: 'imp',
      on: 'grok',
      request_key: 'quiet-' + status,
      task: 'Synthetic quiet.',
    });
    await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
    assert.equal(cliState(job.task_dir).error, null);
    assert.equal(cliState(job.task_dir).exit_reason, 'settled');
    assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
  }
});

test('unknown while the agent is gone settles the job', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-unknown'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'unknown-gone', task: 'Synthetic unknown.' });
  await until(() => cliState(job.task_dir)?.state === 'failed');
  assert.equal(cliState(job.task_dir).error, 'worker exited');
});

test(
  'grace keeps its deadline when idle is not an exit, and unknown with the agent gone leaves',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'grace-quiet'), 'idle');
    const held = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'grace-idle', task: 'Synthetic grace.' });
    await until(() => cliState(held.task_dir)?.state === 'closed', 8000);
    assert.equal(f.commands().some((c) => c.args[1] === 'wait' && c.args.includes('blocked')), false);
    assert.equal(cliState(held.task_dir).exit_reason, 'settled');
    assert.equal(cliState(held.task_dir).error, null);
    const seen = JSON.parse(fs.readFileSync(join(f.env.HOME, 'seen-grace.json'), 'utf8'));
    assert.equal(cliState(held.task_dir).idle_deadline_at, seen.idle_deadline_at);
    // A pushed unknown cannot override the /proc exit fact.
    fs.writeFileSync(join(f.env.HOME, 'grace-quiet'), 'unknown');
    fs.writeFileSync(join(f.env.HOME, 'grace-quiet-gone'), '');
    const gone = await f.call('hud_create', {
      role: 'imp',
      on: 'grok',
      request_key: 'grace-gone',
      task: 'Synthetic grace gone.',
    });
    await until(() => cliState(gone.task_dir)?.state === 'closed', 8000);
    assert.equal(cliState(gone.task_dir).exit_reason, 'settled');
    assert.equal(cliState(gone.task_dir).output_written, true);
  }
);

test('a blocked resume treats idle as present and unknown as gone', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'cli-blocked'), '');
  fs.writeFileSync(join(f.env.HOME, 'blocked-quiet'), 'idle');
  const held = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'blocked-idle',
    task: 'Synthetic blocked quiet.',
  });
  await until(() => cliState(held.task_dir)?.state === 'waiting_orchestrator');
  fs.writeFileSync(join(f.env.HOME, 'release-blocked'), '');
  await until(() => cliState(held.task_dir)?.state === 'closed', 8000);
  assert.equal(cliState(held.task_dir).exit_reason, 'settled');
  assert.equal(cliState(held.task_dir).error, null);
  fs.unlinkSync(join(f.env.HOME, 'release-blocked'));
  // A missing worker on blocked resume still fails by its PID.
  fs.writeFileSync(join(f.env.HOME, 'blocked-quiet'), 'unknown');
  fs.writeFileSync(join(f.env.HOME, 'blocked-quiet-gone'), '');
  const gone = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'blocked-gone',
    task: 'Synthetic blocked gone.',
  });
  await until(() => cliState(gone.task_dir)?.state === 'failed', 8000);
  assert.equal(cliState(gone.task_dir).error, 'worker exited');
});

test('a codex role waits out a phantom startup and passes the start timeout', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'phantom-working'), '');
  const job = await f.call('hud_create', {
    role: 'imp',
    on: 'codex',
    request_key: 'codex-life',
    task: 'Synthetic codex task.',
  });
  const start = f.commands().find((c) => c.args[1] === 'start').args;
  const dash = start.indexOf('--');
  assert.deepEqual(start.slice(0, dash), [
    'agent',
    'start',
    `${job.job}-primary`,
    '--kind',
    'codex',
    '--pane',
    'w4E:p2',
    '--timeout',
    '90000',
  ]);
  assert.deepEqual(start.slice(dash + 1), [
    '-m',
    'gpt-6.1-sol',
    '-c',
    'model_reasoning_effort=high',
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.equal(
    start.some((arg) => /^--(home|session|config|profile|worktree)/.test(arg) || arg.includes('CODEX_HOME')),
    false
  );
  const commands = f.commands();
  const settleAt = commands.findIndex(
    (c) => c.args[1] === 'wait' && c.args.includes('done') && c.args.includes('idle') && !c.args.includes('blocked')
  );
  const promptAt = commands.findIndex((c) => c.args[1] === 'prompt' && c.args[3] !== '/quit');
  assert.ok(settleAt >= 0 && promptAt > settleAt);
  assert.equal(commands[settleAt].args[commands[settleAt].args.indexOf('--timeout') + 1], '60000');
  assert.equal(fs.existsSync(join(f.env.HOME, 'phantom-settled')), true);
  await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
  const closed = cliState(job.task_dir);
  assert.equal(closed.agent, 'codex');
  assert.equal(closed.model, 'gpt-6.1-sol');
  assert.equal(closed.thinking, 'high');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.exit_reason, 'settled');
  assert.equal(closed.error, null);
  assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic grok report.\n');
  assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
  assert.equal(
    f.commands().some((c) => c.args[1] === 'send-keys'),
    false
  );
});

test(
  'a cli job records agent_session_id when herdr publishes it after the first get',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(join(f.env.HOME, 'late-session'), '0');
    const job = await f.call('hud_create', {
      role: 'imp',
      on: 'grok',
      request_key: 'late-session',
      task: 'Synthetic late session.',
    });
    await until(() => fs.existsSync(join(f.env.HOME, 'seen-grace.json'))).catch((error) => {
      t.diagnostic(JSON.stringify({ status: cliState(job.task_dir), requests: f.socketRequests }));
      throw error;
    });
    const grace = JSON.parse(fs.readFileSync(join(f.env.HOME, 'seen-grace.json'), 'utf8'));
    assert.equal(grace.state, 'idle_grace');
    assert.equal(grace.agent_session_id, 'synthetic-grok-session');
    await until(() => cliState(job.task_dir)?.state === 'closed');
    assert.equal(cliState(job.task_dir).agent_session_id, 'synthetic-grok-session');
  }
);

test('a failed cli job records agent_session_id published after start, before exit', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'late-session'), '0');
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'exit-after-done'), '');
  const job = await f.call('hud_create', { role: 'imp', on: 'grok', request_key: 'late-fail', task: 'Synthetic late fail.' });
  await until(() => cliState(job.task_dir)?.state === 'failed');
  assert.equal(cliState(job.task_dir).error, 'worker exited');
  assert.equal(cliState(job.task_dir).agent_session_id, 'synthetic-grok-session');
});

test('hud_roster cwd and hud_create use a registered project role', async (t) => {
  const f = await fixture(t);
  const proj = join(f.root, 'proj');
  fs.mkdirSync(join(proj, 'sub'), { recursive: true });
  assert.equal(spawnSync('git', ['init'], { cwd: proj, encoding: 'utf8' }).status, 0);
  const root = fs.realpathSync(proj);
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ root, registered_at: '2026-11-13T00:00:00.000Z' }] })
  );
  const role = {
    role: 'frontend',
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    model: 'project/model',
    thinking: 'low',
    skills: ['to-tickets'],
  };
  fs.mkdirSync(join(proj, '.hud/roles'), { recursive: true });
  fs.writeFileSync(join(proj, '.hud/roles/frontend.json'), JSON.stringify(role));
  fs.writeFileSync(join(proj, '.hud/roles/imp.json'), JSON.stringify({ ...role, role: 'imp', model: 'project/imp' }));
  const cli = { harness: 'cli', agent: 'grok', model: 'synthetic-cli', thinking: 'high' };
  const fallback = { harness: 'pi', pi_role: 'implementer', split: false };
  fs.writeFileSync(
    join(proj, '.hud/roles/cli.json'),
    JSON.stringify({ role: 'local-cli', instructions: 'implementer', can_continue: true, run: [cli, fallback] })
  );
  fs.writeFileSync(join(proj, '.hud/project.json'), JSON.stringify({ version: 1, roles: ['frontend', 'local-cli', 'nope'] }));
  fs.writeFileSync(join(proj, '.hud/hud-convention.md'), 'Project convention only.');
  fs.writeFileSync(join(proj, 'hud-convention.md'), 'Cwd convention must lose.');
  const roster = await f.call('hud_roster', { cwd: join(proj, 'sub'), detail: true });
  assert.deepEqual(roster.project, { root, registered: true });
  assert.equal(roster.project_config_ignored, undefined);
  assert.equal(roster.roles.find((entry) => entry.role === 'frontend').model, 'project/model');
  assert.equal(
    roster.roles.find((entry) => entry.role === 'frontend').source_file,
    join(root, '.hud/roles/frontend.json')
  );
  assert.deepEqual(roster.roles.find((entry) => entry.role === 'frontend').skills, ['to-tickets']);
  assert.equal(
    roster.roles.some((entry) => entry.role === 'imp'),
    false
  );
  assert.deepEqual(roster.invalid, []);
  const projectCli = roster.roles.find((entry) => entry.role === 'local-cli');
  assert.equal(projectCli.source_file, join(root, '.hud/roles/cli.json'));
  assert.deepEqual(projectCli.run, [cli, fallback]);
  const compact = await f.call('hud_roster', { cwd: proj });
  assert.deepEqual(compact.roles.find((entry) => entry.role === 'local-cli'), {
    role: 'local-cli', instructions: 'implementer', available: true, can_continue: true, runs_on: cli,
    places: [{ index: 0, state: 'active' }, { index: 1, state: 'standby', provider: 'synthetic', provider_source: 'pi_role' }],
  });
  const untrusted = await f.call('hud_create', {
    role: 'local-cli', on: 'grok', request_key: 'project-cli-untrusted', task: 'Synthetic CLI task.', cwd: proj,
  });
  assert.equal(untrusted.code, 'untrusted_cwd');
  assert.equal(roster.convention.path, join(root, '.hud/hud-convention.md'));
  assert.equal(roster.convention.text, 'Project convention only.');
  const server = await f.call('hud_roster');
  assert.equal(server.project.registered, false);
  assert.equal(server.project.root, fs.realpathSync(f.root));
  assert.equal(
    server.roles.some((entry) => entry.role === 'frontend'),
    false
  );
  assert.equal(
    server.roles.some((entry) => entry.role === 'imp'),
    true
  );
  const created = await f.call('hud_create', {
    role: 'frontend',
    request_key: 'project-role',
    task: 'Synthetic project task.',
    cwd: proj,
  });
  const receipt = JSON.parse(fs.readFileSync(join(created.task_dir, 'job.json'), 'utf8'));
  assert.equal(receipt.model, 'project/model');
  assert.equal(receipt.cwd, resolve(proj));
  const launch = f.commands().find((entry) => entry.command === 'pi-role').args;
  assert.equal(launch[launch.indexOf('--args-json') + 1], 'implementer');
  assert.equal(launch.includes('--skill'), false);
  assert.deepEqual(
    await f.call('hud_create', { role: 'imp', request_key: 'hidden-imp', task: 'Synthetic task.', cwd: proj }),
    { ok: false, code: 'role_unavailable', reason: 'Role imp is not configured or is hidden in this project' }
  );
  const home = await f.call('hud_create', { role: 'imp', request_key: 'home-imp', task: 'Synthetic task.' });
  assert.equal(JSON.parse(fs.readFileSync(join(home.task_dir, 'job.json'), 'utf8')).model, 'synthetic/default');
});

test('an unregistered .hud is ignored and roster says so', async (t) => {
  const f = await fixture(t);
  const proj = join(f.root, 'unreg');
  fs.mkdirSync(join(proj, '.hud/roles'), { recursive: true });
  fs.writeFileSync(
    join(proj, '.hud/roles/frontend.json'),
    JSON.stringify({
      role: 'frontend',
      harness: 'pi',
      pi_role: 'implementer',
      split: false,
      can_continue: true,
      model: 'secret/model',
    })
  );
  fs.writeFileSync(join(proj, '.hud/hud-convention.md'), 'SECRET_CONVENTION');
  const roster = await f.call('hud_roster', { cwd: proj });
  assert.equal(roster.project.registered, false);
  assert.equal(roster.project.root, fs.realpathSync(proj));
  assert.equal(roster.project_config_ignored, fs.realpathSync(proj));
  assert.equal(
    roster.roles.some((entry) => entry.role === 'frontend'),
    false
  );
  assert.equal(JSON.stringify(roster).includes('SECRET_CONVENTION'), false);
  assert.equal(JSON.stringify(roster).includes('secret/model'), false);
  assert.deepEqual(
    await f.call('hud_create', { role: 'frontend', request_key: 'ignored-role', task: 'Synthetic task.', cwd: proj }),
    { ok: false, code: 'role_unavailable', reason: 'Role frontend is not configured or is hidden in this project', hint: roster.hint }
  );
});

function skillFlags(argv) {
  const paths = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--skill') paths.push(argv[i + 1]);
  return paths;
}

test('pi dispatch passes role skills and the worker prompt, and records skips', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const proj = join(f.root, 'proj');
  fs.mkdirSync(proj);
  assert.equal(spawnSync('git', ['init'], { cwd: proj, encoding: 'utf8' }).status, 0);
  const root = fs.realpathSync(proj);
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ root, registered_at: '2026-11-13T00:00:00.000Z' }] })
  );
  const linked = join(f.root, 'skills', 'to-tickets');
  const absolute = join(f.root, 'skills', 'absolute');
  fs.mkdirSync(linked, { recursive: true });
  fs.mkdirSync(absolute);
  fs.mkdirSync(join(root, '.hud', 'skills'), { recursive: true });
  fs.symlinkSync(linked, join(root, '.hud', 'skills', 'to-tickets'));
  fs.symlinkSync(join(f.root, 'skills', 'missing-target'), join(root, '.hud', 'skills', 'gone'));
  const prompt = join(root, '.hud', 'agents', 'frontend.md');
  const promptTarget = join(f.root, 'prompt-target.md');
  fs.mkdirSync(join(root, '.hud', 'agents'), { recursive: true });
  fs.writeFileSync(prompt, 'Synthetic worker prompt.\n');
  fs.writeFileSync(promptTarget, 'Linked worker prompt.\n');
  fs.symlinkSync(promptTarget, join(root, '.hud', 'agents', 'linked.md'));
  fs.symlinkSync(join(f.root, 'missing-prompt.md'), join(root, '.hud', 'agents', 'broken.md'));
  const role = (name, skills) => ({
    role: name,
    harness: 'pi',
    pi_role: 'implementer',
    split: false,
    can_continue: true,
    ...(skills ? { skills } : {}),
  });
  fs.mkdirSync(join(root, '.hud', 'roles'));
  fs.writeFileSync(
    join(root, '.hud', 'roles', 'frontend.json'),
    JSON.stringify(role('frontend', ['to-tickets', 'gone', 'no-such', '../escape', absolute]))
  );
  for (const name of ['plain', 'linked', 'broken'])
    fs.writeFileSync(join(root, '.hud', 'roles', `${name}.json`), JSON.stringify({ ...role(name), instructions: name }));
  fs.writeFileSync(
    join(root, '.hud', 'project.json'),
    JSON.stringify({ version: 1, roles: ['frontend', 'plain', 'linked', 'broken'] })
  );
  const piArgs = ['--tools', 'read'];
  const created = await f.call('hud_create', {
    role: 'frontend',
    request_key: 'skills',
    task: 'Synthetic task.',
    cwd: proj,
    pi_args: piArgs,
  });
  const argv = f.commands().find((entry) => entry.command === 'pi-role').args;
  const dash = argv.indexOf('--');
  const skillAt = argv.indexOf('--skill');
  const promptAt = argv.indexOf('--append-system-prompt');
  assert.deepEqual(skillFlags(argv), [join(root, '.hud', 'skills', 'to-tickets'), absolute]);
  assert.equal(argv[promptAt + 1], prompt);
  assert.ok(dash >= 0 && dash < skillAt && skillAt < promptAt && promptAt < argv.indexOf('--tools'));
  assert.deepEqual(argv.slice(-piArgs.length), piArgs);
  assert.equal(
    argv.some((arg) => arg.includes('..')),
    false
  );
  const expected = {
    role_skills: [
      { name: 'to-tickets', path: join(root, '.hud', 'skills', 'to-tickets') },
      { name: absolute, path: absolute },
    ],
    skipped_skills: [
      { name: 'gone', reason: 'broken' },
      { name: 'no-such', reason: 'missing' },
      { name: '../escape', reason: 'invalid' },
    ],
    worker_prompt: prompt,
  };
  const receipt = JSON.parse(fs.readFileSync(join(created.task_dir, 'job.json'), 'utf8'));
  const read = await f.call('hud_read', { job: created.job, detail: true });
  for (const value of [receipt, read]) {
    assert.deepEqual(value.role_skills, expected.role_skills);
    assert.deepEqual(value.skipped_skills, expected.skipped_skills);
    assert.equal(value.worker_prompt, expected.worker_prompt);
    assert.deepEqual(value.pi_args, piArgs);
  }
  assert.equal(receipt.dispatch_exit_code, 0);
  assert.equal(read.state, 'working');
  assert.equal(read.skills, undefined);

  const plain = await f.call('hud_create', {
    role: 'plain',
    request_key: 'no-prompt',
    task: 'Synthetic task.',
    cwd: proj,
  });
  const plainArgv = f
    .commands()
    .filter((entry) => entry.command === 'pi-role')
    .at(-1).args;
  assert.equal(plainArgv.includes('--skill'), false);
  assert.equal(plainArgv.includes('--append-system-prompt'), false);
  assert.equal(plainArgv.includes('--hud-instructions'), false, 'a pi role with no HUD text retains its Pi body');
  const sonicAt = plainArgv.indexOf('--hud-sonic-jobs');
  assert.notEqual(sonicAt, -1);
  assert.equal(plainArgv[sonicAt + 1], resolve('packages/hud-mcp/bin/sonic-jobs.mjs'));
  const plainRead = await f.call('hud_read', { job: plain.job, detail: true });
  assert.deepEqual(plainRead.role_skills, []);
  assert.deepEqual(plainRead.skipped_skills, []);
  assert.equal(plainRead.worker_prompt, null);

  const linkedJob = await f.call('hud_create', {
    role: 'linked',
    request_key: 'linked-prompt',
    task: 'Synthetic task.',
    cwd: proj,
  });
  const linkedArgv = f
    .commands()
    .filter((entry) => entry.command === 'pi-role')
    .at(-1).args;
  assert.equal(linkedArgv[linkedArgv.indexOf('--append-system-prompt') + 1], join(root, '.hud', 'agents', 'linked.md'));
  assert.equal(
    (await f.call('hud_read', { job: linkedJob.job, detail: true })).worker_prompt,
    join(root, '.hud', 'agents', 'linked.md')
  );

  const broken = await f.call('hud_create', {
    role: 'broken',
    request_key: 'broken-prompt',
    task: 'Synthetic task.',
    cwd: proj,
  });
  const brokenArgv = f
    .commands()
    .filter((entry) => entry.command === 'pi-role')
    .at(-1).args;
  assert.equal(brokenArgv.includes('--append-system-prompt'), false);
  assert.equal((await f.call('hud_read', { job: broken.job, detail: true })).worker_prompt, null);
  assert.equal(JSON.parse(fs.readFileSync(join(broken.task_dir, 'job.json'), 'utf8')).dispatch_exit_code, 0);
});

test('STATUS table matches across the panel reader and hud_read', async (t) => {
  const f = await fixture(t);
  const cases = [
    { name: 'working', status: { state: 'working', exit_reason: null }, display: 'working', raw: 'working', reason: null, blocked: false },
    {
      name: 'waiting-quiet',
      status: { state: 'waiting_orchestrator', blocked: false, reason: 'quiet', harness: 'cli' },
      display: 'working',
      raw: 'waiting_orchestrator',
      reason: 'quiet',
      blocked: false,
    },
    {
      name: 'waiting-blocked',
      status: { state: 'waiting_orchestrator', blocked: true, reason: null, harness: 'cli', agent: 'grok' },
      display: 'working',
      raw: 'waiting_orchestrator',
      reason: 'grok needs input in its pane',
      blocked: true,
    },
    { name: 'idle-grace', status: { state: 'idle_grace', exit_reason: 'settled' }, display: 'done', raw: 'idle_grace', reason: 'settled', blocked: false },
    { name: 'closed', status: { state: 'closed', exit_reason: 'settled' }, display: 'done', raw: 'closed', reason: 'settled', blocked: false },
    { name: 'done', status: { state: 'done', exit_reason: 'settled' }, display: 'done', raw: 'done', reason: 'settled', blocked: false },
    { name: 'stopped-empty', status: { state: 'stopped', output_written: false, exit_reason: 'stop requested' }, display: 'stopped', raw: 'stopped', reason: 'stop requested', blocked: false },
    { name: 'stopped-output', status: { state: 'stopped', output_written: true, exit_reason: 'stop requested' }, display: 'done', raw: 'stopped', reason: 'stop requested', blocked: false },
    { name: 'failed', status: { state: 'failed', exit_reason: 'tab closed' }, display: 'failed', raw: 'failed', reason: 'tab closed', blocked: false },
    { name: 'empty-status', status: {}, display: 'working', raw: null, reason: null, blocked: false },
    { name: 'missing-ok', status: null, dispatch_exit_code: 0, display: 'working', raw: null, reason: null, blocked: false },
    { name: 'missing-fail', status: null, dispatch_exit_code: 1, display: 'failed', raw: 'failed', reason: null, blocked: false },
  ];
  const ids = cases.map((entry, idx) => {
    const id = `j${(idx + 1).toString(16).padStart(16, '0')}`;
    const dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, 'job.json'),
      JSON.stringify({
        job: id,
        role: 'imp',
        herdr_pane: 'w4E:p1',
        cwd: f.root,
        created_at: new Date(1000 + idx * 1000).toISOString(),
        dispatch_exit_code: entry.dispatch_exit_code ?? 0,
        stderr_tail: '',
      })
    );
    if (entry.status !== null) fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify(entry.status));
    return { id, entry };
  });
  const listed = (await f.call('hud_read', { view: 'recent' })).jobs;
  const compact = (await f.call('hud_read')).jobs;
  for (const { id, entry } of ids) {
    if (entry.raw === 'waiting_orchestrator') {
      assert.deepEqual(compact.find((row) => row.job === id), {
        job: id, role: 'imp', state: entry.raw, reason: entry.reason,
        ...(entry.blocked ? { blocked: true } : {}),
      });
    }
    const panel = workerFor(f, id);
    const single = await f.call('hud_read', { job: id, detail: true });
    const row = listed.find((item) => item.job === id);
    assert.equal(panel.state, entry.display, `${entry.name} panel.state`);
    assert.equal(single.display_state, entry.display, `${entry.name} hud_read.display_state`);
    assert.equal(single.state, entry.raw, `${entry.name} hud_read.state`);
    assert.equal(single.reason, entry.reason, `${entry.name} hud_read.reason`);
    assert.equal(single.blocked, entry.blocked, `${entry.name} hud_read.blocked`);
    assert.equal(row.display_state, entry.display, `${entry.name} list.display_state`);
    assert.equal(row.state, entry.raw, `${entry.name} list.state`);
    assert.equal(row.reason, entry.reason, `${entry.name} list.reason`);
    assert.equal(row.blocked, entry.blocked, `${entry.name} list.blocked`);
  }
});

test('hud_read wait_ms wakes on waiting_orchestrator and session changes ride once per response', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const created = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'wait-seed',
    task: 'Seed session cursor without self-reporting create.',
  });
  assert.equal('changes' in created, false);
  const createdStatus = join(created.task_dir, 'STATUS.json');
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(createdStatus) && JSON.parse(fs.readFileSync(createdStatus, 'utf8')).state === 'working') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await f.call('hud_close', { job: created.job });
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(createdStatus) && JSON.parse(fs.readFileSync(createdStatus, 'utf8')).state === 'stopped') break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const writeSyntheticJob = (id, pane, pkg, state) => {
    const dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, 'job.json'),
      JSON.stringify({
        job: id,
        role: 'imp',
        package: pkg,
        cwd: f.root,
        herdr_pane: pane,
        created_at: new Date().toISOString(),
        cli: { agent: 'grok' },
        dispatch_exit_code: 0,
        stderr_tail: '',
      })
    );
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state, exit_reason: null }));
    return dir;
  };

  const w1Dir = writeSyntheticJob('j00000000000001a1', 'w4E:p1', '02-wait', 'working');
  await f.call('hud_roster');
  const settledSeed = await f.call('hud_roster');
  assert.equal('changes' in settledSeed, false);

  const waitPromise = f.call('hud_read', { job: 'j00000000000001a1', wait_ms: 5000 });
  await new Promise((r) => setTimeout(r, 80));
  fs.writeFileSync(
    join(w1Dir, 'STATUS.json'),
    JSON.stringify({ state: 'waiting_orchestrator', blocked: false, reason: 'quiet', harness: 'cli' })
  );
  const waited = await waitPromise;
  assert.equal(waited.state, 'waiting_orchestrator');
  assert.equal(waited.blocked, undefined);
  assert.equal(waited.changes?.length, 1);
  assert.match(waited.changes[0], /^j00000000000001a1 imp 02-wait: waiting_orchestrator \| quiet$/);

  const afterWait = await f.call('hud_roster');
  assert.equal('changes' in afterWait, false);

  const w2Dir = writeSyntheticJob('j00000000000001a2', 'w4E:p1', '02-roster', 'working');
  const foreignDir = writeSyntheticJob('j00000000000001f9', 'w4E:p9', 'foreign-pane', 'working');
  const baseline = await f.call('hud_roster');
  assert.equal(baseline.changes?.length, 1);
  assert.match(baseline.changes[0], /^j00000000000001a2 imp 02-roster: working$/);

  fs.writeFileSync(join(w2Dir, 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator', exit_reason: null }));
  fs.writeFileSync(
    join(foreignDir, 'STATUS.json'),
    JSON.stringify({ state: 'waiting_orchestrator', exit_reason: null })
  );

  const roster1 = await f.call('hud_roster');
  assert.equal(roster1.changes?.length, 1);
  assert.match(roster1.changes[0], /^j00000000000001a2 imp 02-roster: waiting_orchestrator\b/);

  const roster2 = await f.call('hud_roster');
  assert.equal('changes' in roster2, false);
});

test('an answer the owner gives from the panel rides on the next response as one change line', async (t) => {
  const f = await fixture(t);
  const dir = join(f.env.HUD_HOME, 'jobs', 'j00000000000001b1');
  fs.mkdirSync(join(dir, 'qa'), { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: 'j00000000000001b1', role: 'imp', package: '03-ask', cwd: f.root, herdr_pane: 'w4E:p1', created_at: new Date().toISOString(),
    cli: { agent: 'grok' }, dispatch_exit_code: 0, stderr_tail: '' }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'working' }));
  fs.writeFileSync(join(dir, 'qa/q1.md'), '# Question q1 from imp@demo\n\nKeep it?\n\nOptions:\n- keep it\n- drop it\n\nDefault if unanswered: keep it\n');
  await f.call('hud_roster');
  assert.equal('changes' in (await f.call('hud_roster')), false);
  assert.deepEqual(answerJobQuestion(f.env.HUD_HOME, 'j00000000000001b1', 'q1', 'drop it', 'imp'), { ok: true, written: true });
  const next = await f.call('hud_roster');
  assert.ok(next.changes.includes('[imp@j00000000000001b1] ANSWERED q1 from panel: drop it'), JSON.stringify(next.changes));
  assert.equal('changes' in (await f.call('hud_roster')), false, 'once');
});

test('unregistered skill names are skipped and a CLI role is not given skill flags', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const absolute = join(f.root, 'abs-skill');
  fs.mkdirSync(absolute);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'home-skilled.json'),
    JSON.stringify({
      role: 'home-skilled',
      harness: 'pi',
      pi_role: 'implementer',
      split: false,
      can_continue: true,
      skills: ['to-tickets', absolute],
    })
  );
  fs.mkdirSync(join(f.root, '.hud', 'agents'), { recursive: true });
  fs.writeFileSync(join(f.root, '.hud', 'agents', 'home-skilled.md'), 'Must not load.\n');
  const job = await f.call('hud_create', {
    role: 'home-skilled',
    request_key: 'home-skills',
    task: 'Synthetic task.',
    pi_args: ['--tools', 'read'],
  });
  const argv = f.commands().find((entry) => entry.command === 'pi-role').args;
  assert.deepEqual(skillFlags(argv), [absolute]);
  assert.equal(argv.includes('--append-system-prompt'), false);
  assert.ok(argv.indexOf('--') < argv.indexOf('--skill') && argv.indexOf('--skill') < argv.indexOf('--tools'));
  assert.deepEqual(argv.slice(-2), ['--tools', 'read']);
  const read = await f.call('hud_read', { job: job.job, detail: true });
  assert.deepEqual(read.role_skills, [{ name: absolute, path: absolute }]);
  assert.deepEqual(read.skipped_skills, [{ name: 'to-tickets', reason: 'unresolved' }]);
  assert.equal(read.worker_prompt, null);

  const cli = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'cli-untouched',
    task: 'Synthetic cli task.',
  });
  const receipt = JSON.parse(fs.readFileSync(join(cli.task_dir, 'job.json'), 'utf8'));
  assert.equal(Object.hasOwn(receipt, 'role_skills'), false);
  assert.equal(Object.hasOwn(receipt, 'skipped_skills'), false);
  assert.equal(Object.hasOwn(receipt, 'worker_prompt'), false);
  const start = f.commands().find((entry) => entry.args[1] === 'start' && entry.args[2] === `${cli.job}-primary`);
  assert.equal(start.args.includes('--skill'), false);
  assert.equal(start.args.includes('--append-system-prompt'), false);
  const cliRead = await f.call('hud_read', { job: cli.job });
  assert.equal(Object.hasOwn(cliRead, 'role_skills'), false);
  assert.equal(Object.hasOwn(cliRead, 'skipped_skills'), false);
  assert.equal(Object.hasOwn(cliRead, 'worker_prompt'), false);
});

async function fakeDecisionServer(t, handler) {
  const requests = [];
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const reply = await handler(body, requests.length, req);
      if (reply?.status && reply.status !== 200) {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body ?? { error: 'synthetic error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const port = server.address().port;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function decisionAnswer(choice, probability, rest = 0.02) {
  const choices = ['still-working', 'finished-no-report', 'failed', 'needs-human'];
  const remainder = Math.max(0, 1 - probability);
  const perOther = remainder / (choices.length - 1);
  return {
    answers: [
      {
        name: 'quiet_job',
        type: 'choice',
        choice,
        probabilities: choices.map((value) => ({ value, probability: value === choice ? probability : perOther })),
        confidence: Math.max(0, probability - rest),
      },
    ],
  };
}

function configureFakeDecision(f, baseUrl, cap = 0) {
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'credentials.env'),
    `OPENAI_API_KEY=synthetic-openai-key\nOPENAI_BASE_URL=${baseUrl}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'config.json'),
    JSON.stringify({ decisions: { primary: 'openai', openai: { baseUrl } } }),
    { mode: 0o600 }
  );
  if (cap > 0) {
    fs.writeFileSync(
      join(f.env.HUD_HOME, 'hud-settings.json'),
      JSON.stringify({ decisionCallsPerHour: cap }),
      { mode: 0o600 }
    );
  }
}

test('quiet decision discards a stale reply after working/done pushes during the API call', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'decision-race', 0.25);
  let job;
  const server = await fakeDecisionServer(t, async (_body, count) => {
    if (count === 1) {
      f.push(job.job, 'working');
      await new Promise((r) => setTimeout(r, 50));
      f.push(job.job, 'done');
      await new Promise((r) => setTimeout(r, 50));
      return decisionAnswer('finished-no-report', 0.95);
    }
    return decisionAnswer('needs-human', 0.95);
  });
  configureFakeDecision(f, server.baseUrl);
  job = await f.call('hud_create', { role: 'decision-race', request_key: 'decision-race', task: 'Synthetic decision race.' });
  await until(() => cliState(job.task_dir)?.pid);
  f.push(job.job, 'done');
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator');
  assert.equal(server.requests.length, 2);
  assert.equal(f.commands().some((c) => String(c.args[3]).startsWith('Write your report to ')), false);
});

test('quiet decision still-working keeps waiting up to 3 questions then escalates, showing on card and Inspector', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-wait', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(
    join(f.env.HOME, 'pane-read'),
    Array.from({ length: 70 }, (_, i) => `line ${i + 1}: waiting on background build`).join('\n') + '\n'
  );
  const server = await fakeDecisionServer(t, () => decisionAnswer('still-working', 0.91));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'qd-wait', request_key: 'qd-wait', task: 'Synthetic quiet wait.' });
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 12000);
  assert.equal(server.requests.length, 3);
  const sentBody = server.requests[0];
  const pageText = sentBody.input[0].content[1].data.page.text;
  assert.equal(pageText.split('\n').length, 60);
  assert.ok(pageText.startsWith('line 11:'));
  const facts = sentBody.input[0].content[2].data.facts;
  assert.equal(facts.background_child_alive, false);
  assert.equal(typeof facts.minutes_quiet, 'number');
  assert.equal(facts.job_state, 'working');
  const status = cliState(job.task_dir);
  assert.equal(status.quiet_decision.action, 'needs-human');
  assert.equal(status.quiet_decision.reason, 'max-questions');
  const calls = JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'display/model-cache/decision-api/calls.json'), 'utf8'));
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.feature === 'quiet-job'));
  const worker = workerFor(f, job.job);
  assert.equal(worker.quietDecision.action, 'needs-human');
  assert.match(cardText(worker), /needs-human \(max questions\)/);
  const inspectText = workInspectorRows(worker, initialMonitorState(), 80, Date.now()).map((r) => stripAnsi(r.text)).join('\n');
  assert.match(inspectText, /quiet\s+needs-human \(max questions\)/);
});

test('quiet decision finished-no-report sends fixed prompt once per job and settles; second never sends twice', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-prompt', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'write-on-report-prompt'), '');
  const server = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.93));
  configureFakeDecision(f, server.baseUrl);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  await f.startCliSocket();
  const handle = await taskCall(rpc, 'hud_create', { role: 'qd-prompt', request_key: 'qd-prompt-1', task: 'Synthetic report prompt.' });
  const job = taskJob(f, handle);
  await until(() => cliState(job.task_dir)?.state === 'closed', 10000);
  const done = await rpc('tasks/get', { taskId: handle.taskId });
  assert.equal(done.status, 'completed');
  assert.match(done.result.content[0].text, /Summary: Synthetic report after prompt\./);
  const expectedPrompt = `Write your report to ${join(job.task_dir, 'report.md')} now; if work remains, finish it first.`;
  const prompts = f.commands().filter((c) => c.args[1] === 'prompt' && c.args[3]?.split('\n')[0] === expectedPrompt);
  assert.equal(prompts.length, 1);
  assert.equal(cliState(job.task_dir).quiet_decision.choice, 'finished-no-report');
  assert.equal(cliState(job.task_dir).quiet_decision.probability, 0.93);
  assert.equal(cliState(job.task_dir).quiet_decision.action, 'prompt-report');

  // Second finished-no-report in the same job must NOT send the prompt twice -> needs-human.
  const f2 = await fixture(t);
  writeCliRole(f2, 'qd-prompt2', 1, false);
  fs.writeFileSync(join(f2.env.HOME, 'missing-report'), '');
  const server2 = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.94));
  configureFakeDecision(f2, server2.baseUrl);
  const job2 = await f2.call('hud_create', { role: 'qd-prompt2', request_key: 'qd-prompt-2', task: 'Synthetic no repeat.' });
  await until(() => cliState(job2.task_dir)?.state === 'waiting_orchestrator', 10000);
  const expectedPrompt2 = `Write your report to ${join(job2.task_dir, 'report.md')} now; if work remains, finish it first.`;
  const prompts2 = f2.commands().filter((c) => c.args[1] === 'prompt' && c.args[3]?.split('\n')[0] === expectedPrompt2);
  assert.equal(prompts2.length, 1);
  assert.equal(server2.requests.length, 2);
  const status2 = cliState(job2.task_dir);
  assert.equal(status2.quiet_decision.choice, 'finished-no-report');
  assert.equal(status2.quiet_decision.probability, 0.94);
  assert.equal(status2.quiet_decision.action, 'needs-human');
  const worker2 = workerFor(f2, job2.job);
  assert.match(cardText(worker2), /finished-no-report 94%/);
  const inspect2 = workInspectorRows(worker2, initialMonitorState(), 110, Date.now()).map((r) => stripAnsi(r.text)).join('\n');
  assert.match(inspect2, /finished-no-report 94% → needs-human/);
});

test('quiet decision failed uses screen line and quota marks place exhausted', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'qd-fail.json'),
    JSON.stringify({
      role: 'qd-fail',
      instructions: 'implementer',
      can_continue: false,
      idle_grace_s: 1,
      run: [
        { harness: 'cli', agent: 'grok', model: 'grok-4.7' },
        { harness: 'cli', agent: 'claude', model: 'opus-5.5' },
      ],
    })
  );
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'pane-read'), 'working...\nError: 429 rate limit exceeded for grok-4.7\n> \n');
  const server = await fakeDecisionServer(t, () => decisionAnswer('failed', 0.96));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'qd-fail', request_key: 'qd-fail', task: 'Synthetic quota fail.' });
  await until(() => cliState(job.task_dir)?.state === 'failed', 8000);
  const status = cliState(job.task_dir);
  assert.match(status.exit_reason, /429 rate limit exceeded/);
  assert.match(status.exit_reason, /next dispatch will use cli\/claude \(opus-5\.5\)/);
  assert.equal(status.quiet_decision.choice, 'failed');
  assert.equal(status.quiet_decision.probability, 0.96);
  assert.equal(status.quiet_decision.action, 'fail');
  const exhausted = JSON.parse(fs.readFileSync(join(f.env.HUD_HOME, 'exhausted.json'), 'utf8'));
  assert.ok(exhausted.places['cli:grok:grok-4.7']);
  const worker = workerFor(f, job.job);
  assert.match(cardText(worker), /failed 96% → fail/);
});

test('quiet decision failed without quota regex falls back to needs-human without exhausting', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-nonquota', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'pane-read'), 'working...\nError: segmentation fault in worker\n> \n');
  const server = await fakeDecisionServer(t, () => decisionAnswer('failed', 0.95));
  configureFakeDecision(f, server.baseUrl);
  const job = await f.call('hud_create', { role: 'qd-nonquota', request_key: 'qd-nonquota', task: 'Synthetic non-quota error.' });
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 8000);
  const status = cliState(job.task_dir);
  assert.equal(status.reason, 'quiet without a report; hud_send to continue or hud_close to stop');
  assert.equal(status.quiet_decision.choice, 'failed');
  assert.equal(status.quiet_decision.probability, 0.95);
  assert.equal(status.quiet_decision.action, 'needs-human');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'exhausted.json')), false);
  assert.equal(f.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);
});

test('low probability, cap reached, and provider error all fall back to needs-human without prompting worker', { timeout: 20000 }, async (t) => {
  // 1. Low probability (< 0.8)
  const fLow = await fixture(t);
  writeCliRole(fLow, 'qd-low', 1, false);
  fs.writeFileSync(join(fLow.env.HOME, 'missing-report'), '');
  const sLow = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.79));
  configureFakeDecision(fLow, sLow.baseUrl);
  const jLow = await fLow.call('hud_create', { role: 'qd-low', request_key: 'qd-low', task: 'Synthetic low prob.' });
  await until(() => cliState(jLow.task_dir)?.state === 'waiting_orchestrator', 8000);
  assert.equal(cliState(jLow.task_dir).quiet_decision.choice, 'finished-no-report');
  assert.equal(cliState(jLow.task_dir).quiet_decision.probability, 0.79);
  assert.equal(cliState(jLow.task_dir).quiet_decision.action, 'needs-human');
  assert.equal(fLow.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);

  // 2. Cap reached
  const fCap = await fixture(t);
  writeCliRole(fCap, 'qd-cap', 1, false);
  fs.writeFileSync(join(fCap.env.HOME, 'missing-report'), '');
  const sCap = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.95));
  configureFakeDecision(fCap, sCap.baseUrl, 1);
  const apiDir = join(fCap.env.HUD_HOME, 'display/model-cache/decision-api');
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(join(apiDir, 'calls.json'), JSON.stringify([{ at: Date.now(), feature: 'outcome' }]));
  const jCap = await fCap.call('hud_create', { role: 'qd-cap', request_key: 'qd-cap', task: 'Synthetic cap.' });
  await until(() => cliState(jCap.task_dir)?.state === 'waiting_orchestrator', 8000);
  assert.equal(sCap.requests.length, 0);
  assert.equal(cliState(jCap.task_dir).quiet_decision.action, 'needs-human');
  assert.equal(cliState(jCap.task_dir).quiet_decision.reason, 'cap');
  assert.equal(fCap.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);

  // 3. Provider error (HTTP 500)
  const fErr = await fixture(t);
  writeCliRole(fErr, 'qd-err', 1, false);
  fs.writeFileSync(join(fErr.env.HOME, 'missing-report'), '');
  const sErr = await fakeDecisionServer(t, () => ({ status: 500, body: { error: 'boom' } }));
  configureFakeDecision(fErr, sErr.baseUrl);
  const jErr = await fErr.call('hud_create', { role: 'qd-err', request_key: 'qd-err', task: 'Synthetic error.' });
  await until(() => cliState(jErr.task_dir)?.state === 'waiting_orchestrator', 8000);
  assert.equal(sErr.requests.length, 1);
  assert.equal(cliState(jErr.task_dir).quiet_decision.action, 'needs-human');
  assert.equal(cliState(jErr.task_dir).quiet_decision.reason, 'error');
  assert.equal(fErr.commands().filter((c) => c.args[1] === 'prompt' && c.args[2] !== 'w4E:p1').length, 1);
});

for (const agent of ['codex', 'claude']) test(`hud_create starts exactly one queue watcher only for Codex (${agent})`, async (t) => {
  const f = await fixture(t, true, `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const spawn = cp.spawn;
    cp.spawn = (command, args, options) => {
      if (args?.includes('--queue')) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: 'queue-watch', args, detached: options.detached, stdio: options.stdio }) + '\\n');
      return spawn(command, args, options);
    };
    syncBuiltinESMExports();
  `);
  fs.writeFileSync(join(f.env.HOME, 'main-agent'), agent);
  const pidFile = join(f.env.HUD_HOME, 'watchers/w4E:p1.pid');
  const args = { role: 'imp', request_key: 'queue-start', task: 'Synthetic queue watcher.' };
  const job = await f.call('hud_create', args);
  await f.call('hud_create', args);
  await f.call('hud_create', { ...args, request_key: 'queue-second' });
  const starts = f.commands().filter((c) => c.command === 'queue-watch');
  assert.equal(starts.length, agent === 'codex' ? 1 : 0);
  if (agent === 'codex') {
    assert.deepEqual(starts[0].args, [resolve('bin/hud'), 'watch', '--queue']);
    assert.equal(starts[0].detached, true);
    assert.equal(starts[0].stdio, 'ignore');
    assert.equal(fs.existsSync(pidFile), true);
    fs.writeFileSync(join(f.env.HOME, 'main-agent'), 'claude');
  } else assert.equal(fs.existsSync(pidFile), false);
  assert.notEqual(job.ok, false);
  assert.match(job.job, /^j[0-9a-f]{16}$/);
});

test('roster sends the convention once and returns only the caller’s delivery hint', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'main-agent'), 'codex');
  const first = await f.call('hud_roster');
  assert.doesNotMatch(first.convention.text, /Claude Code:|Codex:|pi:|watcher_alive/);
  assert.match(first.hint, /^Codex: events are queued automatically;/);
  assert.doesNotMatch(first.hint, /Claude Code:|pi:/);
  const repeat = await f.call('hud_roster');
  assert.equal(repeat.convention, undefined);
  assert.equal(repeat.convention_unchanged, true);
  assert.deepEqual(repeat.roles, first.roles);
  assert.equal(repeat.hint, first.hint);
  assert.deepEqual((await f.call('hud_roster', { convention_version: 'force' })).convention, first.convention);
});

test('report written while working settles only at turn end, not mid-turn slice timeout', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'mid-report-cli', 1, true);
  fs.writeFileSync(join(f.env.HOME, 'report-while-working'), '');
  const job = await f.call('hud_create', {
    role: 'mid-report-cli',
    request_key: 'mid-report',
    task: 'Write report mid-turn while still working.',
  });
  await until(() => fs.existsSync(join(job.task_dir, 'report.md')), 5000);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(cliState(job.task_dir).state, 'working');
  assert.equal(cliState(job.task_dir).output_written, false);
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);

  fs.writeFileSync(join(f.env.HOME, 'release-done'), '');
  await until(() => cliState(job.task_dir)?.state === 'idle_grace' && cliState(job.task_dir)?.output_written === true, 5000);
  await until(() => cliState(job.task_dir)?.state === 'closed', 5000);
  assert.equal(cliState(job.task_dir).output_written, true);
  assert.equal(cliState(job.task_dir).exit_reason, 'settled');
});

test('no /quit before done for a noncontinuable CLI', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'no-cont-mid', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'report-while-working'), '');
  const noCont = await f.call('hud_create', {
    role: 'no-cont-mid',
    request_key: 'no-quit-early',
    task: 'Must not send /quit before done.',
  });
  await until(() => fs.existsSync(join(noCont.task_dir, 'report.md')), 5000);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(cliState(noCont.task_dir).state, 'working');
  assert.equal(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'), false);
  fs.writeFileSync(join(f.env.HOME, 'release-done'), '');
  await until(() => cliState(noCont.task_dir)?.state === 'closed', 5000);
  assert.equal(cliState(noCont.task_dir).output_written, true);
  assert.ok(f.commands().some((c) => c.args[1] === 'prompt' && c.args[3] === '/quit'));
});

test('an unread declared report closes at the idle deadline and reaps leftovers', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const worker = fakeCliWithChild(t, f);
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  writeCliRole(f, 'grace-bg-cli', 1, true);
  const graceJob = await f.call('hud_create', {
    role: 'grace-bg-cli',
    request_key: 'grace-bg-hold',
    task: 'Background child holds grace.',
  });
  await until(() => cliState(graceJob.task_dir)?.pid === worker.pid);
  const child = await worker.start();
  fs.writeFileSync(join(graceJob.task_dir, 'report.md'), 'Synthetic report with leftover child.\n');
  declareDone(f, graceJob);
  await until(() => cliState(graceJob.task_dir)?.state === 'idle_grace');
  const quit = () => f.commands().some((c) => c.args[1] === 'prompt' && c.args[2] === `${graceJob.job}-primary` && c.args[3] === '/quit');
  const reaped = () => f.commands().some((c) => c.command === 'pi-role-reap' && c.args[0] === graceJob.task_dir);
  assert.ok(procStat(child));
  await until(() => cliState(graceJob.task_dir)?.state === 'closed', 2200);
  await until(reaped);
  assert.ok(quit());
  await until(() => procStat(child) === null);
});

test('exit is a /proc pid check: herdr errors keep working while pid lives, PID gone closes or fails, unknown PID asks after 3 ticks', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const spawnDummy = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    return child;
  };

  // 1. Live pid stays working across repeated herdr errors, then closes cleanly once herdr recovers.
  const liveProc = spawnDummy();
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(liveProc.pid));
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  const keepAlive = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'herdr-errors-alive',
    task: 'Keep working when herdr errors while pid lives.',
  });
  await until(
    () =>
      f.socketRequests.filter((req) => req.method === 'agent.get' && req.params.target === `${keepAlive.job}-primary`).length >= 5,
    5000
  );
  assert.equal(cliState(keepAlive.task_dir).state, 'working');
  assert.equal(cliState(keepAlive.task_dir).pid, liveProc.pid);
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));
  await until(() => cliState(keepAlive.task_dir)?.state === 'closed', 8000);

  // 2. Pid gone without a report -> failed.
  const procNoReport = spawnDummy();
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(procNoReport.pid));
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const failJob = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'pid-gone-fail',
    task: 'Pid dies without report.',
  });
  await until(() => cliState(failJob.task_dir)?.pid === procNoReport.pid);
  procNoReport.kill('SIGKILL');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  await until(() => cliState(failJob.task_dir)?.state === 'failed', 5000);
  assert.equal(cliState(failJob.task_dir).exit_reason, 'worker exited');
  assert.equal(cliState(failJob.task_dir).output_written, false);
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));

  // 3. Pid gone with a report -> closed (output_written true).
  const procWithReport = spawnDummy();
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(procWithReport.pid));
  const closeJob = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'pid-gone-report',
    task: 'Pid dies after writing report.',
  });
  await until(() => cliState(closeJob.task_dir)?.pid === procWithReport.pid);
  fs.writeFileSync(join(closeJob.task_dir, 'report.md'), 'Finished before exit.\n');
  procWithReport.kill('SIGKILL');
  fs.writeFileSync(join(f.env.HOME, 'herdr-errors'), '');
  await until(() => cliState(closeJob.task_dir)?.state === 'closed', 5000);
  assert.equal(cliState(closeJob.task_dir).exit_reason, 'settled');
  assert.equal(cliState(closeJob.task_dir).output_written, true);

  // 4. Unknown PID and three consecutive missing ticks hand off, never fail.
  fs.unlinkSync(join(f.env.HOME, 'herdr-errors'));
  fs.unlinkSync(join(f.env.HOME, 'cli-pid'));
  fs.writeFileSync(join(f.env.HOME, 'no-pid'), '');
  const nullPidJob = await f.call('hud_create', {
    role: 'imp',
    on: 'grok',
    request_key: 'null-pid-3-misses',
    task: 'Null pid requires 3 consecutive misses.',
  });
  await until(() => cliState(nullPidJob.task_dir)?.state === 'waiting_orchestrator', 6000);
  const agentGets = f.socketRequests.filter((req) => req.method === 'agent.get' && req.params.target === `${nullPidJob.job}-primary`);
  assert.ok(agentGets.length >= 4);
  assert.equal(cliState(nullPidJob.task_dir).reason, 'worker not found');
});

test('hud_send restarts a dead supervisor only when the worker is confirmed alive', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'respawn-cli', 1, true);
  const spawnDummy = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    return child;
  };
  const dead = (pid) => procStat(pid) === null;

  // 1. Dead supervisor + live worker -> hud-watch marks waiting_orchestrator -> hud_send spawns a new supervisor and the turn settles.
  const liveWorker = spawnDummy();
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(liveWorker.pid));
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const job = await f.call('hud_create', { role: 'respawn-cli', request_key: 'respawn-live', task: 'Respawn on live worker.' });
  await until(() => cliState(job.task_dir)?.pid === liveWorker.pid && cliState(job.task_dir)?.supervisor_pid);
  const oldSupPid = cliState(job.task_dir).supervisor_pid;
  const startedAt = cliState(job.task_dir).started_at;
  process.kill(oldSupPid, 'SIGKILL');
  await until(() => dead(oldSupPid));
  fs.utimesSync(join(job.task_dir, 'STATUS.json'), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 5000);
  assert.equal(cliState(job.task_dir).reason, 'supervisor exited; worker still running');

  const sent = await f.call('hud_send', { job: job.job, message_key: 'respawn', text: 'Continue with new supervisor.' });
  assert.equal(sent.sent, true);
  await until(() => cliState(job.task_dir)?.state === 'working' && cliState(job.task_dir)?.supervisor_pid !== oldSupPid, 5000);
  const newSupPid = cliState(job.task_dir).supervisor_pid;
  assert.notEqual(newSupPid, oldSupPid);
  assert.equal(dead(newSupPid), false);
  assert.equal(fs.readFileSync(join(job.task_dir, 'supervisor.pid'), 'utf8').trim(), String(newSupPid));
  assert.equal(cliState(job.task_dir).pid, liveWorker.pid);
  assert.equal(cliState(job.task_dir).started_at, startedAt);
  assert.equal(cliState(job.task_dir).reason, null);
  fs.unlinkSync(join(f.env.HOME, 'hold-turn'));
  await until(() => cliState(job.task_dir)?.state === 'closed', 8000);
  assert.equal(cliState(job.task_dir).output_written, true);
  assert.equal(cliState(job.task_dir).exit_reason, 'settled');
  await until(() => !fs.existsSync(join(f.env.HUD_HOME, 'watch.pid')));

  // 2. Dead supervisor + dead worker -> keeps today's hud_send behaviour without respawning.
  const dyingWorker = spawnDummy();
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(dyingWorker.pid));
  fs.writeFileSync(join(f.env.HOME, 'hold-turn'), '');
  const goneJob = await f.call('hud_create', { role: 'respawn-cli', request_key: 'respawn-gone', task: 'No respawn when worker gone.' });
  await until(() => cliState(goneJob.task_dir)?.pid === dyingWorker.pid && cliState(goneJob.task_dir)?.supervisor_pid);
  const goneSupPid = cliState(goneJob.task_dir).supervisor_pid;
  process.kill(goneSupPid, 'SIGKILL');
  dyingWorker.kill('SIGKILL');
  await until(() => dead(goneSupPid) && dead(dyingWorker.pid));
  const sentGone = await f.call('hud_send', { job: goneJob.job, message_key: 'gone-before-watch', text: 'Worker already dead.' });
  assert.equal(sentGone.sent, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.readFileSync(join(goneJob.task_dir, 'supervisor.pid'), 'utf8').trim(), String(goneSupPid));
  fs.utimesSync(join(goneJob.task_dir, 'STATUS.json'), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  await until(() => cliState(goneJob.task_dir)?.state === 'failed', 5000);
  assert.deepEqual(
    await f.call('hud_send', { job: goneJob.job, message_key: 'gone-after-watch', text: 'Still dead.' }),
    { ok: false, code: 'not_continuable' }
  );
  assert.equal(fs.readFileSync(join(goneJob.task_dir, 'supervisor.pid'), 'utf8').trim(), String(goneSupPid));

  // 3. Dead supervisor + unknown worker liveness -> keeps today's hud_send behaviour without respawning.
  fs.unlinkSync(join(f.env.HOME, 'cli-pid'));
  fs.unlinkSync(join(f.env.HOME, 'hold-turn'));
  fs.writeFileSync(join(f.env.HOME, 'manual-socket'), '');
  fs.writeFileSync(join(f.env.HOME, 'no-pid'), '');
  const unknownJob = await f.call('hud_create', { role: 'respawn-cli', request_key: 'respawn-unknown', task: 'No respawn when liveness unknown.' });
  await until(() => cliState(unknownJob.task_dir)?.state === 'waiting_orchestrator', 6000);
  const unknownSupPid = cliState(unknownJob.task_dir).supervisor_pid;
  process.kill(unknownSupPid, 'SIGKILL');
  await until(() => dead(unknownSupPid));
  const sentUnknown = await f.call('hud_send', { job: unknownJob.job, message_key: 'unknown-worker', text: 'Worker liveness unknown.' });
  assert.equal(sentUnknown.sent, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.readFileSync(join(unknownJob.task_dir, 'supervisor.pid'), 'utf8').trim(), String(unknownSupPid));
});

test('failed prompt-report keeps waiting_orchestrator across turn wake', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-prompt-fail', 1, false);
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  fs.writeFileSync(join(f.env.HOME, 'fail-report-prompt'), '');
  const server = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.93));
  configureFakeDecision(f, server.baseUrl);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  await f.startCliSocket();
  const handle = await taskCall(rpc, 'hud_create', { role: 'qd-prompt-fail', request_key: 'qd-prompt-fail', task: 'Synthetic failed report prompt.' });
  const job = taskJob(f, handle);
  await until(() => cliState(job.task_dir)?.state === 'waiting_orchestrator', 10000);
  const attention = await rpc('tasks/get', { taskId: handle.taskId });
  assert.equal(attention.status, 'completed');
  assert.match(attention.result.content[0].text, /waiting_orchestrator — quiet without a report; .*Use hud_read\/hud_peek/);
  assert.deepEqual(await rpc('tasks/cancel', { taskId: handle.taskId }), attention);
  assert.equal(reapAttempts(f, job), 0);
  const status = cliState(job.task_dir);
  assert.equal(status.quiet_decision.action, 'needs-human');
  assert.equal(status.quiet_decision.reason, 'prompt-failed');
  const turn = JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json'), 'utf8'));
  assert.equal(turn.seq, 2);
  assert.equal(turn.report_prompt_sent, true);

  // Even after turn.json watch/debounce wakes the supervisor, waiting_orchestrator holds.
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(cliState(job.task_dir).state, 'waiting_orchestrator');
  assert.equal(cliState(job.task_dir).quiet_decision.reason, 'prompt-failed');
  assert.equal(server.requests.length, 1);
  // The session sees why, not only the generic reason.
  const read = await f.call('hud_read', { job: job.job });
  assert.deepEqual([read.quiet_decision?.action, read.quiet_decision?.reason], ['needs-human', 'prompt-failed']);
});

test('reportPromptSent persists across supervisor restart via hud_send', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  writeCliRole(f, 'qd-prompt-respawn', 1, true);
  const liveWorker = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { liveWorker.kill('SIGKILL'); } catch {} });
  fs.writeFileSync(join(f.env.HOME, 'cli-pid'), String(liveWorker.pid));
  fs.writeFileSync(join(f.env.HOME, 'missing-report'), '');
  const server = await fakeDecisionServer(t, () => decisionAnswer('finished-no-report', 0.93));
  configureFakeDecision(f, server.baseUrl);

  const job = await f.call('hud_create', { role: 'qd-prompt-respawn', request_key: 'qd-prompt-respawn', task: 'Synthetic respawn no repeat.' });
  const expectedPrompt = `Write your report to ${join(job.task_dir, 'report.md')} now; if work remains, finish it first.`;
  const prompts = () => f.commands().filter((c) => c.args[1] === 'prompt' && c.args[3]?.split('\n')[0] === expectedPrompt);
  await until(() => prompts().length === 1 && cliState(job.task_dir)?.supervisor_pid, 10000);
  const oldSupPid = cliState(job.task_dir).supervisor_pid;
  assert.equal(JSON.parse(fs.readFileSync(join(job.task_dir, 'turn.json'), 'utf8')).report_prompt_sent, true);

  process.kill(oldSupPid, 'SIGKILL');
  await until(() => procStat(oldSupPid) === null);
  const sent = await f.call('hud_send', { job: job.job, message_key: 'respawn-no-repeat', text: 'Continue after supervisor restart.' });
  assert.equal(sent.sent, true);
  await until(() => cliState(job.task_dir)?.supervisor_pid !== oldSupPid && cliState(job.task_dir)?.state === 'waiting_orchestrator', 10000);

  assert.equal(prompts().length, 1);
  assert.ok(server.requests.length >= 2);
  assert.equal(server.requests.at(-1).input[0].content[2].data.facts.report_prompt_already_sent, true);
  assert.equal(cliState(job.task_dir).quiet_decision.action, 'needs-human');
});
