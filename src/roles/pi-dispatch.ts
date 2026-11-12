/** Lightweight receipt/SESSION codecs. Legacy ownership is observation-only. */
import * as fs from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isRecord } from './herdr-run.js';

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
