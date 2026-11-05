import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDigest } from '../run/control.js';
import { validateLaunchArtifacts } from '../run/launch-artifacts.js';
import { RUN_NODE_FLAGS } from '../run/runtime.js';
import type { PreparedRunLaunch } from './types.js';

export interface SupervisorDispatch {
  pid: number;
  /** Process exit is observation only; it does not change the run's ledger state. */
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export class SupervisorDispatchError extends Error {
  constructor(
    readonly submission: 'not_submitted' | 'unknown',
    message: string
  ) {
    super(message);
  }
}

/** Exactly one supervisor spawn, after the accepted intent commits. No retries or state changes. */
export async function launchPreparedRun(
  prepared: PreparedRunLaunch,
  ticket: string,
  options: { hudRunPath?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<SupervisorDispatch> {
  const executable = options.hudRunPath ?? fileURLToPath(new URL('../../../bin/hud-run', import.meta.url));
  if (!isAbsolute(executable)) throw new Error('absolute_hud_run_path_required');
  if (!ticket || ticket.includes('\0') || Buffer.byteLength(ticket, 'utf8') > 4096) throw new Error('invalid_ticket');
  if (launchDigest(prepared.input) !== prepared.launchDigest || prepared.payload.input !== prepared.input)
    throw new Error('prepared_launch_changed');
  const bytes = Buffer.from(prepared.payload.briefBase64, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== prepared.deliveredSha256)
    throw new Error('prepared_brief_changed');
  const payload = Buffer.from(JSON.stringify({ ...prepared.payload, ticket }), 'utf8');
  if (payload.length > 1_048_576) throw new Error('protected_launch_input_too_large');
  const home = prepared.payload.env?.HUD_HOME;
  if (!home || !isAbsolute(home)) throw new Error('invalid_hud_home');
  validateLaunchArtifacts(prepared.payload.launchArtifacts, home, prepared.input.runId, prepared.input.launch);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...RUN_NODE_FLAGS, executable, 'start'], {
      cwd: prepared.input.cwd,
      env: { ...process.env, ...options.env, HUD_HOME: home },
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    let spawned = false;
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      child.once('exit', (code, signal) => done({ code, signal }));
      child.once('error', () => done({ code: null, signal: null }));
    });
    child.once('error', () => {
      reject(new SupervisorDispatchError(spawned ? 'unknown' : 'not_submitted', 'supervisor_dispatch_failed'));
    });
    child.stdin!.once('error', () => {
      // A closed private pipe after spawn never proves the supervisor did not
      // consume its ticket. Its ledger/receipt must be reconciled, never retried.
      reject(new SupervisorDispatchError('unknown', 'supervisor_input_unknown'));
    });
    child.once('spawn', () => {
      spawned = true;
      child.stdin!.end(payload, () => {
        child.unref();
        resolve({ pid: child.pid!, completion });
      });
    });
  });
}
