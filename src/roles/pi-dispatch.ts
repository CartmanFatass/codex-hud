/** Receipt-pinned pi-roles CLI transport. No helper execution policy lives here. */
import * as fs from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isRecord, runCommand, type HerdrOutcome } from './herdr-run.js';

export type DispatchRole = 'implementer' | 'sonic' | 'reviewer' | 'architect';
export interface LegacyDispatchV1 {
  contract_version: 1;
  role: DispatchRole;
  executable: string;
  reaper: string;
  launch: 'unsent' | 'sent' | 'acked';
  continuation?: { message_key: string; previous_session_id: string; previous_settled_at: string };
}
/** Readable before the owned launcher is selected. No execution imports here. */
export interface OwnedDispatchV2 {
  contract_version: 2;
  transport: 'hud-owned';
  role: DispatchRole;
  launch: 'unsent' | 'sent' | 'acked';
  release: { id: string; root: string };
  contract_path: string;
  continuation?: LegacyDispatchV1['continuation'];
}
export type PiDispatch = LegacyDispatchV1 | OwnedDispatchV2;
export const DISPATCH_LAUNCH_MS = 300_000;
export const DISPATCH_REAP_MS = 180_000;

export function dispatchRole(role: string): DispatchRole {
  if (role === 'imp') return 'implementer';
  if (role === 'oracle') return 'architect';
  if (role === 'sonic' || role === 'reviewer') return role;
  throw new Error('dispatch_role_unsupported');
}

export function validDispatch(value: unknown, role: string, directory?: string): value is PiDispatch {
  if (!['imp', 'sonic', 'reviewer', 'oracle'].includes(role)) return false;
  if (
    !isRecord(value) ||
    (value.contract_version !== 1 && value.contract_version !== 2) ||
    value.role !== dispatchRole(role) ||
    typeof value.launch !== 'string' ||
    !['unsent', 'sent', 'acked'].includes(value.launch)
  )
    return false;
  const allowed = [
    'contract_version',
    'role',
    'launch',
    'continuation',
    ...(value.contract_version === 1 ? ['executable', 'reaper'] : ['transport', 'release', 'contract_path']),
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (value.contract_version === 1) {
    if ('transport' in value || 'release' in value || 'contract_path' in value) return false;
    for (const key of ['executable', 'reaper']) {
      if (typeof value[key] !== 'string' || !isAbsolute(value[key]) || /[\r\n\0]/.test(value[key])) return false;
    }
  } else if (value.contract_version === 2) {
    const release = value.release;
    if (
      value.transport !== 'hud-owned' ||
      'executable' in value ||
      'reaper' in value ||
      !isRecord(release) ||
      typeof release.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(release.id) ||
      Object.keys(release).some((key) => key !== 'id' && key !== 'root') ||
      typeof release.root !== 'string' ||
      !isAbsolute(release.root) ||
      resolve(release.root) !== release.root ||
      release.root.length > 4096 ||
      /[\r\n\0]/.test(release.root) ||
      typeof value.contract_path !== 'string' ||
      !isAbsolute(value.contract_path) ||
      resolve(value.contract_path) !== value.contract_path ||
      value.contract_path.length > 4096 ||
      /[\r\n\0]/.test(value.contract_path) ||
      !value.contract_path.endsWith('/.dispatch/primary/contract.json') ||
      (directory !== undefined && value.contract_path !== join(directory, '.dispatch/primary/contract.json'))
    )
      return false;
  } else {
    return false;
  }
  if (value.continuation !== undefined) {
    const c = value.continuation;
    if (
      !isRecord(c) ||
      Object.keys(c).some((key) => !['message_key', 'previous_session_id', 'previous_settled_at'].includes(key)) ||
      !['message_key', 'previous_session_id', 'previous_settled_at'].every(
        (key) => typeof c[key] === 'string' && c[key].length > 0 && c[key].length <= 400 && !/[\r\n\0]/.test(c[key])
      )
    )
      return false;
  }
  return true;
}

/** Only absent dispatch permits the legacy recipe. An inaccessible installation is an error. */
function executable(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const directory of (env.PATH ?? '').split(':')) {
    const file = resolve(directory || '.', name);
    try {
      fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('dispatch_unavailable');
    }
    try {
      const real = fs.realpathSync(file);
      if (!fs.statSync(real).isFile()) throw new Error('not_regular');
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch {
      throw new Error('dispatch_unavailable');
    }
  }
  return null;
}

export function discoverDispatch(env: NodeJS.ProcessEnv, role: string): LegacyDispatchV1 | null {
  const bin = executable('pi-dispatch', env);
  if (!bin) return null;
  const reaper = executable('pi-role-reap', env);
  if (!reaper) throw new Error('dispatch_reaper_missing');
  return { contract_version: 1, role: dispatchRole(role), executable: bin, reaper, launch: 'unsent' };
}

/** No ORCH/notify channel competes with the caller-armed HUD waiter. */
export function dispatchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, HERDR_ENV: '1' };
  delete next.HERDR_PANE_ID;
  delete next.PI_ORCHESTRATOR_PANE;
  delete next.PI_ROLE_NOTIFY;
  return next;
}

