/** Owned profile hooks: journal admission and real synthetic OS workers only. */
import * as fs from 'node:fs';
import * as net from 'node:net';
import { fork } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHerdr, herdrState, jsonReply, refused, supportsCommand } from './herdr-model.mjs';
export function serveOwned(args) {
  const [socketPath, root, initialDirectory, integration] = args;
  let directory = initialDirectory;
  const facade = initialDirectory === '-';
  const statePath = join(root, 'herdr-state.json');
  const logPath = join(root, 'herdr-calls.jsonl');
  const workers = new Map();
  const load = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const save = (state) => {
    fs.writeFileSync(statePath + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(statePath + '.tmp', statePath);
  };
  const journal = (slot) => JSON.parse(fs.readFileSync(join(directory, '.dispatch', slot, 'launch.json'), 'utf8'));
  const json = jsonReply;
  const noReply = () => ({ stdout: '', exit: 1 });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const perform = async (argv, cliPid) => {
    let state = herdrState(load());
    const command = argv.slice(0, 2).join(' ');
    if (!supportsCommand('owned', command) && !['test probe', 'integration status'].includes(command))
      return refused('unsupported_command');
    const option = (flag) => argv[argv.indexOf(flag) + 1];
    if (facade) {
      const label =
        command === 'tab create'
          ? option('--label')
          : command === 'agent start' || command === 'agent prompt'
            ? argv[2]
            : state.tabs.find((t) => t.tab_id === state.panes.find((p) => p.pane_id === argv[2])?.tab_id)?.label;
      const job = /j[a-f0-9]{16}/.exec(label ?? '')?.[0];
      if (job) directory = join(root, 'home/jobs', job);
    }
    let step;
    let j;
    if (command === 'tab create') {
      step = 'tab';
      j = journal('primary');
    }
    if (command === 'pane split') {
      j = journal('primary');
      for (const slot of fs.readdirSync(join(directory, '.dispatch'))) {
        if (/^sonic-\d+$/.test(slot)) {
          const candidate = journal(slot);
          if (candidate.nested_pane && candidate.steps.split?.state === 'sent') {
            j = candidate;
            break;
          }
        }
      }
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
      step = facade && j?.steps.prompt?.state === 'acked' ? 'send' : 'prompt';
    }
    if (command === 'pane send-keys') {
      const a = state.agents.find((a) => a.pane_id === argv[2]);
      j = a && journal(a.slot);
      step = 'enter';
    }
    const mutating =
      !!step ||
      command === 'pane close' ||
      command === 'tab close' ||
      (command === 'agent prompt' && argv[3] === '/quit');
    const transaction =
      ['receipt.json'].every((name) => fs.existsSync(join(directory, name))) &&
      fs.existsSync(
        join(root, 'home/assoc', facade ? directory.split('/').at(-1) + '.json' : 'j0123456789abcdef.json')
      ) &&
      (facade
        ? fs
            .readdirSync(join(root, 'home/jobs/index'), { recursive: true })
            .some(
              (p) =>
                String(p).endsWith('.json') &&
                JSON.parse(fs.readFileSync(join(root, 'home/jobs/index', p), 'utf8')).job ===
                  directory.split('/').at(-1)
            )
        : fs.existsSync(join(root, 'home/jobs/index/key.json')));
    const intent =
      step === 'send'
        ? fs.existsSync(join(directory, 'messages')) &&
          fs.readdirSync(join(directory, 'messages')).some((name) => {
            const m = JSON.parse(fs.readFileSync(join(directory, 'messages', name), 'utf8'));
            return m.text === argv[3] && m.state === 'sending';
          })
        : step
          ? j?.steps[step]?.state === 'sent'
          : true;
    fs.appendFileSync(logPath, JSON.stringify({ argv, step, intent, transaction, transport_pid: cliPid }) + '\n', {
      mode: 0o600,
    });
    if (mutating && (!intent || !transaction)) return { exit: 1, stderr: 'intent_missing' };
    const faultKey = step ?? (command === 'tab close' ? 'close' : '');
    state.counts[faultKey || command] = (state.counts[faultKey || command] ?? 0) + 1;
    save(state);
    if (state.mode.delay) await pause(state.mode.delay);
    if (state.mode.fault === `${faultKey}:before`) return noReply();
    if (command === 'test probe') {
      if (!workers.has(argv[2])) return noReply();
      workers.get(argv[2]).send({ type: 'probe', ...JSON.parse(argv[3]) });
      return json({ sent: true });
    }
    if (command === 'integration status')
      return { stdout: `pi: ${state.mode.integration ?? 'current'} (v9) (${integration})\n`, exit: 0 };
    const model = createHerdr({
      profile: 'owned',
      state,
      save,
      hooks: {
        start: async (argv, pane) => {
          const contractPath = option('--hud-role-contract');
          const c = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
          const child = fork(
            join(
              dirname(fileURLToPath(import.meta.url)),
              String(state.mode.startup ?? '').startsWith('real-') || state.mode.startup === 'loader-failure'
                ? 'pi-owned-loader-worker.mjs'
                : 'pi-owned-worker.mjs'
            ),
            argv.slice(argv.indexOf('--') + 1).filter((_, n, a) => n >= a.indexOf('--hud-role-contract')),
            {
              env: { ...process.env, OWNED_STARTUP_MODE: state.mode.startup },
              stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            }
          );
          workers.set(argv[2], child);
          const ready = await new Promise((resolve) => {
            child.once('message', resolve);
            child.once('exit', () => resolve(null));
          });
          if (!ready) return null;
          Object.assign(state, herdrState(load()));
          const agent = {
            name: argv[2],
            pane_id: pane.pane_id,
            tab_id: pane.tab_id,
            agent: 'pi',
            agent_status: 'idle',
            slot: c.slot,
            agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: ready.session },
          };
          if (state.mode.startup === 'missing') fs.unlinkSync(join(dirname(contractPath), 'owner.json'));
          if (state.mode.startup === 'mismatch') {
            const file = join(dirname(contractPath), 'owner.json');
            const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
            owner.model = 'foreign/model';
            fs.writeFileSync(file, JSON.stringify(owner), { mode: 0o600 });
          }
          child.on('message', (message) => {
            if (message.type === 'orphan_fault') {
              const s = load();
              s.mode.unknown = 'agents';
              save(s);
              child.send({ type: 'orphan_fault_acked' });
            }
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
          return agent;
        },
        prompt: async (argv, agent) => {
          const worker = workers.get(agent.name);
          if (argv[3] === '/quit') {
            if (!state.mode.ignoreQuit) worker?.send({ type: 'quit' });
            return json({ agent });
          } else {
            const text = command === 'agent prompt' ? argv[3] : state.editor;
            state.editor = text;
            const stalled = command === 'agent prompt' && state.mode.stall;
            const persist =
              (!stalled || state.mode.stall === 'persisted') &&
              !(command === 'pane send-keys' && state.mode.noEnterPersist);
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
            return stalled
              ? { stdout: JSON.stringify({ error: { code: 'agent_prompt_stalled' } }), exit: 1 }
              : json({ agent: state.mode.promptAgentMismatch ? { ...agent, name: 'foreign' } : agent });
          }
        },
        read: () => {
          if (state.mode.stall === 'unreadable') return { stdout: 'x'.repeat(130 * 1024), exit: 0 };
          else
            return {
              stdout: `Earlier transcript\n────────────────────\n${(state.mode.stall === 'wrong-editor' ? 'wrong prompt' : state.mode.stall === 'whitespace-altered' ? (state.editor ?? '').replace(' and do', ' anddo') : (state.editor ?? '')).match(/.{1,37}/g)?.join('\n') ?? ''}\n────────────────────\nmodel footer\n`,
              exit: 0,
            };
        },
      },
    });
    const reply = await model.invoke(argv);
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
