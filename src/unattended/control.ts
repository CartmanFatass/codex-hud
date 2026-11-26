import { fork } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isCliDirTrusted } from '../cli/trust.js';
import { readObjectives } from '../collectors/objectives.js';
import { validLandConfig } from '../mcp/land.js';
import { binScript, BUNDLED_ROOT } from '../mcp/paths.js';
import { cancelTicketQueueRun } from '../mcp/ticket-queue.js';
import { registeredProject, sharedRoot } from '../roles/projects.js';
import { roleRegistry, routeTiers } from '../roles/roster.js';
import { loadSettings } from '../settings.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import { controlPath, liveIdentity, MAX_OBJECTIVES, readControl } from './state.js';

export const withControl = <T>(home: string, run: () => T | Promise<T>) =>
  withAbstractLock('unattended-control', home, run, { timeoutMs: 15_000 });

function requireProjectTrust(home: string, root: string, env: NodeJS.ProcessEnv) {
  const registry = roleRegistry(home, root, env, undefined, undefined, BUNDLED_ROOT);
  const roles = registry.roles();
  const now = Date.now(), routing = registry.routing(now);
  const settings = loadSettings({ ...env, HUD_HOME: home });
  const agents = new Set<string>();
  for (const name of ['imp', 'frontend-imp', 'reviewer', 'lead']) {
    const role = roles.get(name);
    if (!role) continue;
    // Check the active chain, plus any imp preset the configured router can choose.
    const presets = name !== 'imp' ? [] : settings.impPlacement === 'even' ? settings.impEvenPool
      : settings.impPlacement === 'auto' ? routeTiers.flatMap(tier => role.routing?.[tier]?.preset ?? []) : [];
    const chains = [registry.assignment(role, now, undefined, routing)];
    for (const preset of role.presets ?? []) {
      if (presets.includes(preset.name)) chains.push(registry.assignment(role, now, undefined, routing, { preset: preset.name }));
    }
    for (const { places } of chains) for (const { state, place } of places) {
      if (state !== 'off' && state !== 'missing' && place.harness === 'cli' && place.agent) agents.add(place.agent);
    }
  }
  const untrusted = [...agents].filter(agent => !isCliDirTrusted(agent, root, env));
  if (untrusted.length) {
    const arg = /^[\w/.+-]+$/.test(root) ? root : `'${root.replace(/'/g, `'"'"'`)}'`;
    throw Error(`Unattended project is not trusted for: ${untrusted.sort().join(', ')}\nhud trust ${arg}`);
  }
}

export async function setUnattended(home: string, enabled: boolean,
  selection?: { cwd: string; objectives: string[] }, env = process.env) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  home = realpathSync(home);
  await withControl(home, async () => {
    const prior = readControl(home);
    if (!enabled) {
      if (prior?.enabled) writeJsonPrivate(controlPath(home), { ...prior, enabled: false });
      return;
    }
    const root = selection ? sharedRoot(selection.cwd) : prior?.root;
    const objectives = selection ? [...new Set(selection.objectives)] : prior?.objectives;
    if (!root || !objectives?.length) throw Error('Configure Objectives with hud unattended on --objective <id>');
    if (!registeredProject(home, root).registered) throw Error('Unattended requires a registered project');
    if (objectives.length > MAX_OBJECTIVES) throw Error(`Select at most ${MAX_OBJECTIVES} Objectives`);
    const available = readObjectives(root)?.objectives;
    for (const id of objectives) if (!available?.some(o => o.id === id)) throw Error(`Unknown Objective: ${id}`);
    validLandConfig(home, root);
    requireProjectTrust(home, root, env);
    writeJsonPrivate(controlPath(home), { root, objectives, enabled: true });
    if (liveIdentity(home)) return;
    const { HUD_JOB_DIR: _job, HERDR_PANE_ID: _pane, ...childEnv } = env;
    const child = fork(binScript('hud-unattended'), [], { cwd: root, detached: true, execArgv: [],
      env: { ...childEnv, HUD_HOME: home }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      const ready = await new Promise<boolean>(done => {
        const timeout = setTimeout(() => done(false), 10_000);
        const finish = (ok: boolean) => { clearTimeout(timeout); done(ok); };
        child.once('message', msg => finish(msg === 'ready'));
        child.once('disconnect', () => finish(false));
        child.once('error', () => finish(false));
      });
      if (!ready) throw Error('Unattended service did not start');
    } catch (error) {
      writeJsonPrivate(controlPath(home), { root, objectives, enabled: false });
      throw error;
    } finally {
      if (child.connected) child.disconnect();
      child.unref();
    }
  });
}

export async function cancelUnattendedRun(home: string, id: string) {
  const resolved = existsSync(home) ? realpathSync(home) : home;
  const res = await cancelTicketQueueRun(resolved, id, { unattendedOnly: true, waitMs: 5_000 });
  if (!res) throw Error(`Unknown unattended run: ${id}`);
  if (!res.changed && res.queue.state !== 'cancelled') {
    throw Error(`Unattended run ${id} is already ${res.queue.state}`);
  }
  return res.queue;
}
