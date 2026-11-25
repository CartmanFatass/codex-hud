import type { EngineInterface, On, Timer } from 'claude-code';
import { completeAdvisorTurn, createAdvisor, startAdvisorTurn } from './advisor';
import { takeBand } from './band';
import { offerCommands } from './commands';
import { mergeChanges, mergeNotice, type Turn } from './compact';
import { registerConvention, waitRequest } from './convention';
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
    live: watch.live,
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

async function startWake($: EngineInterface, turn: Turn, interactive: boolean, cwd?: string) {
  if (!interactive) return;
  await offerCommands($);
  if (await inPane($)) {
    await $.env.set('HUD_CLAUDE_MOD', '1').catch(() => {}); // Marker takeover also works for an existing server.
    return wakeLane($, cwd ?? await $.session.cwd(), turn);
  }
}

export function registerWake(on: On, turn: Turn) {
  let lane: Awaited<ReturnType<typeof wakeLane>> | undefined;
  let advisor = createAdvisor();

  registerConvention(on, () => lane?.live() ?? false);
  on('mcp.connect', { server: /(?:^|_)hud$/ }, async ($, e, next) => {
    if (await inPane($) && (await $.session.surfaces()).length) await $.env.set('HUD_CLAUDE_MOD', '1').catch(() => {});
    return next(e);
  });
  // The engine permits only one unfiltered hook per event. Share the lifecycle with the advisor.
  on('session.start', async ($, e, next) => {
    advisor = createAdvisor(e);
    const started = await next(e);
    lane = await startWake($, turn, e.isInteractive, e.cwd);
    return started;
  });
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const needsInit = advisor.interactive === undefined;
      await startAdvisorTurn($, advisor, e);
      turn.seen.clear(); turn.tasks.clear();
      // A reload can miss session.start. Restore the watch and its cursor on the next turn.
      if (needsInit) lane = await startWake($, turn, advisor.interactive === true);
      await lane?.begin(e.turnId);
    }
    return next(e);
  });
  on('session.stop', async (_, e, next) => { await lane?.stopTurn(); return next(e); });
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      completeAdvisorTurn($, advisor, e);
      await lane?.complete(e.reason === 'aborted');
    }
    return next(e);
  });
  on('session.end', (_, e, next) => { if (e.reason !== 'clear') lane?.stop(); return next(e); });
  on('command.run', { command: 'hud' }, async (_, e, next) => { await lane?.start(); return next(e); });
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    const hud = /^mcp__(?:\w*_)?hud__hud_/.test(e.tool);
    // A fallback wait must not bring a sleeping/failed watch back just to compete with it.
    if (hud && !waitRequest(e)) await lane?.start();
    const ran = await next(e);
    await lane?.afterTool();
    if (!hud || ran.deny !== undefined || ran.isError || ran.text === undefined || await $.env.get('HUD_JOB_DIR') !== undefined) return ran;
    const text = mergeChanges(ran.text, turn);
    return text === undefined ? ran : { result: text };
  }).catch((_, e, next) => next(e));

  // Fallback job notices: repeated HUD lines in a Monitor row shrink to what is new.
  on('session.append', { origin: { kind: 'task-notification' } }, async ($, e, next) => {
    if (e.agentId !== undefined || await $.env.get('HUD_JOB_DIR') !== undefined) return next(e);
    const content = e.message.content.map((block) => {
      const text = block.type === 'text' && typeof block.text === 'string' ? mergeNotice(block.text, turn) : undefined;
      return text === undefined ? block : { ...block, text };
    });
    return next(content.some((block, i) => block !== e.message.content[i]) ? { ...e, message: { ...e.message, content } } : e);
  }).catch((_, e, next) => next(e));
}
