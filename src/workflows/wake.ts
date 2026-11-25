import { spawn, type ChildProcess } from 'node:child_process';
import { workerTreeRootGone } from '../roles/worker-tree.js';
import { binScript } from '../mcp/paths.js';

const starting = new Map<string, ChildProcess>();
export function wakeWorkflow(home: string, b: { flow: string; pane: string; cwd: string; pid?: number; start?: string; state: string; totals?: { running: number } }) {
  const key = `${home}\0${b.flow}`;
  if ((b.state !== 'working' && !b.totals?.running) || starting.has(key) || (b.pid && b.start && !workerTreeRootGone(b.pid, b.start))) return;
  const { HUD_JOB_DIR: _worker, ...env } = process.env;
  const child = spawn(process.execPath, [binScript('workflow-runner'), b.flow], { detached: true, stdio: 'ignore',
    cwd: b.cwd, env: { ...env, HUD_HOME: home, HERDR_PANE_ID: b.pane } });
  starting.set(key, child);
  const clear = () => { if (starting.get(key) === child) starting.delete(key); };
  child.once('exit', clear).once('error', clear).unref();
}
