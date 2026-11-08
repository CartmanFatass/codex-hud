#!/usr/bin/env node
/**
 * Fake herdr for role-facade tests. It records argv and prints canned JSON
 * in the live envelope shape. It does not start a terminal, a pane, or an agent.
 *
 * HERDR_FAKE_LOG   append-only JSON lines: { argv, receipt_before? }
 * HERDR_FAKE_STATE path of this process's tab/agent table
 * HERDR_FAKE_MODE  ok | lose-create | lose-create-keep | hang | fail-prompt | fail-start | close-missing
 *                  | list-fail | close-unreadable | two-panes | dup-label
 * HERDR_FAKE_DELAY_MS  pause inside `tab create` so same-key calls overlap
 * HERDR_FAKE_ASSERT_HOME  HUD_HOME; `tab create` records whether a receipt exists
 * HERDR_FAKE_STATUS  agent_status returned by get/wait/prompt (default idle)
 * HERDR_FAKE_WAIT_SLEEP=timeout  `agent wait` sleeps for its --timeout
 * HERDR_FAKE_QA  directory where that wait writes q1.md before sleeping
 */

import * as fs from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const mode = process.env.HERDR_FAKE_MODE || 'ok';
const statePath = process.env.HERDR_FAKE_STATE || '';

function pause(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function record(extra = {}) {
  const log = process.env.HERDR_FAKE_LOG;
  if (!log) return;
  fs.appendFileSync(log, `${JSON.stringify({ argv, ...extra })}\n`);
}

function option(name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= argv.length) return null;
  return argv[index + 1];
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && Array.isArray(parsed.tabs) && Array.isArray(parsed.agents)) return parsed;
  } catch {
    /* First call in this home. */
  }
  return { n: 0, tabs: [], agents: [] };
}

function saveState(state) {
  if (!statePath) return;
  fs.mkdirSync(join(statePath, '..'), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, statePath);
}

