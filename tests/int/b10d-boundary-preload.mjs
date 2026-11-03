import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';
if (isMainThread) {
  const { DelegationWorkerClient } = await import('../../dist/core/link/worker-client.js');
  const { HudStatus } = await import('../../dist/collectors/hud-status.js');
  const { RolloutParser } = await import('../../dist/collectors/rollout.js');
  const { HudHealth } = await import('../../dist/collectors/hud-health.js');
  const trace = (kind, data = {}) =>
    appendFileSync(process.env.B10D_BOUNDARY_TRACE, JSON.stringify({ kind, ...data }) + '\n');
  Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    trace('frame', { text: String(chunk) });
    return write.call(this, chunk, ...args);
  };
  const latestSeq = (v) =>
    Math.max(0, ...(v?.tree.nodes ?? []).map((n) => n.observation?.statusProjection.observationStamp?.commitSeq ?? 0));
  const refs = JSON.parse(process.env.B10D_BOUNDARY_REFS);
  let selected = refs[0],
    api,
    client,
    held = null,
    hold = true,
    failBuild = false,
    parseRace = false;
  globalThis.__b10dGate = async () => {
    if (!hold) return;
    trace('gate');
    await new Promise((resolve) => {
      held = resolve;
    });
    held = null;
  };
  globalThis.__b10dMonitor = (hud) => {
    globalThis.__b10dMonitorView = hud?.delegation ?? null;
    trace('monitor', {
      root: hud?.session?.id ?? hud?.subagentTree?.rootId,
      scope: client?.requestedScope(),
      compatible: client?.scopeIsCurrent(api.scope()),
      view: !!hud?.delegation,
      latestSeq: latestSeq(hud?.delegation),
    });
  };
  globalThis.__b10dSetup = (value) => {
    api = value;
    api.finder.check = () => selected;
    api.finder.getCurrentSession = () => selected;
    api.select(selected);
    trace('setup');
  };
  const open = DelegationWorkerClient.open;
  DelegationWorkerClient.open = function (env, home, opts) {
    client = open.call(this, env, home, {
      ...opts,
      onSample: (s) => {
        trace('sample', s);
        opts?.onSample?.(s);
      },
    });
    return client;
  };
  const painted = DelegationWorkerClient.prototype.painted;
  DelegationWorkerClient.prototype.painted = function (view) {
    trace('paint_attempt', {
      root: api?.hud()?.session?.id ?? api?.hud()?.subagentTree?.rootId ?? api?.hud()?.subagentTree?.rootId,
      scope: this.requestedScope(),
      compatible: api ? this.scopeIsCurrent(api.scope()) : false,
      exact: view === globalThis.__b10dMonitorView,
    });
    return painted.call(this, view);
  };
  const hidden = DelegationWorkerClient.prototype.consumeHidden;
  DelegationWorkerClient.prototype.consumeHidden = function (view, scope, reason) {
    trace('hidden_attempt', {
      reason,
      compatible: this.scopeIsCurrent(scope),
      root: api?.hud()?.session?.id ?? api?.hud()?.subagentTree?.rootId ?? api?.hud()?.subagentTree?.rootId,
    });
    return hidden.call(this, view, scope, reason);
  };
  const submit = DelegationWorkerClient.prototype.submitLegacy;
  DelegationWorkerClient.prototype.submitLegacy = function (grant, charge) {
    trace('root_submit', { requestId: grant.requestId, ...charge });
    return submit.call(this, grant, charge);
  };
  const healthRead = HudHealth.prototype.read;
  HudHealth.prototype.read = function (...args) {
    trace('health_read');
    return healthRead.apply(this, args);
  };
  const build = HudStatus.prototype.build;
  HudStatus.prototype.build = function (...args) {
    if (failBuild) {
      trace('build_failure');
      throw new Error('synthetic_build_failure');
    }
    const result = build.apply(this, args);
    trace('build', { root: result.session?.id });
    return result;
  };
  const parse = RolloutParser.prototype.parse;
  RolloutParser.prototype.parse = async function (...args) {
    const result = await parse.apply(this, args);
    if (parseRace) {
      parseRace = false;
      const old = selected;
      selected = refs[1];
      api.select(selected);
      selected = old;
      api.select(selected);
      trace('parse_superseded', { statsCleared: this.getReadStats() == null });
    }
    return result;
  };
  process.on('message', async ({ id, command, ...value }) => {
    try {
      let result;
      if (command === 'state')
        result = {
          diagnostics: client?.diagnostics(),
          latestSeq: latestSeq(client?.current()),
          hud: api?.hud()?.session?.id ?? api?.hud()?.subagentTree?.rootId ?? api?.hud()?.subagentTree?.rootId,
          scope: client?.requestedScope(),
          compatible: api ? client?.scopeIsCurrent(api.scope()) : false,
          held: !!held,
        };
      if (command === 'release') {
        hold = false;
        held?.();
      }
      if (command === 'hold') hold = true;
      if (command === 'select') {
        selected = refs[value.index];
        api.select(selected);
      }
      if (command === 'surface') api.surface(value.mode);
      if (command === 'render') api.render();
      if (command === 'fail') failBuild = value.enabled;
      if (command === 'parseRace') parseRace = true;
      if (command === 'collect') {
        void api.collect().catch((e) => trace('collect_error', { error: String(e) }));
      }
      if (command === 'clear') trace('checkpoint');
      process.send?.({ id, result });
    } catch (e) {
      process.send?.({ id, error: String(e) });
    }
  });
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      if (!url.endsWith('/dist/tree-page.js') && !url.endsWith('/dist/index.js')) return loaded;
      let source = String(loaded.source);
      if (url.endsWith('/tree-page.js')) {
        source = source.replace(
          'const priority = treePaths(tree.nodes);',
          'await globalThis.__b10dGate(); const priority = treePaths(tree.nodes);'
        );
        source = source.replace(
          'const hud = currentHud();',
          'const hud = currentHud(); globalThis.__b10dMonitor(hud);'
        );
        source = source.replace(
          'await new Promise((resolve) => {',
          `globalThis.__b10dSetup({ finder, select: s => { finder.currentSession=s; finder.onSessionChange?.(s); }, scope:()=>hudBuildScope, hud:()=>hudStatus.current(), collect:()=>collect(true), render, surface: mode=>{ activityHub=mode==='activity'?initialActivityHubState('inbox'):null; observability=mode==='observability'?initialObservabilityState():null; settingsPage=mode==='settings'?{draft:settings,original:settings,selected:0,offset:0,message:''}:null; render(); } }); await new Promise((resolve) => {`
        );
        source = source.replace(
          '    armCollect();',
          '    /* Controlled ordinary collections, without a timer racing the boundary probe. */'
        );
      } else {
        source = source.replace(
          '// Started again, the bar reads',
          `globalThis.__b10dSetup({ finder:sessionFinder, select:s=>{ sessionFinder.currentSession=s; sessionFinder.onSessionChange?.(s); }, scope:()=>cachedDelegationScope, hud:()=>cachedHudData, collect:async()=>{wakeCollection();await mainLoop();}, render:repaintCached, surface:()=>{} }); // Started again, the bar reads`
        );
      }
      return { ...loaded, source };
    },
  });
}
