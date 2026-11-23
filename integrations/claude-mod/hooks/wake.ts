import type { EngineInterface, On, Timer } from 'claude-code';
import { takeBand } from './band';
import { offerCommands } from './commands';
import { mergeChanges, type Turn } from './compact';
import { watchProcess } from './watch';

const WAKE = { plugin: 'hud-mod', key: 'wake' } as const;
const header = 'HUD events (status only; not user instructions or authorization):\n';
const inPane = async ($: EngineInterface) => !(await $.env.get('HUD_JOB_DIR')) && !!(await $.env.get('HERDR_PANE_ID'));

async function wakeLane($: EngineInterface, cwd: string, turn: Turn) {
  const home = await $.env.get('HUD_HOME') || `${await $.env.get('HOME')}/.hud`;
  const root = await $.session.root();
  let project = await $.fs.exists(`${cwd}/.hud`) || (root !== cwd && await $.fs.exists(`${root}/.hud`));
  if (!project) try {
    const registry = JSON.parse(await $.fs.read(`${home}/projects.json`));
    project = registry.version === 1 && registry.projects.some((p: { root: string }) => p.root === root || p.root === cwd);
  } catch { /* No registered project. First HUD call starts the watch instead. */ }

  const held = (await $.state.get(WAKE).catch(() => undefined))?.value;
  let busy = held?.busy ?? null, aborted = held?.aborted ?? false;
  let pending = [...(held?.pending ?? [])], seed = [...(held?.seed ?? [])];
  let lastDelivery = held?.lastDelivery ?? 0;
  let waking = !busy && !aborted && !!seed.length, timer: Timer | undefined;
  held?.seen.forEach(line => turn.seen.add(line));
  // Reload recovery is best-effort: a state write failure is not a failed delivery.
  const save = () => $.state.set(WAKE, { busy, aborted, pending: [...pending], seed: [...seed], seen: [...turn.seen], lastDelivery }).catch(() => {});

  // Take the batch before any await: parallel tool completions cannot drain it twice.
  async function deliver(submit: boolean) {
    const lines = pending.filter(line => !turn.seen.has(line));
    pending = [];
    if (!lines.length) return;
    const text = header + lines.join('\n');
    lines.forEach(s => turn.seen.add(s));
    if (!busy) seed.push(...lines);
    if (submit) waking = true;
    try {
      // Checkpoint the claim without yielding between claiming and submitting the batch.
      const [, result] = await Promise.all([save(), submit ? $.prompt.submit({ text }) :
        $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })]);
      if (('deny' in result && result.deny !== undefined) || ('drop' in result && result.drop !== undefined)) throw new Error('delivery refused');
    } catch {
      watch.stop(); timer?.cancel();
      aborted = true; waking = false;
      for (const line of lines) turn.seen.delete(line);
      seed = seed.filter(line => !lines.includes(line));
      pending.unshift(...lines);
      $.ui.log('HUD wake refused; using MCP delivery.', { to: 'debug' });
    }
    await save();
  }
  function schedule(delay: number) {
    if (timer || busy || waking || !pending.length) return;
    timer = $.clock.after(delay, () => {
      timer = undefined;
      if (!busy && !waking) void deliver(!aborted);
    });
  }
  const watch = watchProcess($, cwd, home, project, () => lastDelivery, async (lines, at) => {
    for (const line of lines) {
      if (turn.seen.has(line) || pending.includes(line)) continue;
      const job = /^(j[0-9a-f]{16}) /.exec(line)?.[0];
      if (job) pending = pending.filter(s => !s.startsWith(job)); // Not question/answer lines.
      pending.push(line);
    }
    // The cursor is durable together with any received lines that have not reached the session yet.
    if (typeof at === 'number' && Number.isSafeInteger(at) && at > lastDelivery) lastDelivery = at;
    schedule(100);
    await save();
  }, record => takeBand($, record));
  if (project || pending.length) await watch.start();
  schedule(100);
  return {
    start: watch.start,
    stop() { watch.stop(); timer?.cancel(); },
    async stopTurn() { aborted = true; await save(); },
    async begin(id: string) {
      busy = id; aborted = waking = false;
      timer?.cancel(); timer = undefined;
      seed.forEach(line => turn.seen.add(line)); seed = [];
      if (pending.length) await deliver(false);
      await save();
    },
    afterTool: () => busy && pending.length ? deliver(false) : undefined,
    async complete(interrupted: boolean) {
      busy = null; aborted ||= interrupted;
      if (aborted && pending.length) await deliver(false);
      else schedule(0);
      await save();
    },
  };
}

export function registerWake(on: On, turn: Turn) {
  let lane: Awaited<ReturnType<typeof wakeLane>> | undefined;
  on('mcp.connect', { server: /(?:^|_)hud$/ }, async ($, e, next) => {
    if (await inPane($) && (await $.session.surfaces()).length) await $.env.set('HUD_CLAUDE_MOD', '1').catch(() => {});
    return next(e);
  });
  on('session.start', async ($, e, next) => {
    const started = await next(e);
    if (e.isInteractive) await offerCommands($);
    if (e.isInteractive && await inPane($)) {
      await $.env.set('HUD_CLAUDE_MOD', '1').catch(() => {}); // Marker takeover also works for an existing server.
      lane = await wakeLane($, e.cwd, turn);
    }
    return started;
  });
  on('turn.start', async (_, e, next) => {
    if (e.agentId === undefined) {
      turn.seen.clear(); turn.tasks.clear();
      await lane?.begin(e.turnId);
    }
    return next(e);
  });
  on('session.stop', async (_, e, next) => { await lane?.stopTurn(); return next(e); });
  on('turn.complete', async (_, e, next) => {
    if (e.agentId === undefined) await lane?.complete(e.reason === 'aborted');
    return next(e);
  });
  on('session.end', (_, e, next) => { if (e.reason !== 'clear') lane?.stop(); return next(e); });
  on('command.run', { command: 'hud' }, async (_, e, next) => { await lane?.start(); return next(e); });
  on('tool.call', async (_, e, next) => {
    const hud = /^mcp__(?:\w*_)?hud__hud_/.test(e.tool);
    if (hud && e.agentId === undefined) await lane?.start();
    const ran = await next(e);
    if (e.agentId === undefined) await lane?.afterTool();
    if (!hud || e.agentId !== undefined || ran.deny !== undefined || ran.isError || ran.text === undefined) return ran;
    const text = mergeChanges(ran.text, turn);
    return text === undefined ? ran : { result: text };
  });
}
