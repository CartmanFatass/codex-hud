/** Explicit, reversible Claude statusLine settings edits. Never invoked by rendering. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const LIMIT = 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export interface StatuslinePlan {
  version: 1;
  target: string;
  currentHash: string | null;
  command: string;
  proposedHash: string;
}
interface Backup {
  version: 1;
  target: string;
  original: string | null;
  originalHash: string | null;
  mode: number;
  installedHash: string;
}
function target(home: string): string {
  if (process.platform !== 'linux') throw new Error('settings_linux_only');
  if (!path.isAbsolute(home) || fs.realpathSync(home) !== home) throw new Error('unsafe_home');
  const homeStat = fs.lstatSync(home);
  if (homeStat.uid !== process.getuid?.() || (homeStat.mode & 0o022) !== 0) throw new Error('unsafe_home');
  const dir = path.join(home, '.claude');
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(dir) !== dir ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error('unsafe_settings_directory');
  return path.join(dir, 'settings.json');
}
interface PinnedDirectory {
  target: string;
  file: string;
  check: () => void;
}
/** Linux proc-fd paths keep all mutations attached to the opened directory inode. */
function pinned<T>(home: string, work: (dir: PinnedDirectory) => T): T {
  const publicTarget = target(home);
  const directory = path.dirname(publicTarget);
  const fd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.uid !== process.getuid?.() || (opened.mode & 0o022) !== 0)
      throw new Error('unsafe_settings_directory');
    const check = () => {
      if (target(home) !== publicTarget) throw new Error('settings_directory_changed');
      const current = fs.lstatSync(directory);
      if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('settings_directory_changed');
    };
    check();
    const file = `/proc/self/fd/${fd}/settings.json`;
    const result = work({ target: publicTarget, file, check });
    check();
    return result;
  } finally {
    fs.closeSync(fd);
  }
}
function read(file: string, limit = LIMIT): { bytes: Buffer; mode: number } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('unsafe_settings_file');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > limit
    )
      throw new Error('unsafe_settings_file');
    const bounded = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bounded.length) {
      const n = fs.readSync(fd, bounded, length, bounded.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > limit) throw new Error('settings_file_limit');
    return { bytes: Buffer.from(bounded.subarray(0, length)), mode: stat.mode & 0o777 };
  } finally {
    fs.closeSync(fd);
  }
}
function parsed(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!object(value)) throw new Error('invalid_settings_json');
  return value;
}
function proposed(current: Buffer | null, command: string): Buffer {
  const settings = current ? parsed(current) : {};
  settings.statusLine = { type: 'command', command };
  const result = Buffer.from(JSON.stringify(settings, null, 2) + '\n');
  if (result.length > LIMIT) throw new Error('settings_file_limit');
  return result;
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
/** POSIX command, explicitly targeting the Node binary and product entrypoint used for preview. */
export function previewStatusline(home: string, node: string, entry: string): StatuslinePlan {
  if (process.platform === 'win32') throw new Error('settings_posix_only');
  if (![node, entry].every((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value) && fs.statSync(value).isFile()))
    throw new Error('invalid_statusline_command');
  const command = `${quote(node)} ${quote(entry)}`;
  return pinned(home, (dir) => {
    const current = read(dir.file);
    return {
      version: 1,
      target: dir.target,
      currentHash: current ? hash(current.bytes) : null,
      command,
      proposedHash: hash(proposed(current?.bytes ?? null, command)),
    };
  });
}
function validatePlan(value: unknown, home: string): StatuslinePlan {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.target !== target(home) ||
    !(
      value.currentHash === null ||
      (typeof value.currentHash === 'string' && /^[a-f0-9]{64}$/.test(value.currentHash))
    ) ||
    typeof value.command !== 'string' ||
    !value.command ||
    value.command.length > 8192 ||
    /[\0\r\n]/.test(value.command) ||
    typeof value.proposedHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.proposedHash)
  )
    throw new Error('invalid_statusline_plan');
  return value as unknown as StatuslinePlan;
}
function locked<T>(file: string, work: () => T): T {
  const lock = file + '.hud-statusline.lock';
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    return work();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
function syncDirectory(file: string): void {
  const fd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function currentHash(file: string): string | null {
  const current = read(file);
  return current ? hash(current.bytes) : null;
}
function replace(file: string, bytes: Buffer, mode: number, expected: string | null, check: () => void): void {
  const temporary = file + '.hud-statusline-tmp-' + randomUUID();
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    check();
    if (currentHash(file) !== expected) throw new Error('settings_changed');
    fs.renameSync(temporary, file);
    syncDirectory(file);
  } finally {
    fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export function applyStatusline(
  home: string,
  value: unknown
): { target: string; backup: string; installedHash: string } {
  const plan = validatePlan(value, home);
  return pinned(home, (dir) =>
    locked(dir.file, () => {
      const current = read(dir.file);
      if ((current ? hash(current.bytes) : null) !== plan.currentHash) throw new Error('settings_changed');
      const bytes = proposed(current?.bytes ?? null, plan.command);
      if (hash(bytes) !== plan.proposedHash) throw new Error('plan_changed');
      const suffix = '.hud-statusline-backup-' + randomUUID() + '.json';
      const backup = dir.file + suffix;
      const record: Backup = {
        version: 1,
        target: plan.target,
        original: current?.bytes.toString('base64') ?? null,
        originalHash: plan.currentHash,
        mode: current?.mode ?? 0o600,
        installedHash: plan.proposedHash,
      };
      const fd = fs.openSync(backup, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(record) + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      syncDirectory(backup);
      replace(dir.file, bytes, record.mode, plan.currentHash, dir.check);
      return { target: plan.target, backup: plan.target + suffix, installedHash: plan.proposedHash };
    })
  );
}
export function restoreStatusline(home: string, backup: string): { target: string; restored: true } {
  const file = target(home);
  if (
    path.dirname(backup) !== path.dirname(file) ||
    !path.basename(backup).startsWith('settings.json.hud-statusline-backup-')
  )
    throw new Error('invalid_statusline_backup');
  return pinned(home, (dir) => {
    const saved = read(path.join(path.dirname(dir.file), path.basename(backup)), 2 * LIMIT);
    if (!saved) throw new Error('missing_statusline_backup');
    const b = parsed(saved.bytes);
    if (
      b.version !== 1 ||
      b.target !== file ||
      typeof b.installedHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(b.installedHash) ||
      !Number.isSafeInteger(b.mode) ||
      (b.mode as number) < 0 ||
      (b.mode as number) > 0o777 ||
      ((b.mode as number) & 0o022) !== 0 ||
      !(b.original === null || typeof b.original === 'string')
    )
      throw new Error('invalid_statusline_backup');
    const original = b.original === null ? null : Buffer.from(b.original as string, 'base64');
    if ((original ? hash(original) : null) !== b.originalHash || (original && original.length > LIMIT))
      throw new Error('invalid_statusline_backup');
    return locked(dir.file, () => {
      dir.check();
      if (currentHash(dir.file) !== b.installedHash) throw new Error('settings_changed');
      if (original) replace(dir.file, original, b.mode as number, b.installedHash as string, dir.check);
      else {
        fs.unlinkSync(dir.file);
        syncDirectory(dir.file);
      }
      return { target: file, restored: true };
    });
  });
}
/** CLI routing is explicit. Preview never writes; apply needs a saved preview plan. */
export function statuslineSettings(args: readonly string[], home: string, node: string, entry: string): object {
  if (args.length === 1 && args[0] === 'preview') return previewStatusline(home, node, entry);
  if (args.length === 3 && args[0] === 'apply' && args[1] === '--plan' && path.isAbsolute(args[2])) {
    const plan = read(args[2]);
    if (!plan) throw new Error('missing_statusline_plan');
    return applyStatusline(home, parsed(plan.bytes));
  }
  if (args.length === 3 && args[0] === 'restore' && args[1] === '--backup' && path.isAbsolute(args[2]))
    return restoreStatusline(home, args[2]);
  throw new Error('invalid_settings_arguments');
}
