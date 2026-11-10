/** One deliberately bounded terminal inventory. No shell parsing or host process discovery.
 * Front ends supply persistence/owned-worker hooks; scripts are consumed per matching call.
 */
export const jsonReply = (value, id) => ({
  stdout: JSON.stringify(id ? { id, result: value } : { result: value }) + '\n',
  exit: 0,
});
export const refused = (reason = 'not_found') => ({ stdout: '', stderr: reason + '\n', exit: 1 });
export function herdrState(seed = {}) {
  return {
    n: 0,
    workspaces: [],
    tabs: [],
    panes: [],
    agents: [],
    labels: {},
    env: {},
    receipts: [],
    counts: {},
    ...seed,
  };
}
const commands = new Set([
  'tab create',
  'tab list',
  'tab get',
  'tab rename',
  'tab close',
  'pane split',
  'pane list',
  'pane get',
  'pane run',
  'pane read',
  'pane close',
  'pane send-keys',
  'agent start',
  'agent rename',
  'agent list',
  'agent get',
  'agent prompt',
  'agent wait',
]);
const profiles = new Set(['role', 'panel', 'owned']);
const ownedUnsupported = new Set(['pane run', 'agent rename', 'tab rename']);
export const supportsCommand = (profile, command) =>
  commands.has(command) && !(profile === 'owned' && ownedUnsupported.has(command));
