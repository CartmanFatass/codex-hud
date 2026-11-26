import { fork } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { readObjectives } from '../collectors/objectives.js';
import { binScript } from '../mcp/paths.js';
import { registeredProject, sharedRoot } from '../roles/projects.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import { controlPath, liveIdentity, MAX_OBJECTIVES, readControl } from './state.js';

export const withControl = <T>(home: string, run: () => T | Promise<T>) =>
  withAbstractLock('unattended-control', home, run, { timeoutMs: 15_000 });

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
