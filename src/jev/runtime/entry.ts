// Process entry for one HUD home. Importing this module does not start a runtime.

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_GRACE_MS, JevRuntime } from './executor.js';

/** A stop that does not finish is ended after this long. Tests may set a shorter `JEV_RUNTIME_STOP_DEADLINE_MS`. */
export const STOP_DEADLINE_MS = 10_000;

export function stopDeadlineMs(raw: string | undefined = process.env.JEV_RUNTIME_STOP_DEADLINE_MS): number {
  if (raw === undefined || raw.trim() === '') return STOP_DEADLINE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > STOP_DEADLINE_MS) return STOP_DEADLINE_MS;
  return parsed;
}

function isMain(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(arg).href;
  }
}

async function main(): Promise<void> {
  const hudHome = process.argv[2] ?? '';
  if (!hudHome.startsWith('/')) {
    process.stderr.write('jev-runtime: hud home must be absolute\n');
    process.exit(2);
  }
  const parsed = Number(process.env.JEV_RUNTIME_GRACE_MS);
  const graceMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_GRACE_MS;
  const stateDir = process.env.JEV_RUNTIME_STATE_DIR;
  const cdpUrl = process.env.JEV_RUNTIME_CDP_URL;
  const runtime = new JevRuntime({
    hudHome,
    graceMs,
    exitProcess: true,
    fake: process.env.JEV_RUNTIME_FAKE === '1',
    ...(stateDir ? { stateDir } : {}),
    ...(cdpUrl ? { cdpUrl } : {}),
  });
  let armed = false;
  const stop = (reason: string) => {
    if (!armed) {
      armed = true;
      setTimeout(() => process.exit(1), stopDeadlineMs()).unref();
    }
    void runtime.stop(reason);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGHUP', () => runtime.lifecycle('phase', 'SIGHUP_ignored'));
  process.on('beforeExit', () => stop('event_loop_empty'));
  process.on('exit', (code) => runtime.lifecycle('exit', String(code)));
  await runtime.start();
}

if (isMain()) {
  main().catch((error: unknown) => {
    const code =
      typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'internal';
    process.stderr.write(`jev-runtime: ${code}\n`);
    process.exit(1);
  });
}
