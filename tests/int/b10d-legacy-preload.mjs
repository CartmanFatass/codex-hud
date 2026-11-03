import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { workerData, isMainThread } from 'node:worker_threads';
const epoch = Number(process.env.B10D_LEGACY_EPOCH),
  NativeDate = Date;

if (isMainThread) {
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (!url.endsWith('/dist/render/monitor.js')) return result;
      let source = String(result.source).replace(
        'export function renderMonitor(input)',
        'function originalRenderMonitor(input)'
      );
      source += `
export function renderMonitor(input) { const fixed=globalThis.__b10dLegacyMonitorInput?.(input)??input; const frame=originalRenderMonitor(fixed); globalThis.__b10dLegacyMonitorFrame?.(fixed,frame); return frame; }
`;
      return { ...result, source };
    },
  });
  globalThis.__b10dLegacyMonitorInput = (input) => {
    if (!input.git?.files?.length) return input;
    const fixed = {
      ...input,
      nowMs: epoch,
      notice: undefined,
      tree: { ...input.tree, updatedAt: new NativeDate(epoch) },
      hud: input.hud
        ? {
            ...input.hud,
            sessionStart: new NativeDate(epoch - 5000),
            stale: false,
            health: { sessionBound: true, lastReadAt: new NativeDate(epoch) },
            bridgeHealth: undefined,
          }
        : input.hud,
      worktrees: input.worktrees
        ? {
            ...input.worktrees,
            updatedAt: epoch,
            entries: input.worktrees.entries.map((e) => ({ ...e, observedAt: epoch })),
          }
        : input.worktrees,
    };
    return {
      ...fixed,
      status: (at) => globalThis.__b10dLegacyStatus.statusCard(fixed.hud ?? null, at),
      session: (at) => globalThis.__b10dLegacyStatus.sessionState(fixed.hud ?? null, at),
    };
  };
  globalThis.__b10dLegacyMonitorFrame = (input, frame) => {
    if (input.tree.totalCount >= 2 && input.git?.files?.length)
      appendFileSync(
        process.env.B10D_LEGACY_TRACE + '.panel',
        JSON.stringify({ files: input.git.files, tree: input.tree, lines: frame.lines }) + '\n'
      );
  };
  const [
    { HudStatus },
    { DelegationWorkerClient },
    { renderHud },
    { renderMonitor, initialMonitorState },
    { RolloutParser },
  ] = await Promise.all([
    import('../../dist/collectors/hud-status.js'),
    import('../../dist/core/link/worker-client.js'),
    import('../../dist/render/header.js'),
    import('../../dist/render/monitor.js'),
    import('../../dist/collectors/rollout.js'),
  ]);
  globalThis.__b10dLegacyStatus = await import('../../dist/render/status-block.js');
  const seeded = new RolloutParser(0);
  seeded.setRolloutPath(process.env.B10D_LEGACY_ROOT);
  const snapshot = await seeded.parse();
  const cached = RolloutParser.prototype.getCached;
  RolloutParser.prototype.getCached = function () {
    return cached.call(this) ?? (this.rolloutPath === process.env.B10D_LEGACY_ROOT ? snapshot : null);
  };
  let client = null;
  const open = DelegationWorkerClient.open;
  DelegationWorkerClient.open = function (...args) {
    client = open.apply(this, args);
    return client;
  };
  const build = HudStatus.prototype.build;
  HudStatus.prototype.build = function (...args) {
    const data = build.apply(this, args);
    const clock = Date.now;
    Date.now = () => epoch;
    try {
      // Compare every real legacy field under the same display clock/health context.
      // Worker health and cached-only successful-read clocks are qualified separately.
      const fixed = {
        ...data,
        sessionStart: new NativeDate(epoch - 5000),
        stale: false,
        health: { sessionBound: true, lastReadAt: new NativeDate(epoch) },
        bridgeHealth: undefined,
      };
      const tree = JSON.parse(JSON.stringify(data.subagentTree));
      tree.updatedAt = new NativeDate(epoch).toISOString();
      const legacy = JSON.parse(JSON.stringify({ ...fixed, subagentTree: tree }));
      const result = {
        tree,
        legacy,
        client: !!client,
        view: !!client?.current(),
        bar: renderHud(fixed, { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } }),
        panel: renderMonitor({
          hud: fixed,
          tree: fixed.subagentTree,
          state: initialMonitorState(),
          width: 56,
          height: 40,
          nowMs: epoch,
        }).lines,
      };
      appendFileSync(process.env.B10D_LEGACY_TRACE, JSON.stringify(result) + '\n');
      return data;
    } finally {
      Date.now = clock;
    }
  };
}
