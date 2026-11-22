import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deserializePanelPlace, serializePanelPlace, type PanelPlace } from '../render/monitor-reload-codec.js';
import { viewPrefs } from '../render/monitor-state.js';
import { DEFAULT_PANEL_VIEW, type HudSettings } from '../settings.js';
import { installationRoot } from '../cli/compat.js';

const PLACE = 'HUD_PANEL_RELOAD_PLACE', SUPERVISED = 'HUD_PANEL_RELOAD_SUPERVISED', RESTART = 75;
export { serializePanelPlace as encodePanelPlace };

export function readPanelPlace(settings?: HudSettings) {
  const raw = process.env[PLACE];
  delete process.env[PLACE];
  if (!raw) return;
  const place = deserializePanelPlace(raw, settings ? viewPrefs(settings) : DEFAULT_PANEL_VIEW);
  // Legacy handoffs without an opening time start their lifetime when consumed.
  if (place) return { ...place, openedAt: place.openedAt ?? Date.now() };
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
  // Test-only timing override; real builds must be quiet for 2s.
  private readonly quietMs: number;
  constructor(readonly entry = fileURLToPath(new URL('../tree-page.js', import.meta.url)), quietMs?: number) {
    const ms = Number(process.env.HUD_PANEL_RELOAD_QUIET_MS);
    this.quietMs = quietMs ?? (Number.isInteger(ms) && ms > 0 ? ms : 2000);
    this.seen = this.attempted = this.signature();
  }
  private signature(): string {
    try { const s = statSync(this.entry); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch { return 'missing'; }
  }
  async poll(dirty: () => boolean, now = Date.now()): Promise<boolean> {
    const signature = this.signature();
    if (signature !== this.seen) { this.seen = signature; this.changedAt = now; }
    if (this.busy || dirty() || signature === this.attempted || now - this.changedAt < this.quietMs) return false;
    this.busy = true;
    const ok = await new Promise<boolean>((resolve) => execFile(process.execPath,
      [join(installationRoot(), 'bin/hud-dist.mjs'), 'probe-panel', this.entry],
      { env: this.env, timeout: 20000 }, (error) => resolve(!error)));
    this.busy = false;
    if (this.signature() !== signature || dirty()) return false;
    this.attempted = signature;
    this.failed = !ok;
    return ok;
  }
  async restart(place: PanelPlace, finish: () => void): Promise<void> {
    // Drafts delay reload; a clean focus can be reopened from its role row. Never put raw launch options in the handoff environment.
    const saved = serializePanelPlace(place);
    const env: NodeJS.ProcessEnv = { ...this.env, [PLACE]: saved };
    if (this.env[SUPERVISED]) {
      await new Promise<void>((resolve, reject) => process.send!(saved, (err) => err ? reject(err) : resolve()));
      process.exitCode = RESTART;
      finish();
      return;
    }
    const execve = (process as typeof process & { execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve;
    // A direct legacy launch switches to the guarded launcher on its first reload.
    const argv = process.argv[1] && resolve(process.argv[1]) === this.entry
      ? [process.execPath, ...process.execArgv, join(installationRoot(), 'bin/hud-dist.mjs'), 'panel', ...process.argv.slice(2)]
      : this.argv;
    finish();
    if (execve) execve(process.execPath, argv, env);
    // Older Node: one supervisor owns all subsequent replacements, never a chain of waiting parents.
    env[SUPERVISED] = '1';
    let code: number | null = RESTART, signal: NodeJS.Signals | null = null;
    while (code === RESTART) {
      const child = spawn(process.execPath, argv.slice(1), { env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
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