/** Bounded regular file, refusing links (including replaced ancestor directories). */
export function dispatchText(file: string, maxBytes: number): string | null {
  try {
    if (fs.realpathSync(file) !== file) return null;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.size > maxBytes) return null;
      const buffer = Buffer.alloc(maxBytes + 1);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return size <= maxBytes ? buffer.subarray(0, size).toString('utf8') : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export interface DispatchSession {
  TASK: string;
  TAB: string;
  TAB_NAME: string;
  LEFT: string;
  RIGHT: string;
  ORCH: string;
  BASE: string;
  PRIMARY: string;
}
const SESSION_KEYS = ['TASK', 'TAB', 'TAB_NAME', 'LEFT', 'RIGHT', 'ORCH', 'BASE', 'PRIMARY'] as const;
export function readDispatchSession(directory: string): DispatchSession | null {
  const text = dispatchText(join(directory, 'SESSION.txt'), 16 * 1024);
  if (!text) return null;
  const data: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const at = line.indexOf('=');
    if (at < 1 || /[\r\0]/.test(line) || line.length > 4096) return null;
    const key = line.slice(0, at);
    if (!(SESSION_KEYS as readonly string[]).includes(key)) continue;
    // pi-role-call appends RIGHT when replacing a vanished helper pane.
    // Other ownership keys are immutable and duplicates are ambiguous.
    if (Object.hasOwn(data, key) && key !== 'RIGHT') return null;
    data[key] = line.slice(at + 1);
  }
  if (!SESSION_KEYS.every((key) => Object.hasOwn(data, key)) || data.TASK !== basename(directory) || data.ORCH !== '')
    return null;
  for (const key of ['TAB', 'LEFT', 'PRIMARY'])
    if (!/^[A-Za-z0-9][A-Za-z0-9:_./-]{0,100}$/.test(data[key]!)) return null;
  if (data.RIGHT && !/^[A-Za-z0-9][A-Za-z0-9:_./-]{0,100}$/.test(data.RIGHT)) return null;
  if (!data.TAB_NAME || !data.BASE || /[\u0000-\u001f]/.test(data.TAB_NAME + data.BASE)) return null;
  // SAFETY: all eight required keys and their value constraints were checked above.
  return data as unknown as DispatchSession;
}

export function launchDispatch(
  dispatch: PiDispatch,
  directory: string,
  cwd: string,
  model: string | null,
  thinking: string | null,
  env: NodeJS.ProcessEnv,
  budgetMs = DISPATCH_LAUNCH_MS
): Promise<HerdrOutcome> {
  if (dispatch.contract_version !== 1) throw new Error('owned_dispatch_unavailable');
  const argv = [dispatch.role, '--task-dir', directory, '--workdir', cwd, '--output', join(directory, 'report.md')];
  if (dispatch.role === 'implementer') argv.push('--split');
  if (model) argv.push('--model', model);
  if (thinking) argv.push('--thinking', thinking);
  return runCommand(dispatch.executable, argv, dispatchEnv(env), { budgetMs });
}

export function reapDispatch(
  dispatch: PiDispatch,
  directory: string,
  env: NodeJS.ProcessEnv,
  budgetMs = DISPATCH_REAP_MS
): Promise<HerdrOutcome> {
  if (dispatch.contract_version !== 1) throw new Error('owned_dispatch_unavailable');
  return runCommand(dispatch.reaper, [directory], dispatchEnv(env), { budgetMs });
}