function receiptReady(home) {
  let names;
  try {
    names = fs.readdirSync(join(home, 'jobs'));
  } catch {
    return false;
  }
  return names.some((name) => /^j[a-f0-9]{16}$/.test(name) && fs.existsSync(join(home, 'jobs', name, 'receipt.json')));
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function unnamed() {
  return { agent_status: 'working', pane_id: 'w0:p0', tab_id: 'w0:t0', workspace_id: 'w0', cwd: '/tmp/synthetic' };
}

record(
  argv[0] === 'tab' && argv[1] === 'create'
    ? { receipt_before: process.env.HERDR_FAKE_ASSERT_HOME ? receiptReady(process.env.HERDR_FAKE_ASSERT_HOME) : null }
    : {}
);

if (mode === 'hang') {
  pause(20000);
  process.exit(0);
}

const command = `${argv[0] || ''} ${argv[1] || ''}`;
const hidden = mode === 'close-missing';

if (command === 'tab create') {
  pause(Number(process.env.HERDR_FAKE_DELAY_MS || 0));
  if (mode === 'lose-create') process.exit(0);
  const state = loadState();
  state.n += 1;
  const tab = {
    label: option('label'),
    tab_id: `tab${state.n}`,
    pane_id: `pane${state.n}`,
    workspace_id: option('workspace'),
    launched: false,
  };
  state.tabs.push(tab);
  state.pending = { tabId: tab.tab_id, paneId: tab.pane_id };
  saveState(state);
  if (mode === 'lose-create-keep') process.exit(0);
  reply('cli:tab:create', { tab: { tab_id: tab.tab_id, label: tab.label }, root_pane: { pane_id: tab.pane_id } });
  process.exit(0);
}

if (command === 'tab list') {
  if (mode === 'list-fail' || mode === 'close-unreadable') {
    process.stderr.write('tab_list_failed\n');
    process.exit(1);
  }
  let tabs = hidden
    ? []
    : loadState().tabs.map((tab) => ({
        label: tab.label,
        tab_id: tab.tab_id,
        workspace_id: tab.workspace_id,
        agent_status: 'idle',
        focused: false,
        pane_count: mode === 'two-panes' ? 2 : 1,
      }));
  if (mode === 'dup-label') tabs = tabs.flatMap((tab) => [tab, { ...tab, tab_id: `${tab.tab_id}-b` }]);
  reply('cli:tab:list', { tabs, type: 'tab_list' });
  process.exit(0);
}

if (command === 'tab get') {
  if (hidden) process.exit(1);
  const tab = loadState().tabs.find((item) => item.tab_id === argv[2]);
  if (!tab) process.exit(1);
  reply('cli:tab:get', {
    tab: { label: tab.label, tab_id: tab.tab_id, workspace_id: tab.workspace_id },
    type: 'tab_info',
  });
  process.exit(0);
}

if (command === 'pane list') {
  const stored = hidden ? [] : loadState().tabs.map((tab) => ({ pane_id: tab.pane_id, tab_id: tab.tab_id }));
  const panes =
    mode === 'two-panes'
      ? stored.flatMap((pane) => [pane, { pane_id: `${pane.pane_id}-b`, tab_id: pane.tab_id }])
      : stored;
  reply('cli:pane:list', { panes, type: 'pane_list' });
  process.exit(0);
}

if (command === 'pane run') {
  const state = loadState();
  const tab = state.tabs.find((item) => item.pane_id === argv[2]);
  if (tab) tab.launched = true;
  saveState(state);
  reply('cli:pane:run', { ok: true });
  process.exit(0);
}

if (command === 'agent start') {
  if (mode === 'fail-start') {
    process.stderr.write('agent_start_failed\n');
    process.exit(1);
  }
  const state = loadState();
  const pending = state.pending || { tabId: 'tab0', paneId: 'pane0' };
  state.agents.push({
    name: argv[2],
    tab_id: pending.tabId,
    pane_id: pending.paneId,
    agent_status: 'idle',
  });
  saveState(state);
  reply('cli:agent:start', { agent: { name: argv[2], agent_status: 'idle' } });
  process.exit(0);
}

if (command === 'agent rename') {
  const state = loadState();
  const tab = state.tabs.find((item) => item.pane_id === argv[2]);
  if (!tab?.launched) {
    process.stderr.write('agent_not_found\n');
    process.exit(1);
  }
  state.agents.push({
    name: argv[3],
    tab_id: tab.tab_id,
    pane_id: tab.pane_id,
    agent_status: 'idle',
  });
  saveState(state);
  reply('cli:agent:rename', { agent: { name: argv[3], agent_status: 'idle' } });
  process.exit(0);
}

if (command === 'agent list') {
  const stored = mode === 'lose-create' ? [] : loadState().agents;
  const agents = mode === 'lose-create' ? [] : [...stored, unnamed()];
  reply('cli:agent:list', { agents, type: 'agent_list' });
  process.exit(0);
}

if (command === 'agent prompt') {
  const text = argv[3] || '';
  if (mode === 'fail-prompt' && !text.startsWith('Read ') && text !== '/quit') {
    process.stderr.write('agent_blocked\n');
    process.exit(1);
  }
  reply('cli:agent:prompt', { agent: { name: argv[2], agent_status: process.env.HERDR_FAKE_STATUS || 'idle' } });
  process.exit(0);
}

if (command === 'agent wait') {
  if (process.env.HERDR_FAKE_WAIT_SLEEP === 'timeout') {
    const qa = process.env.HERDR_FAKE_QA;
    if (qa) {
      fs.mkdirSync(qa, { recursive: true });
      const question = join(qa, 'q1.md');
      if (!fs.existsSync(question)) fs.writeFileSync(question, 'Which file?\n');
    }
    const index = argv.indexOf('--timeout');
    const ms = index >= 0 ? Number(argv[index + 1]) : 0;
    pause(Number.isFinite(ms) ? ms : 0);
  }
  reply('cli:agent:wait', { agent: { name: argv[2], agent_status: process.env.HERDR_FAKE_STATUS || 'idle' } });
  process.exit(0);
}

if (command === 'agent get') {
  reply('cli:agent:get', { agent: { name: argv[2], agent_status: process.env.HERDR_FAKE_STATUS || 'idle' } });
  process.exit(0);
}

if (command === 'tab close') {
  if (hidden || mode === 'close-unreadable') {
    process.stderr.write('tab_not_found\n');
    process.exit(1);
  }
  const state = loadState();
  state.tabs = state.tabs.filter((tab) => tab.tab_id !== argv[2]);
  saveState(state);
  reply('cli:tab:close', { closed: true });
  process.exit(0);
}

process.stderr.write(`fake herdr: unhandled ${argv.join(' ')}\n`);
process.exit(1);
