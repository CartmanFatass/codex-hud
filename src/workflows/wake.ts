import { fork, spawn, type ChildProcess } from 'node:child_process';
import { procStat } from '../utils/proc.js';
import { notifyRunner, publishRunnerLifetime } from '../utils/runner-lifetime.js';
import { workerTreeRootGone } from '../roles/worker-tree.js';
import { binScript } from '../mcp/paths.js';

/** Pin the loaded module generation before publishing an attempt receipt. No child
 * may execute until the caller grants it the durable claim. */
export async function wakeSealedWorkflow<T>(jobDir: string, admit: (pid: number, start: string, loaded: boolean) =>
  Promise<{ result: T; claimed?: true; input?: object }>) {
  const child = fork(binScript('workflow-runner'), [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  const ready = new Promise<boolean>(done => {
    child.once('message', msg => done(msg === 'ready'));
    child.once('disconnect', () => done(false));
    child.on('error', () => done(false));
  });
  try {
    const pid = child.pid, start = pid && procStat(pid)?.start;
    if (!pid || !start) throw Error('Could not start land helper');
    const { result, claimed, input } = await admit(pid, start, await ready);
    if (claimed) notifyRunner(jobDir, pid);
    if (input) child.send(input);
    return result;
  } finally { if (child.connected) child.disconnect(); child.unref(); }
}
export const publishWorkflowLifetime = publishRunnerLifetime;

const starting = new Map<string, ChildProcess>();
export function wakeWorkflow(home: string, b: { flow: string; pane: string; cwd?: string; root?: string; pid?: number; start?: string; state: string; totals?: { running: number } }) {
  const key = `${home}\0${b.flow}`;
  if ((b.state !== 'working' && !b.totals?.running) || starting.has(key) || (b.pid && b.start && !workerTreeRootGone(b.pid, b.start))) return;
  const { HUD_JOB_DIR: _worker, HERDR_PANE_ID: _pane, ...env } = process.env;
  const child = spawn(process.execPath, [binScript('workflow-runner'), b.flow], { detached: true, stdio: 'ignore',
    cwd: b.cwd ?? b.root!, env: { ...env, HUD_HOME: home, ...(b.pane ? { HERDR_PANE_ID: b.pane } : {}) } });
  starting.set(key, child);
  const clear = () => { if (starting.get(key) === child) starting.delete(key); };
  child.once('exit', clear).once('error', clear).unref();
}
