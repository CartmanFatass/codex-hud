import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { renderWorkCard } from '../../dist/render/work-card.js';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { procStat, turnToken } from '../../dist/mcp/cli-judge.js';

export const workerFor = (f, id) =>
  readThinJobs(f.env.HUD_HOME, { project: null, pane: 'w4E:p1' })
    .flatMap((lane) => lane.workers)
    .find((worker) => worker.id === 'thin-job:' + id);
export const cardText = (worker) =>
  renderWorkCard(projectWorkCard(worker, Date.now()), { ...initialMonitorState(), mainTab: 'home' }, 56)
    .map(stripAnsi)
    .join('\n');

export const entry = resolve('packages/hud-mcp/bin/hud-mcp.mjs');
export const withoutHint = ({ hint, ...result }) => result;
export const withoutCallerLookups = (commands) => commands.filter(({ command, args }) =>
  !(command === 'herdr' && args[0] === 'pane' && args[1] === 'get' && args[2] === 'w4E:p1'));
export async function fixture(t, inHerdr = true, probe = '', watcherTickMs, worker = false) {
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
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

export function rpcClient(child) {
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

export function workerClient(t, f, dir, askTimeout = '30') {
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
export const resultValue = (result) => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};

export async function until(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, 'condition did not settle');
    await new Promise((done) => setTimeout(done, 20));
  }
}

export const tasksExtension = 'io.modelcontextprotocol/tasks';
export function taskRpc(rpc) {
  return async (method, params = {}) => {
    const { result, error } = await rpc(method, { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { extensions: { [tasksExtension]: {} } },
    } });
    assert.equal(error, undefined, JSON.stringify(error));
    return result;
  };
}
export const taskCall = (rpc, name, args) => rpc('tools/call', { name, arguments: args });
export const taskJob = (f, task) => {
  assert.equal(task.resultType, 'task');
  assert.equal(task.status, 'working');
  const job = task.taskId.split(':')[0];
  assert.match(job, /^j[0-9a-f]{16}$/);
  return { job, task_dir: join(f.env.HUD_HOME, 'jobs', job) };
};

export function runSonic(f, action, dir, ...args) {
  return new Promise((done) => execFile(process.execPath,
    [resolve('packages/hud-mcp/bin/hud-sonic.mjs'), action, '--dir', dir, ...args],
    { cwd: f.root, env: { ...f.env, HUD_JOB_DIR: dir, HERDR_PANE_ID: 'w4E:p9' } },
    (error, stdout, stderr) => done({ status: error?.code ?? 0, stdout, stderr })
  ));
}
export function sonicTask(f) {
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'sonic.json'), JSON.stringify({
    role: 'sonic', instructions: 'sonic', can_continue: false, run: [{
      harness: 'pi', pi_role: 'sonic', model: 'synthetic/sonic', thinking: 'high',
    }],
  }));
  const task = join(f.root, 'sonic-task.md');
  fs.writeFileSync(task, '# Synthetic sonic sub-task\n\nSummarize the synthetic fixture.');
  return task;
}
export function publishSonic(dir, status) {
  const tmp = join(dir, 'test-status.tmp');
  fs.writeFileSync(tmp, JSON.stringify(status));
  fs.renameSync(tmp, join(dir, 'STATUS.json'));
}

export function fakeCliWithChild(t, f) {
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

export const statusQueries = (f, job) => f.socketRequests.filter((r) =>
  r.method === 'agent.get' && r.params.target === `${job.job}-primary`).length;

export const readCloseQuit = (f, job) => f.commands().some((c) =>
  c.command === 'herdr' && c.args[1] === 'prompt' && c.args[2] === job.agent && c.args[3] === '/quit');
export const readCloseReaped = (job) => JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json'), 'utf8')).reaped_at;
export const reapAttempts = (f, job) => f.commands().filter((c) => c.command === 'pi-role-reap' && c.args[0] === job.task_dir).length;
const progressCommand = resolve('packages/hud-mcp/bin/hud-progress.mjs');
export const cliToken = (dir) => turnToken(JSON.parse(fs.readFileSync(join(dir, 'turn.json'), 'utf8')));
export const runProgress = (f, dir, ...args) => spawnSync(process.execPath, [progressCommand, ...args], {
  env: { ...f.env, HUD_JOB_DIR: dir }, encoding: 'utf8',
});
export function declareDone(f, job, cli = true) {
  const dir = job.task_dir;
  const result = runProgress(f, dir, '--done', ...(cli ? ['--turn', cliToken(dir)] : []));
  assert.equal(result.status, 0, result.stderr);
}

export async function publishPiGrace(job, worker, writeReport = true) {
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

export const fallbackPlaces = [
  { harness: 'cli', agent: 'grok', model: 'synthetic-first' },
  { harness: 'pi', pi_role: 'implementer', model: 'synthetic/second' },
];
export function fallbackRole(f, role, run = fallbackPlaces, presets) {
  const root = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(join(root, `${role}.json`), JSON.stringify({ role, instructions: 'implementer', can_continue: false, run, presets }));
}

export function waitFixtureJob(f, n, state = 'working', herdr_pane = 'w4E:p1', cwd = f.root) {
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

export const ownerOf = ({ dir }) => JSON.parse(fs.readFileSync(join(dir, 'job.json'))).herdr_pane;
export const paneList = (f, ...ids) => fs.writeFileSync(join(f.env.HOME, 'pane-list.json'), JSON.stringify({
  result: { panes: ids.map((pane_id) => ({ pane_id })) },
}));

export const progressRecord = (text) => ({ at: '2026-11-18T12:00:00.000Z', text });
export const jsonLines = (rows) => rows.map((row) => JSON.stringify(row) + '\n').join('');

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
export function assertCliStatus(status, dir) {
  for (const key of cliStatusKeys) assert.equal(Object.hasOwn(status, key), true, key);
  assert.equal(Object.hasOwn(status, 'session_id'), false);
  assert.equal(status.version, 1);
  assert.equal(status.slot, 'primary');
  assert.equal(status.harness, 'cli');
  assert.equal(status.agent, 'grok');
  assert.equal(status.task_dir, fs.realpathSync(dir));
}

export function writeCliRole(f, role, idle_grace_s = 1, can_continue = true, agent = 'grok') {
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', `${role}.json`),
    JSON.stringify({ role, harness: 'cli', agent, ...(agent === 'grok' ? { model: 'grok-4.7' } : {}), thinking: 'high', can_continue, idle_grace_s: idle_grace_s * 20 })
  );
}

export function cliState(dir) {
  const file = join(dir, 'STATUS.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export function graceArmed(env, dir) {
  const seen = join(env.HOME, 'seen-grace.json');
  return (
    cliState(dir)?.state === 'idle_grace' &&
    fs.existsSync(seen) &&
    fs.readFileSync(seen, 'utf8').includes(dir.split('/').at(-1))
  );
}

export async function fakeDecisionServer(t, handler) {
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

export function decisionAnswer(choice, probability, rest = 0.02) {
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

export function configureFakeDecision(f, baseUrl, cap = 0) {
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
