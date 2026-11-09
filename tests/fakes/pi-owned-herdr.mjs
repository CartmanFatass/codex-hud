#!/usr/bin/env node
/**
 * Stateful subprocess transport for pi-owned orchestration tests. This models
 * herdr resources and user-message submission; it never writes owner evidence,
 * STATUS, or model output. Tests may edit the state to insert foreign resources.
 *
 * HERDR_FAKE_STATE: JSON {instance,tabs,panes,agents,n}; HERDR_FAKE_LOG: JSONL argv
 * and pre-effect evidence; HERDR_FAKE_JOB: canonical task directory J.
 * HERDR_FAKE_INTEGRATION: synthetic current-v9 integration file.
 * HERDR_FAKE_MODE: ok | hang | prompt-stalled | <step>-before | <step>-after,
 * where step is tab/split/start/prompt/enter. Before exits without an effect;
 * after persists the effect but drops the reply. Enter modes also stall prompt.
 * HERDR_FAKE_DELAY_MS delays every mutation before its effect.
 * HERDR_FAKE_WORKER optionally starts an independent Node fixture with arguments
 * [contractPath, JSON.stringify(agent)]. Only that worker can produce results.
 * Agent session identity follows herdr 0.9.5's agent_session path reference;
 * integration status and pane read return observed plain-text response shapes.
 * Tab creation and split envelopes remain synthetic pending live rehearsal.
 */
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const command = argv.slice(0, 2).join(' ');
const mode = process.env.HERDR_FAKE_MODE || 'ok';
const statePath = process.env.HERDR_FAKE_STATE;
const job = process.env.HERDR_FAKE_JOB;
const id = `cli:${argv.slice(0, 2).join(':')}`;

