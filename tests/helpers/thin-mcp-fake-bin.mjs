#!/usr/bin/env node
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { writeFixtureFile } from './thin-mcp-files.mjs';

// Most callers invoke a named symlink; the two pi launchers pass their names explicitly.
const [, invocation, ...args] = process.argv;
const name = basename(invocation);
const command = name === 'thin-mcp-fake-bin.mjs' ? args.shift() : name;
const routingOnly = process.env.FAKE_ROUTING_ONLY === '1';
if (command === 'pi') {
  const caps = join(process.env.HOME, 'pi-model-caps.json');
  if (!fs.existsSync(caps)) process.exit(1);
  const model = JSON.parse(fs.readFileSync(caps, 'utf8'))[args[args.indexOf('--model') + 1]];
  if (!model) process.exit(1);
  process.stdin.once('data', () => console.log(JSON.stringify({ id: 'hud-thinking', data: { model } })));
} else fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command, args }) + '\n');
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
  const pane = args[args.indexOf('--pane') + 1];
  const busyIdFile = join(process.env.HOME, 'busy-pane-id');
  const busyCountFile = join(process.env.HOME, 'busy-pane-count');
  const busyMatches = fs.existsSync(busyIdFile) && fs.readFileSync(busyIdFile, 'utf8').trim() === pane;
  let busyRemaining = 0;
  if (!busyMatches && fs.existsSync(busyCountFile)) {
    busyRemaining = Number(fs.readFileSync(busyCountFile, 'utf8').trim()) || 0;
    if (busyRemaining > 0) writeFixtureFile(busyCountFile, String(busyRemaining - 1));
  }
  if (busyMatches || busyRemaining > 0) {
    console.error(
      JSON.stringify({
        error: { code: 'agent_pane_busy', message: `agent target pane ${pane} is not an available shell` },
        id: 'cli:agent:start',
      })
    );
    process.exit(1);
  }
  if (args[args.indexOf('--kind') + 1] === 'grok' && fs.existsSync(join(process.env.HOME, 'hold-grok-start'))) {
    waitToReply();
    console.error('synthetic delayed start failed');
    process.exit(1);
  }
  if (fs.existsSync(join(process.env.HOME, 'start-not-ready'))) {
    console.log(
      JSON.stringify({
        error: {
          code: 'agent_not_ready',
          message: 'agent synthetic is blocked during startup and is not ready for prompts',
        },
      })
    );
    process.exit(1);
  }
  const kind = args[args.indexOf('--kind') + 1];
  const failure = ['fail-start-' + kind, 'fail-start']
    .map((name) => join(process.env.HOME, name))
    .find((file) => fs.existsSync(file));
  if (failure) {
    console.error(fs.readFileSync(failure, 'utf8') || 'synthetic start failed');
    process.exit(1);
  }
  const at = args.indexOf('--task-dir');
  if (!routingOnly && at >= 0) {
    const dir = args[at + 1];
    const holdPi = kind === 'pi' && fs.existsSync(join(process.env.HOME, 'hold-pi-start'));
    const stat = holdPi && fs.readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ');
    const identity = holdPi ? { version: 1, task_dir: dir, slot: 'primary', pid: process.pid, pid_start_time: stat[19] } : {};
    writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify({ ...identity, state: 'working', exit_reason: null }));
    if (!fs.existsSync(join(process.env.HOME, 'defer-pi-report')))
      writeFixtureFile(join(dir, 'report.md'), 'Synthetic implementation report.');
    // This stand-in for pi publishes working, then exits without a shutdown write.
    if (holdPi) waitToReply();
  }
  if (
    ['cli-exit', 'cli-unknown', 'cli-gone', 'grace-quiet-gone', 'blocked-quiet-gone', 'exit-after-done'].some((name) =>
      fs.existsSync(join(process.env.HOME, name))
    )
  ) {
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    writeFixtureFile(join(process.env.HOME, 'fake-agent-pid'), String(sleeper.pid));
  }
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'read' && !routingOnly) {
  const paneFile = join(process.env.HOME, 'pane-read');
  const dialog = join(process.env.HOME, 'trust-dialog');
  const text = fs.existsSync(paneFile)
    ? fs.readFileSync(paneFile, 'utf8')
    : fs.existsSync(dialog)
      ? (fs.readFileSync(dialog, 'utf8').trim() || 'Do you trust the contents of this directory?') + '\n'
      : 'synthetic grok ready\n';
  console.log(
    JSON.stringify({
      result: {
        type: 'pane_read',
        read: {
          text,
          pane_id: args[2],
          workspace_id: 'w4E',
          tab_id: 'w4E:t2',
          source: 'recent',
          format: 'text',
          revision: 1,
          truncated: false,
        },
      },
    })
  );
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'process-info') {
  if (fs.existsSync(join(process.env.HOME, 'no-pid'))) {
    console.log(
      JSON.stringify({
        result: {
          type: 'pane_process_info',
          process_info: { pane_id: args[args.indexOf('--pane') + 1], shell_pid: 1, foreground_processes: [] },
        },
      })
    );
    process.exit(0);
  }
  const pidFile = join(process.env.HOME, 'cli-pid');
  const fakePidFile = join(process.env.HOME, 'fake-agent-pid');
  const line = fs
    .readFileSync('/proc/self/status', 'utf8')
    .split('\n')
    .find((row) => row.startsWith('PPid:'));
  const ppid = fs.existsSync(pidFile)
    ? Number(fs.readFileSync(pidFile, 'utf8').trim())
    : fs.existsSync(fakePidFile)
      ? Number(fs.readFileSync(fakePidFile, 'utf8').trim())
      : Number(line.split(':')[1]);
  console.log(
    JSON.stringify({
      result: {
        type: 'pane_process_info',
        process_info: {
          pane_id: args[args.indexOf('--pane') + 1],
          shell_pid: 1,
          foreground_processes: [{ pid: ppid, name: routingOnly ? 'agy' : 'grok' }],
        },
      },
    })
  );
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'get') {
  const goneId = args[2].replace(/-primary$/, '');
  if (
    fs.existsSync(join(process.env.HOME, 'herdr-errors')) ||
    fs.existsSync(join(process.env.HOME, 'late-session-gone')) ||
    fs.existsSync(join(process.env.HUD_HOME, 'jobs', goneId, 'agent-gone')) ||
    ['cli-gone', 'cli-exit', 'cli-unknown'].some((name) => fs.existsSync(join(process.env.HOME, name)))
  ) {
    console.error('agent_not_found');
    process.exit(1);
  }
  let session = routingOnly
    ? { kind: 'id', value: 'synthetic-cli-session' }
    : { kind: 'id', value: 'synthetic-grok-session', source: 'synthetic', agent: 'grok' };
  const late = join(process.env.HOME, 'late-session');
  if (fs.existsSync(late)) {
    const n = Number(fs.readFileSync(late, 'utf8') || '0') + 1;
    writeFixtureFile(late, String(n));
    if (n === 1) session = null;
  }
  console.log(
    JSON.stringify({
      result: { type: 'agent_info', agent: { name: args[2], agent_status: 'working', agent_session: session } },
    })
  );
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'wait') {
  const until = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--until') until.push(args[i + 1]);
  const id = args[2].replace(/-primary$/, '');
  const dir = join(process.env.HUD_HOME, 'jobs', id);
  const home = process.env.HOME;
  const matched = (agent_status) =>
    console.log(
      JSON.stringify({
        result: {
          type: 'wait_matched',
          event: { event: 'pane_agent_status_changed', data: { agent_status, pane_id: 'w4E:p2', workspace_id: 'w4E' } },
        },
      })
    );
  if (routingOnly) {
    const done = until.includes('done') && until.includes('blocked');
    const report = join(dir, 'report.md');
    if (done && !fs.existsSync(report)) writeFixtureFile(report, 'Synthetic report.\n');
    matched(done ? 'done' : 'idle');
    process.exit(0);
  }
  const killFakeAgent = () => {
    const fakePidFile = join(home, 'fake-agent-pid');
    if (fs.existsSync(fakePidFile)) {
      const fpid = Number(fs.readFileSync(fakePidFile, 'utf8').trim());
      if (fpid > 0) {
        try {
          process.kill(fpid, 'SIGKILL');
        } catch {}
        const end = Date.now() + 200;
        while (Date.now() < end) {
          try {
            const st = fs.readFileSync('/proc/' + fpid + '/stat', 'utf8');
            if (
              st
                .slice(st.lastIndexOf(')') + 1)
                .trim()
                .startsWith('Z ')
            )
              break;
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
  const left = () =>
    fs.existsSync(join(dir, 'agent-gone')) ||
    fs.existsSync(join(dir, 'STATUS.json.stop-requested')) ||
    fs.existsSync(join(dir, 'STATUS.json.close-requested'));
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
    if (until.includes('blocked') && !released()) {
      matched('blocked');
      process.exit(0);
    }
    if (until.includes('working') && until.includes('done') && !until.includes('blocked')) {
      const blockedQuiet = join(home, 'blocked-quiet');
      if (
        fs.existsSync(blockedQuiet) &&
        (until.includes('idle') || until.includes('unknown')) &&
        !fs.existsSync(join(home, 'blocked-quiet-seen'))
      ) {
        fs.writeFileSync(join(home, 'blocked-quiet-seen'), '');
        if (fs.existsSync(join(home, 'blocked-quiet-gone'))) {
          fs.writeFileSync(join(dir, 'agent-gone'), '');
          killFakeAgent();
        }
        matched(fs.readFileSync(blockedQuiet, 'utf8').trim() || 'idle');
        process.exit(0);
      }
      const hit = poll(cap, () => (released() ? 'working' : left() ? 'idle' : null));
      if (hit === 'working') {
        matched('working');
        process.exit(0);
      }
      if (hit === 'idle') {
        matched('idle');
        process.exit(0);
      }
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
    if (fs.existsSync(join(home, 'exit-after-done'))) {
      fs.writeFileSync(join(dir, 'agent-gone'), '');
      killFakeAgent();
    }
    if (fs.existsSync(join(home, 'cli-exit'))) {
      killFakeAgent();
      matched('idle');
      process.exit(0);
    }
    if (fs.existsSync(join(home, 'cli-unknown'))) {
      killFakeAgent();
      matched('unknown');
      process.exit(0);
    }
    if (fs.existsSync(join(home, 'cli-gone'))) {
      killFakeAgent();
      console.error('agent_not_found');
      process.exit(1);
    }
    const hit = poll(cap, () => (left() ? 'idle' : fs.existsSync(join(home, 'wake-turn')) ? 'working' : null));
    if (hit === 'working') {
      matched('working');
      process.exit(0);
    }
    if (hit === 'idle') {
      matched('idle');
      process.exit(0);
    }
    console.error('timeout');
    process.exit(1);
  }
  if (
    args.includes('--timeout') &&
    until.includes('working') &&
    !until.includes('done') &&
    !until.includes('blocked')
  ) {
    const statusFile = join(dir, 'STATUS.json');
    if (fs.existsSync(statusFile)) writeFixtureFile(join(home, 'seen-grace.json'), fs.readFileSync(statusFile));
    const graceQuiet = join(home, 'grace-quiet');
    if (fs.existsSync(graceQuiet) && !fs.existsSync(join(home, 'grace-quiet-seen'))) {
      fs.writeFileSync(join(home, 'grace-quiet-seen'), '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      if (fs.existsSync(join(home, 'grace-quiet-gone'))) {
        fs.writeFileSync(join(dir, 'agent-gone'), '');
        killFakeAgent();
      }
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
    if (hit === 'working') {
      matched('working');
      process.exit(0);
    }
    if (hit === 'idle') {
      matched('idle');
      process.exit(0);
    }
    console.error('timeout');
    process.exit(1);
  }
  if (until.includes('done') && until.includes('blocked')) {
    const seenPrompt =
      fs.existsSync(process.env.FAKE_LOG) && fs.readFileSync(process.env.FAKE_LOG, 'utf8').includes('"agent","prompt"');
    if (fs.existsSync(join(home, 'startup-done')) && !seenPrompt) {
      matched('done');
      process.exit(0);
    }
    if (fs.existsSync(join(home, 'phantom-working')) && !fs.existsSync(join(home, 'phantom-settled'))) {
      matched('done');
      process.exit(0);
    }
    const quietHold = join(home, 'quiet-hold');
    if (fs.existsSync(quietHold) && (until.includes('idle') || until.includes('unknown'))) {
      matched(fs.readFileSync(quietHold, 'utf8').trim() || 'idle');
      process.exit(0);
    }
    if (fs.existsSync(join(home, 'cli-exit'))) {
      killFakeAgent();
      matched('idle');
      process.exit(0);
    }
    if (fs.existsSync(join(home, 'cli-unknown'))) {
      killFakeAgent();
      matched('unknown');
      process.exit(0);
    }
    if (fs.existsSync(join(home, 'cli-gone'))) {
      killFakeAgent();
      console.error('agent_not_found');
      process.exit(1);
    }
    if (fs.existsSync(join(home, 'report-while-working'))) {
      const stageFile = join(home, 'report-while-working-stage');
      const stage = fs.existsSync(stageFile) ? Number(fs.readFileSync(stageFile, 'utf8')) : 0;
      writeFixtureFile(stageFile, String(stage + 1));
      if (stage === 0) {
        writeFixtureFile(join(dir, 'report.md'), 'Synthetic mid-turn report.\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
        console.error('timeout');
        process.exit(1);
      }
      const hit = poll(cap, () => (left() ? 'idle' : fs.existsSync(join(home, 'release-done')) ? 'done' : null));
      if (hit === 'done') {
        matched('done');
        process.exit(0);
      }
      if (hit === 'idle') {
        matched('idle');
        process.exit(0);
      }
      console.error('timeout');
      process.exit(1);
    }
    if (fs.existsSync(join(home, 'hold-turn'))) {
      const hit = poll(cap, () => (left() ? 'idle' : fs.existsSync(join(home, 'release-turn')) ? 'done' : null));
      if (hit === 'idle') {
        matched('idle');
        process.exit(0);
      }
      if (hit !== 'done') {
        console.error('timeout');
        process.exit(1);
      }
    }
    if (!fs.existsSync(join(home, 'missing-report'))) {
      const countFile = join(home, 'done-count');
      const n = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1;
      writeFixtureFile(countFile, String(n));
      const report = join(dir, 'report.md');
      if (n > 1 && !fs.existsSync(join(home, 'unchanged-report')))
        writeFixtureFile(report, 'Synthetic grok report two.' + String.fromCharCode(10));
      else if (!fs.existsSync(report)) writeFixtureFile(report, 'Synthetic grok report.' + String.fromCharCode(10));
    }
    matched('done');
  } else if (until.includes('idle') || until.includes('unknown')) matched('idle');
} else if (
  command === 'herdr' &&
  args[0] === 'agent' &&
  args[1] === 'prompt' &&
  args[4] === '--wait' &&
  fs.existsSync(join(process.env.HOME, 'pi-quota-fail'))
) {
  console.error('HTTP 429 rate limit exceeded');
  process.exit(1);
} else if (
  command === 'herdr' &&
  args[0] === 'agent' &&
  args[1] === 'prompt' &&
  args[3] === '/quit' &&
  fs.existsSync(join(process.env.HOME, 'late-session'))
) {
  fs.writeFileSync(join(process.env.HOME, 'late-session-gone'), '');
} else if (
  command === 'herdr' &&
  args[0] === 'agent' &&
  args[1] === 'prompt' &&
  String(args[3]).startsWith('Write your report to ') &&
  fs.existsSync(join(process.env.HOME, 'write-on-report-prompt'))
) {
  const reportPath = String(args[3]).slice('Write your report to '.length).split(' now;')[0];
  writeFixtureFile(reportPath, 'Synthetic report after prompt.\n');
} else if (
  command === 'herdr' &&
  args[0] === 'agent' &&
  args[1] === 'prompt' &&
  String(args[3]).startsWith('Write your report to ') &&
  fs.existsSync(join(process.env.HOME, 'fail-report-prompt'))
) {
  console.error('synthetic report prompt failed');
  process.exit(1);
} else if (
  command === 'herdr' &&
  args[0] === 'agent' &&
  args[1] === 'prompt' &&
  args[3] === '/quit' &&
  fs.existsSync(join(process.env.HOME, 'reject-quit'))
) {
  console.error('agent_not_ready before input');
  process.exit(1);
} else if (
  command === 'herdr' &&
  args[0] === 'agent' &&
  args[1] === 'prompt' &&
  fs.existsSync(join(process.env.HOME, 'fast-ambiguous-prompt'))
) {
  const id = args[2].replace(/-primary$/, '');
  writeFixtureFile(join(process.env.HUD_HOME, 'jobs', id, 'report.md'), 'Synthetic fast report after input.\n');
  waitToReply();
  console.error('agent_prompt_stalled after submit');
  process.exit(1);
} else if (
  command === 'herdr' &&
  args[0] === 'agent' &&
  args[1] === 'prompt' &&
  fs.existsSync(join(process.env.HOME, 'stalled-prompt'))
) {
  console.error('agent_prompt_stalled after submit');
  process.exit(1);
} else if (
  command === 'herdr' &&
  args[0] === 'agent' &&
  args[1] === 'prompt' &&
  fs.existsSync(join(process.env.HOME, 'rejected-prompt'))
) {
  if (!args.includes('--wait')) waitToReply();
  console.error('agent_not_ready before input');
  process.exit(1);
} else if (
  command === 'herdr' &&
  args[0] === 'agent' &&
  args[1] === 'prompt' &&
  fs.existsSync(join(process.env.HOME, 'fail-prompt'))
) {
  console.error('synthetic prompt timeout');
  process.exit(1);
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'split' && !routingOnly) {
  if (fs.existsSync(join(process.env.HOME, 'fail-split'))) {
    console.error('synthetic split failed');
    process.exit(1);
  }
  console.log(JSON.stringify({ result: { pane: { pane_id: 'w4E:p3' } } }));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'list') {
  const file = join(process.env.HOME, 'pane-list.json');
  if (!fs.existsSync(file)) process.exit(1);
  console.log(fs.readFileSync(file, 'utf8'));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'get') {
  const agentFile = join(process.env.HOME, 'main-agent');
  const agent = fs.existsSync(agentFile) ? fs.readFileSync(agentFile, 'utf8') : 'claude';
  console.log(JSON.stringify({ result: { pane: { workspace_id: 'w4E', ...(routingOnly ? {} : { agent }) } } }));
} else if (command === 'herdr' && args[0] === 'tab' && args[1] === 'create') {
  const seqFile = join(process.env.HOME, 'tab-seq');
  let n = 2;
  if (fs.existsSync(seqFile)) {
    n = (Number(fs.readFileSync(seqFile, 'utf8').trim()) || 1) + 1;
    writeFixtureFile(seqFile, String(n));
  }
  console.log(JSON.stringify({ result: { tab: { tab_id: `w4E:t${n}` }, root_pane: { pane_id: `w4E:p${n}` } } }));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'run') {
  process.exit(spawnSync('/bin/sh', ['-c', args[3]], { stdio: 'inherit' }).status);
} else if (command === 'jev-ask' && args[0] === 'key') {
  if (fs.existsSync(join(process.env.HOME, 'bro-quota-fail'))) {
    console.error('quota exceeded for chatgpt');
    process.exit(1);
  }
  console.log(JSON.stringify({ key: 'synthetic-key' }));
} else if (command === 'jev-ask' && args[0] === 'wait') {
  writeFixtureFile(args[args.indexOf('--answer-file') + 1], 'Synthetic Jev answer.');
} else if (command === 'jev-aistudio') {
  writeFixtureFile(args[args.indexOf('--out') + 1], 'Synthetic Argon answer.');
} else if (command === 'jev-flow') {
  if (!routingOnly && args[args.indexOf('--kind') + 1] === 'video' && !args.includes('--confirm-credits'))
    process.exit(17);
  writeFixtureFile(join(args[args.indexOf('--out-dir') + 1], 'synthetic-media.mp4'), 'synthetic media');
} else if (command === 'pi-role-reap') {
  if (routingOnly) {
    console.log('Synthetic reap complete');
    process.exit(0);
  }
  const dir = args[0],
    fail = join(dir, 'fail-reap-once');
  if (fs.existsSync(fail)) {
    fs.unlinkSync(fail);
    process.exit(1);
  }
  if (fs.existsSync(join(dir, 'reap-worker'))) {
    try {
      process.kill(Number(fs.readFileSync(join(process.env.HOME, 'cli-pid'))), 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
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