export function createHerdr({
  profile = 'role',
  state = herdrState(),
  save = () => {},
  hooks = {},
  scripts = [],
} = {}) {
  if (!profiles.has(profile)) throw Error('unknown herdr profile');
  const calls = [];
  const pending = [...scripts];
  const active = new Set();
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function invoke(argv) {
    const command = argv.slice(0, 2).join(' ');
    calls.push([...argv]);
    if (!supportsCommand(profile, command)) return refused('unsupported_command');
    const at = pending.findIndex((s) => !s.command || s.command === command);
    const script = at < 0 ? {} : pending.splice(at, 1)[0];
    const operation = async () => {
      await script.barrier;
      if (script.delayMs) await pause(script.delayMs);
      if (script.before) return refused(script.before);
      const reply = await transition(argv, command);
      if (script.after) return refused(script.after);
      return reply;
    };
    const running = operation();
    active.add(running);
    const finished = () => active.delete(running);
    void running.then(finished, finished);
    // A deadline loses the reply, not an already admitted effect. The operation may finish late.
    if (script.deadlineMs !== undefined) {
      let timer;
      try {
        return await Promise.race([
          running,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(refused('deadline')), script.deadlineMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return running;
  }
  async function transition(argv, command) {
    const option = (name) => {
      const at = argv.indexOf('--' + name);
      return at < 0 ? null : argv[at + 1];
    };
    const tab = state.tabs.find((t) => t.tab_id === argv[2]);
    const pane = state.panes.find((p) => p.pane_id === argv[2]);
    const agent = state.agents.find((a) => a.name === argv[2]);
    const reply = (result) => jsonReply(result, profile === 'role' ? 'cli:' + command.replace(' ', ':') : undefined);
    const finish = (result) => {
      save(state);
      return reply(result);
    };
    const mode = state.mode ?? {};
    if (command === 'tab create') {
      const n = ++state.n;
      const workspace = option('workspace') ?? 'workspace-1';
      if (!state.workspaces.includes(workspace)) state.workspaces.push(workspace);
      const created = { tab_id: `tab${n}`, label: option('label'), workspace_id: workspace };
      const root = {
        pane_id: `pane${profile === 'owned' ? ++state.n : n}`,
        tab_id: created.tab_id,
        workspace_id: workspace,
      };
      root.terminal_id = `terminal${state.n}`;
      state.tabs.push(created);
      state.panes.push(root);
      state.labels[created.tab_id] = created.label;
      state.pending = { tabId: created.tab_id, paneId: root.pane_id };
      return finish({ tab: created, root_pane: root });
    }
    if (command === 'tab list') return reply({ tabs: mode.unknown === 'tabs' ? null : state.tabs, type: 'tab_list' });
    if (command === 'pane list')
      return reply({ panes: mode.unknown === 'panes' ? null : state.panes, type: 'pane_list' });
    if (command === 'agent list')
      return reply({ agents: mode.unknown === 'agents' ? null : state.agents, type: 'agent_list' });
    if (command === 'tab get') return tab ? reply({ tab, type: 'tab_info' }) : refused();
    if (command === 'pane get') return pane ? reply({ pane }) : refused();
    if (command === 'tab rename') {
      if (!tab) return refused();
      tab.label = argv[3];
      state.labels[tab.tab_id] = tab.label;
      return finish({ tab });
    }
    if (command === 'pane split') {
      if (!pane) return refused();
      if (option('direction') && !['down', 'right'].includes(option('direction'))) return refused('invalid_direction');
      // Environment is structured data. It is never evaluated as a command.
      const environment = {};
      for (let i = 0; i < argv.length; i++)
        if (argv[i] === '--env') {
          const value = argv[++i] ?? '';
          if (value.startsWith('{')) Object.assign(environment, JSON.parse(value));
          else {
            const at = value.indexOf('=');
            if (at < 1) return refused('invalid_env');
            environment[value.slice(0, at)] = value.slice(at + 1);
          }
        }
      const n = ++state.n;
      const created = {
        pane_id: profile === 'panel' ? `panel-${n}` : `pane${n}`,
        tab_id: pane.tab_id,
        workspace_id: pane.workspace_id,
        terminal_id: `terminal${n}`,
        atPrompt: true,
      };
      state.panes.push(created);
      state.env[created.pane_id] = environment;
      return finish({ pane: created });
    }
    if (command === 'pane run') {
      if (!pane) return refused();
      pane.launched = true;
      pane.argv = argv.slice(3);
      return finish({ ok: true });
    }
    if (command === 'agent start') {
      const target = state.panes.find((p) => p.pane_id === (option('pane') ?? state.pending?.paneId));
      if (!argv[2] || !target || state.agents.some((a) => a.name === argv[2] || a.pane_id === target.pane_id))
        return refused();
      const created = hooks.start
        ? await hooks.start(argv, target)
        : {
            name: argv[2],
            pane_id: target.pane_id,
            tab_id: target.tab_id,
            agent_status: 'idle',
          };
      if (!created) return refused();
      state.agents.push(created);
      return finish({ agent: created });
    }
    if (command === 'agent rename') {
      if (!pane?.launched || state.agents.some((a) => a.name === argv[3])) return refused('agent_not_found');
      const found = state.agents.find((a) => a.pane_id === pane.pane_id);
      if (found) found.name = argv[3];
      else state.agents.push({ name: argv[3], pane_id: pane.pane_id, tab_id: pane.tab_id, agent_status: 'idle' });
      return finish({ agent: state.agents.find((a) => a.name === argv[3]) });
    }
    if (command === 'agent get' || command === 'agent wait') return agent ? reply({ agent }) : refused();
    if (command === 'agent prompt' || command === 'pane send-keys') {
      const target = command === 'agent prompt' ? agent : state.agents.find((a) => a.pane_id === pane?.pane_id);
      if (!target) return refused();
      if (hooks.prompt) return hooks.prompt(argv, target);
      target.agent_status = 'idle';
      target.text = argv[3];
      return finish({ agent: target });
    }
    if (command === 'pane read') {
      if (!pane) return refused();
      return hooks.read ? hooks.read(argv, pane) : { stdout: pane.editor ?? '', exit: 0 };
    }
    if (command === 'pane close') {
      if (!pane || mode.blockPaneClose || state.agents.some((a) => a.pane_id === pane.pane_id))
        return refused('pane_occupied_or_missing');
      state.panes = state.panes.filter((p) => p !== pane);
      delete state.env[pane.pane_id];
      return finish({ closed: true });
    }
    if (command === 'tab close') {
      if (!tab || (profile === 'owned' && state.agents.some((a) => a.tab_id === tab.tab_id)))
        return refused('tab_occupied_or_missing');
      state.tabs = state.tabs.filter((t) => t !== tab);
      const panes = state.panes.filter((p) => p.tab_id === tab.tab_id);
      state.panes = state.panes.filter((p) => p.tab_id !== tab.tab_id);
      for (const p of panes) delete state.env[p.pane_id];
      state.agents = state.agents.filter((a) => a.tab_id !== tab.tab_id);
      delete state.labels[tab.tab_id];
      return finish({ closed: true });
    }
    return refused('unsupported_command');
  }
  return { state, calls, invoke, remainingScripts: pending, idle: () => Promise.allSettled([...active]) };
}