function pause(ms) {
  if (Number.isFinite(ms) && ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function option(name, after = 0) {
  const index = argv.indexOf(`--${name}`, after);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadState() {
  const state = statePath ? readJson(statePath) : null;
  if (state === null) {
    if (statePath && fs.existsSync(statePath)) fail('invalid_fake_state');
    return { instance: 'synthetic-instance', tabs: [], panes: [], agents: [], n: 0 };
  }
  if (!Array.isArray(state.tabs) || !Array.isArray(state.panes) || !Array.isArray(state.agents))
    fail('invalid_fake_state');
  return state;
}

function saveState(state) {
  if (!statePath) fail('missing_fake_state');
  fs.mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

function reply(result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function fail(code) {
  process.stdout.write(`${JSON.stringify({ id, error: { code } })}\n`);
  process.exit(1);
}

function record(extra = {}) {
  const log = process.env.HERDR_FAKE_LOG;
  if (log) fs.appendFileSync(log, `${JSON.stringify({ argv, ...extra })}\n`, { mode: 0o600 });
}

function directories(path) {
  try {
    return fs.readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
}

function contractFile() {
  const separator = argv.indexOf('--');
  return separator < 0 ? null : option('hud-role-contract', separator + 1);
}

function findAgent(state, target = argv[2]) {
  return state.agents.find((agent) => agent.name === target || agent.pane_id === target);
}

function sessionFile(agent) {
  return agent?.agent_session?.kind === 'path' ? agent.agent_session.value : null;
}

function journals(step, state) {
  if (!job) return [];
  const agent = findAgent(state);
  const contract = contractFile();
  const slot = contract ? basename(dirname(contract)) : null;
  let entries = directories(join(job, '.dispatch')).map((entry) => {
    const directory = join(job, '.dispatch', entry.name);
    return {
      slot: entry.name,
      path: join(directory, 'launch.json'),
      launch: readJson(join(directory, 'launch.json')),
      contract: readJson(join(directory, 'contract.json')),
    };
  });
  if (slot) entries = entries.filter((entry) => entry.slot === slot);
  else if (sessionFile(agent))
    entries = entries.filter(
      (entry) =>
        entry.contract?.session_id && join(job, 'sessions', `${entry.contract.session_id}.jsonl`) === sessionFile(agent)
    );
  return entries.map((entry) => ({
    slot: entry.slot,
    path: entry.path,
    state: entry.launch?.steps?.[step]?.state ?? null,
  }));
}

function hasJobIndex(home) {
  // Facade indexes may be nested by source/root. Check only the synthetic HUD
  // home's index directory, and require this job in a parsed index record.
  if (!home || !job) return false;
  const pending = [join(home, 'jobs', 'index')];
  let remaining = 1000;
  while (pending.length && remaining-- > 0) {
    const path = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && readJson(file)?.job === basename(job)) return true;
    }
  }
  return false;
}

function evidence(step, state) {
  const home = job ? dirname(dirname(job)) : null;
  const intents = journals(step, state);
  const cleanup = job ? readJson(join(job, '.dispatch', 'cleanup.json')) : null;
  const intent =
    step === 'quit'
      ? intents.some((entry) => cleanup?.steps?.[`quit-${entry.slot}`]?.state === 'sent')
      : step === 'close'
        ? cleanup?.steps?.close?.state === 'sent'
        : null;
  return {
    step,
    intent_before: intent ?? intents.some((entry) => entry.state === 'sent'),
    intents,
    receipt_before: Boolean(job && fs.existsSync(join(job, 'receipt.json'))),
    index_before: hasJobIndex(home),
    association_before: Boolean(home && fs.existsSync(join(home, 'assoc', `${basename(job)}.json`))),
  };
}

function mutate(step, effect) {
  const before = loadState();
  record(evidence(step, before));
  if (mode === 'hang') {
    pause(20_000);
    process.exit(0);
  }
  pause(Number(process.env.HERDR_FAKE_DELAY_MS || 0));
  if (mode === `${step}-before`) process.exit(0);
  const state = loadState();
  const result = effect(state);
  saveState(state);
  if (mode === `${step}-after`) process.exit(0);
  reply(result);
}

function appendUser(agent, prompt) {
  fs.appendFileSync(
    sessionFile(agent),
    `${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`,
    { mode: 0o600 }
  );
}

const mutations = ['tab create', 'pane split', 'agent start', 'agent prompt', 'pane send-keys', 'tab close'];
if (!mutations.includes(command)) {
  record();
  if (mode === 'hang') {
    pause(20_000);
    process.exit(0);
  }
}

if (command === 'integration status') {
  process.stdout.write(`pi: current (v9) (${process.env.HERDR_FAKE_INTEGRATION || ''})\n`);
} else if (command === 'tab create') {
  mutate('tab', (state) => {
    const n = ++state.n;
    const tab = { tab_id: `tab${n}`, label: option('label') };
    const pane = { pane_id: `pane${n}`, tab_id: tab.tab_id };
    state.tabs.push(tab);
    state.panes.push(pane);
    return { tab, root_pane: pane };
  });
} else if (command === 'pane split') {
  mutate('split', (state) => {
    const original = state.panes.find((pane) => pane.pane_id === argv[2]);
    if (!original) fail('pane_not_found');
    const pane = { pane_id: `pane${++state.n}`, tab_id: original.tab_id };
    state.panes.push(pane);
    return { pane };
  });
} else if (command === 'agent start') {
  mutate('start', (state) => {
    const file = contractFile();
    const contract = file ? readJson(file) : null;
    const pane = state.panes.find((item) => item.pane_id === option('pane'));
    if (!contract || !job || resolve(contract.task_dir) !== resolve(job)) fail('invalid_role_contract');
    if (!pane) fail('pane_not_found');
    if (state.agents.some((agent) => agent.name === argv[2] || agent.pane_id === pane.pane_id)) fail('agent_exists');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(contract.session_id)) fail('invalid_session_id');
    const agent = {
      name: argv[2],
      agent: 'pi',
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      agent_status: 'idle',
      agent_session: {
        agent: 'pi',
        kind: 'path',
        source: 'herdr:pi',
        value: join(job, 'sessions', `${contract.session_id}.jsonl`),
      },
    };
    fs.mkdirSync(join(job, 'sessions'), { recursive: true, mode: 0o700 });
    fs.chmodSync(join(job, 'sessions'), 0o700);
    fs.writeFileSync(sessionFile(agent), '', { flag: 'wx', mode: 0o600 });
    const worker = process.env.HERDR_FAKE_WORKER;
    if (worker) {
      const child = spawn(process.execPath, [worker, file, JSON.stringify(agent)], {
        stdio: 'ignore',
        env: process.env,
        detached: true,
      });
      child.on('error', () => {});
      agent.pid = child.pid;
      child.unref();
    }
    state.agents.push(agent);
    return { agent };
  });
} else if (command === 'agent prompt') {
  const prompt = argv[3] || '';
  mutate(prompt === '/quit' ? 'quit' : 'prompt', (state) => {
    const agent = findAgent(state);
    if (!agent) fail('agent_not_found');
    if (prompt === '/quit') {
      state.agents = state.agents.filter((item) => item !== agent);
      return { agent };
    }
    if (mode.startsWith('stall-') || mode === 'prompt-stalled' || mode === 'enter-before' || mode === 'enter-after') {
      agent.editor = mode === 'stall-editor-mismatch' ? prompt + ' changed' : prompt;
      agent.agent_status = mode === 'stall-busy' ? 'working' : 'idle';
      if (mode === 'stall-message') appendUser(agent, prompt);
      if (mode === 'stall-unreadable') fs.appendFileSync(sessionFile(agent), '{broken\n');
      saveState(state);
      fail('agent_prompt_stalled');
    }
    appendUser(agent, prompt);
    agent.agent_status = 'working';
    return { agent };
  });
} else if (command === 'pane send-keys') {
  mutate('enter', (state) => {
    const agent = findAgent(state);
    if (!agent || argv[3] !== 'Enter') fail('invalid_enter');
    if (typeof agent.editor !== 'string' || !agent.editor) fail('editor_empty');
    appendUser(agent, agent.editor);
    agent.editor = '';
    agent.agent_status = 'working';
    return { sent: true };
  });
} else if (command === 'pane read') {
  const agent = findAgent(loadState());
  if (!agent) fail('agent_not_found');
  const rule = '─'.repeat(80);
  process.stdout.write(`${rule}\n${agent.editor ?? ''}\n${rule}\nsynthetic-model • high\n`);
} else if (command === 'agent get' || command === 'agent wait') {
  const agent = findAgent(loadState());
  if (!agent) fail('agent_not_found');
  reply({ agent });
} else if (command === 'agent list') {
  reply({ agents: loadState().agents });
} else if (command === 'pane list') {
  const tab = option('tab');
  reply({ panes: loadState().panes.filter((pane) => !tab || pane.tab_id === tab) });
} else if (command === 'tab list') {
  const barrier = process.env.HERDR_FAKE_BARRIER;
  if (barrier && fs.existsSync(barrier + '.arm')) {
    fs.writeFileSync(barrier + '.reached', 'ready', { mode: 0o600 });
    const end = Date.now() + 5000;
    while (!fs.existsSync(barrier + '.release') && Date.now() < end) pause(5);
  }
  reply({ tabs: loadState().tabs });
} else if (command === 'tab get') {
  const tab = loadState().tabs.find((item) => item.tab_id === argv[2]);
  if (!tab) fail('tab_not_found');
  reply({ tab });
} else if (command === 'tab close') {
  mutate('close', (state) => {
    const tab = state.tabs.find((item) => item.tab_id === argv[2]);
    if (!tab) fail('tab_not_found');
    const panes = state.panes.filter((pane) => pane.tab_id === tab.tab_id);
    if (
      state.agents.some((agent) => agent.tab_id === tab.tab_id || panes.some((pane) => pane.pane_id === agent.pane_id))
    )
      fail('tab_occupied');
    state.tabs = state.tabs.filter((item) => item !== tab);
    state.panes = state.panes.filter((pane) => pane.tab_id !== tab.tab_id);
    return { closed: true };
  });
} else {
  fail('unhandled_fake_command');
}
