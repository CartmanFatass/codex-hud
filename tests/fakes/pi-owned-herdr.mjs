#!/usr/bin/env node
/** Stateful subprocess fake for owned orchestration. No receipts or final dispatch state are fabricated.
 * A private socket server owns terminal inventory and synthetic worker OS processes.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import { fork } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (args[0] !== '--server') {
  const socket = net.createConnection(process.env.HERDR_SOCKET_PATH);
  let buffer = '';
  socket.on('connect', () => socket.write(JSON.stringify({ argv: args, cliPid: process.pid }) + '\n'));
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.includes('\n')) {
      const reply = JSON.parse(buffer.split('\n')[0]);
      process.stdout.write(reply.stdout ?? '');
      process.stderr.write(reply.stderr ?? '');
      process.exitCode = reply.exit ?? 0;
      socket.destroy();
    }
  });
  socket.on('error', () => {
    process.exitCode = 1;
    socket.destroy();
  });
} else {
  const [, socketPath, root, directory, integration] = args;
  const statePath = join(root, 'herdr-state.json');
  const logPath = join(root, 'herdr-calls.jsonl');
  const workers = new Map();
  const load = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const save = (state) => {
    fs.writeFileSync(statePath + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(statePath + '.tmp', statePath);
  };
  const journal = (slot) => JSON.parse(fs.readFileSync(join(directory, '.dispatch', slot, 'launch.json'), 'utf8'));
  const json = (value) => ({ stdout: JSON.stringify({ result: value }) + '\n', exit: 0 });
  const noReply = () => ({ stdout: '', exit: 1 });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const perform = async (argv, cliPid) => {
    let state = load();
    const command = argv.slice(0, 2).join(' ');
    const option = (flag) => argv[argv.indexOf(flag) + 1];
    let step;
    let j;
    if (command === 'tab create') {
      step = 'tab';
      j = journal('primary');
    }
    if (command === 'pane split') {
      j = journal('primary');
      step = Object.keys(j.steps).find(
        (k) => (k === 'split' || k.startsWith('helper_split_')) && j.steps[k].state === 'sent'
      );
    }
    if (command === 'agent start') {
      const c = JSON.parse(fs.readFileSync(option('--hud-role-contract'), 'utf8'));
      j = journal(c.slot);
      step = 'start';
    }
    if (command === 'agent prompt' && argv[3] !== '/quit') {
      const a = state.agents.find((a) => a.name === argv[2]);
      j = a && journal(a.slot);
      step = 'prompt';
    }
    if (command === 'pane send-keys') {
      const a = state.agents.find((a) => a.pane_id === argv[2]);
      j = a && journal(a.slot);
      step = 'enter';
    }
    const mutating = !!step || command === 'tab close' || (command === 'agent prompt' && argv[3] === '/quit');
    const transaction =
      ['receipt.json'].every((name) => fs.existsSync(join(directory, name))) &&
      fs.existsSync(join(root, 'home/assoc', 'j0123456789abcdef.json')) &&
      fs.existsSync(join(root, 'home/jobs/index/key.json'));
    const intent = step ? j?.steps[step]?.state === 'sent' : true;
    fs.appendFileSync(logPath, JSON.stringify({ argv, step, intent, transaction, transport_pid: cliPid }) + '\n', {
      mode: 0o600,
    });
    if (mutating && (!intent || !transaction)) return { exit: 1, stderr: 'intent_missing' };
    const faultKey = step ?? (command === 'tab close' ? 'close' : '');
    state.counts[faultKey || command] = (state.counts[faultKey || command] ?? 0) + 1;
    save(state);
    if (state.mode.delay) await pause(state.mode.delay);
    if (state.mode.fault === `${faultKey}:before`) return noReply();
    let reply;
    if (command === 'integration status')
      return { stdout: `pi: ${state.mode.integration ?? 'current'} (v9) (${integration})\n`, exit: 0 };
    if (command === 'tab create') {
      const tab = { tab_id: `tab${++state.n}`, label: option('--label') };
      const pane = { pane_id: `pane${++state.n}`, tab_id: tab.tab_id, terminal_id: `terminal${state.n}` };
      state.tabs.push(tab);
      state.panes.push(pane);
      save(state);
      reply = json({ tab, root_pane: pane });
    } else if (command === 'pane split') {
      const left = state.panes.find((p) => p.pane_id === argv[2]);
      if (!left) return noReply();
      const pane = { pane_id: `pane${++state.n}`, tab_id: left.tab_id, terminal_id: `terminal${state.n}` };
      state.panes.push(pane);
      save(state);
      reply = json({ pane });
    } else if (command === 'agent start') {
      const contractPath = option('--hud-role-contract');
      const c = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
      const pane = state.panes.find((p) => p.pane_id === option('--pane'));
      if (!pane || state.agents.some((a) => a.pane_id === pane.pane_id)) return noReply();
      const child = fork(
        join(dirname(fileURLToPath(import.meta.url)), 'pi-owned-worker.mjs'),
        argv.slice(argv.indexOf('--') + 1).filter((_, n, a) => n >= a.indexOf('--hud-role-contract')),
        {
          env: process.env,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        }
      );
      workers.set(argv[2], child);
      const ready = await new Promise((resolve) => {
        child.once('message', resolve);
        child.once('exit', () => resolve(null));
      });
      if (!ready) return noReply();
      state = load();
      const agent = {
        name: argv[2],
        pane_id: pane.pane_id,
        tab_id: pane.tab_id,
        agent: 'pi',
        agent_status: 'idle',
        slot: c.slot,
        agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: ready.session },
      };
      state.agents.push(agent);
      save(state);
      if (state.mode.startup === 'missing') fs.unlinkSync(join(dirname(contractPath), 'owner.json'));
      if (state.mode.startup === 'mismatch') {
        const file = join(dirname(contractPath), 'owner.json');
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        owner.model = 'foreign/model';
        fs.writeFileSync(file, JSON.stringify(owner), { mode: 0o600 });
      }
      child.on('message', (message) => {
        if (message.type === 'idle') {
          const s = load();
          const a = s.agents.find((a) => a.name === argv[2]);
          if (a) a.agent_status = 'idle';
          save(s);
        }
      });
      child.once('exit', () => {
        const s = load();
        s.agents = s.agents.filter((a) => a.name !== argv[2]);
        save(s);
        workers.delete(argv[2]);
      });
      reply = json({ agent });
    } else if (command === 'agent prompt' || command === 'pane send-keys') {
      const agent = state.agents.find((a) => (command === 'agent prompt' ? a.name === argv[2] : a.pane_id === argv[2]));
      if (!agent) return noReply();
      const worker = workers.get(agent.name);
      if (argv[3] === '/quit') {
        if (!state.mode.ignoreQuit) worker?.send({ type: 'quit' });
        reply = json({ agent });
      } else {
        const text = command === 'agent prompt' ? argv[3] : state.editor;
        state.editor = text;
        const stalled = command === 'agent prompt' && state.mode.stall;
        const persist = !stalled || state.mode.stall === 'persisted';
        agent.agent_status = stalled && state.mode.stall !== 'working' ? 'idle' : 'working';
        save(state);
        if (state.mode.stall === 'bad-session') fs.appendFileSync(agent.agent_session.value, '{unreadable\n');
        if (persist) {
          worker?.send({
            type: 'prompt',
            text,
            finish: (agent.slot !== 'primary' || state.mode.primaryFinish) && !stalled,
            mode: state.mode.helper,
          });
          await pause(15);
        }
        reply = stalled
          ? { stdout: JSON.stringify({ error: { code: 'agent_prompt_stalled' } }), exit: 1 }
          : json({ agent });
      }
    } else if (command === 'pane get') {
      const pane = state.panes.find((p) => p.pane_id === argv[2]);
      reply = pane ? json({ pane }) : noReply();
    } else if (command === 'pane read') {
      if (state.mode.stall === 'unreadable') reply = { stdout: 'x'.repeat(130 * 1024), exit: 0 };
      else
        reply = {
          stdout: `Earlier transcript\n────────────────────\n${(state.mode.stall === 'wrong-editor' ? 'wrong prompt' : state.mode.stall === 'whitespace-altered' ? (state.editor ?? '').replace(' and do', ' anddo') : (state.editor ?? '')).match(/.{1,37}/g)?.join('\n') ?? ''}\n────────────────────\nmodel footer\n`,
          exit: 0,
        };
    } else if (command === 'agent get' || command === 'agent wait') {
      const agent = state.agents.find((a) => a.name === argv[2]);
      reply = agent ? json({ agent }) : noReply();
    } else if (command === 'tab list')
      reply = state.mode.unknown === 'tabs' ? json({ tabs: null }) : json({ tabs: state.tabs });
    else if (command === 'pane list')
      reply = state.mode.unknown === 'panes' ? json({ panes: null }) : json({ panes: state.panes });
    else if (command === 'agent list')
      reply = state.mode.unknown === 'agents' ? json({ agents: null }) : json({ agents: state.agents });
    else if (command === 'tab close') {
      if (state.agents.some((a) => a.tab_id === argv[2])) return { exit: 1, stderr: 'tab_occupied' };
      state.tabs = state.tabs.filter((t) => t.tab_id !== argv[2]);
      state.panes = state.panes.filter((p) => p.tab_id !== argv[2]);
      save(state);
      reply = json({ closed: true });
    } else reply = { exit: 1, stderr: `unhandled ${command}` };
    if (state.mode.fault === `${faultKey}:after`) return noReply();
    return reply;
  };
  const server = net.createServer((socket) => {
    let text = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) {
        const { argv, cliPid } = JSON.parse(text.split('\n')[0]);
        perform(argv, cliPid).then(
          (result) => socket.end(JSON.stringify(result) + '\n'),
          (error) => socket.end(JSON.stringify({ exit: 1, stderr: error.stack }) + '\n')
        );
      }
    });
  });
  const stop = () => {
    for (const child of workers.values()) child.kill('SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  server.listen(socketPath, () => process.send?.({ ready: true }));
}
