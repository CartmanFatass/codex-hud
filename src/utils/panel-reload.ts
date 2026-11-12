import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MonitorState } from '../render/monitor.js';

const PLACE = 'HUD_PANEL_RELOAD_PLACE', SUPERVISED = 'HUD_PANEL_RELOAD_SUPERVISED', RESTART = 75;
type Place = { state: MonitorState; settings: { selected: number; offset: number } | null };
export function readPanelPlace(): Place | undefined {
  const raw = process.env[PLACE];
  delete process.env[PLACE];
  try { return raw ? JSON.parse(raw, (_key, value) => value?.panelSet ? new Set(value.panelSet) : value) : undefined; }
  catch { return undefined; }
}
/** One metadata probe per collection; only a quiet, loadable generation may replace this process. */
export class PanelReload {
  private seen: string;
  private attempted: string;
  private changedAt = 0;
  private busy = false;
  failed = false;
  private readonly env = { ...process.env };
  private readonly argv = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
  constructor(readonly entry = fileURLToPath(new URL('../tree-page.js', import.meta.url))) {
    this.seen = this.attempted = this.signature();
  }
  private signature(): string {
    try { const s = statSync(this.entry); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch { return 'missing'; }
  }
  async poll(dirty: () => boolean, now = Date.now()): Promise<boolean> {
    const signature = this.signature();
    if (signature !== this.seen) { this.seen = signature; this.changedAt = now; }
    if (this.busy || dirty() || signature === this.attempted || now - this.changedAt < 2000) return false;
    this.busy = true;
    const ok = await new Promise<boolean>((resolve) => execFile(process.execPath,
      ['--input-type=module', '--eval', 'await import(process.argv[1])', pathToFileURL(this.entry).href],
      { env: this.env, timeout: 5000 }, (error) => resolve(!error)));
    this.busy = false;
    if (this.signature() !== signature || dirty()) return false;
    this.attempted = signature;
    this.failed = !ok;
    return ok;
  }
  async restart(place: Place, finish: () => void): Promise<void> {
    const saved = JSON.stringify(place, (_key, value) => value instanceof Set ? { panelSet: [...value] } : value);
    const env: NodeJS.ProcessEnv = { ...this.env, [PLACE]: saved };
    if (this.env[SUPERVISED]) {
      await new Promise<void>((resolve, reject) => process.send!(saved, (err) => err ? reject(err) : resolve()));
      process.exitCode = RESTART;
      finish();
      return;
    }
    const execve = (process as typeof process & { execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve;
    finish();
    if (execve) execve(process.execPath, this.argv, env);
    // Older Node: one supervisor owns all subsequent replacements, never a chain of waiting parents.
    env[SUPERVISED] = '1';
    let code: number | null = RESTART, signal: NodeJS.Signals | null = null;
    while (code === RESTART) {
      const child = spawn(process.execPath, this.argv.slice(1), { env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      const forward = signals.map((sig) => () => { child.kill(sig); });
      signals.forEach((sig, i) => process.on(sig, forward[i]));
      child.on('message', (value) => { if (typeof value === 'string') env[PLACE] = value; });
      [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
        child.once('error', () => resolve([1, null]));
        child.once('exit', (code, signal) => resolve([code, signal]));
      });
      signals.forEach((sig, i) => process.off(sig, forward[i]));
    }
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  }
}
