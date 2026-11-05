/** Pi v1.4.0 (4a080252) context evidence. Linux, canonical paths, session format 3.
 * File validation is NOT provenance: only the owned extension channel admits it.
 */
export interface PiContext {
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getSessionDir(): string;
  };
}
interface SelectedSnapshot {
  profile: string;
  epoch: string;
  toolCallId: string;
  toolName: string;
  sessionId: string;
  sessionFile: string | null;
  sessionDir: string;
}
export interface PiContextSnapshot extends SelectedSnapshot {
  status: 'ready' | 'pending';
  headerVersion: 3 | null;
  headerDigest: string | null;
  pendingReason: string | null;
}
interface FileIdentity {
  root: string;
  file: string | null;
  header: string | null;
}
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const PI_EXTENSION_VERSION = '1.4.0';
export const PI_EXTENSION_CONTEXT_PROFILE = 'pi-extension-v1.4.0-4a080252';
export const PI_EXTENSION_CONTEXT_LIMITS = Object.freeze({
  headerBytes: 64 * 1024,
  pathBytes: 4096,
  pathComponents: 128,
  sessionIdBytes: 128,
  toolCallIdBytes: 256,
  toolNameBytes: 128,
});

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function boundedId(value: unknown, kind: string, max: number, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) fail(`invalid_pi_${kind}`);
  return value;
}

export function canonicalPiPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    Buffer.byteLength(value) > PI_EXTENSION_CONTEXT_LIMITS.pathBytes ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.split(path.sep).length > PI_EXTENSION_CONTEXT_LIMITS.pathComponents
  )
    fail('invalid_pi_canonical_path');
  return value;
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function selectedSnapshot(value: unknown, sourceRoot: string): SelectedSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_pi_snapshot');
  const input = value as Record<string, unknown>;
  if (input.profile !== PI_EXTENSION_CONTEXT_PROFILE) fail('unsupported_pi_extension_profile');
  const root = canonicalPiPath(sourceRoot);
  const sessionDir = canonicalPiPath(input.sessionDir);
  if (root !== sessionDir) fail('pi_session_dir_mismatch');
  const sessionFile = input.sessionFile === null ? null : canonicalPiPath(input.sessionFile);
  if (sessionFile !== null && !inside(root, sessionFile)) fail('pi_session_file_outside_source');
  return {
    profile: PI_EXTENSION_CONTEXT_PROFILE,
    epoch: boundedId(input.epoch, 'epoch', 128, /^[A-Za-z0-9_-]+$/),
    toolCallId: boundedId(input.toolCallId, 'tool_call_id', 256, /^[A-Za-z0-9_./:-]+$/),
    toolName: boundedId(input.toolName, 'tool_name', 128, /^[A-Za-z_][A-Za-z0-9_-]*$/),
    sessionId: boundedId(input.sessionId, 'session_id', 128, /^[A-Za-z0-9_-]+$/),
    sessionFile,
    sessionDir,
  };
}

const inode = (stat: { dev: bigint; ino: bigint }) => `${stat.dev}:${stat.ino}`;
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;

async function requireCanonical(value: string) {
  if ((await realpath(value)) !== value) fail('pi_path_not_canonical');
}

/**
 * Hold every directory by fd and open the next component relative to that fd.
 * O_NOFOLLOW on the final file alone does not protect intermediate directories.
 * /proc/self/fd is intentional Linux-only scope; unsupported hosts fail shut.
 */
async function openDirectories(directory: string, handles: FileHandle[]) {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let current = await open('/', flags);
  handles.push(current);
  for (const part of directory.split('/').filter(Boolean)) {
    current = await open(`${fdPath(current)}/${part}`, flags);
    handles.push(current);
  }
  return current;
}

async function verifyHandlePath(handle: FileHandle, expected: string) {
  if ((await realpath(fdPath(handle))) !== expected) fail('pi_path_changed_during_validation');
}

async function headerBytes(handle: FileHandle) {
  const limit = PI_EXTENSION_CONTEXT_LIMITS.headerBytes;
  const buffer = Buffer.alloc(limit + 1);
  let count = 0;
  while (count < buffer.length) {
    const read = await handle.read(buffer, count, buffer.length - count, count);
    if (read.bytesRead === 0) break;
    const newline = buffer.subarray(count, count + read.bytesRead).indexOf(10);
    count += read.bytesRead;
    if (newline >= 0) {
      const end = count - read.bytesRead + newline;
      if (end > limit) fail('pi_session_header_too_large');
      return buffer.subarray(0, end);
    }
  }
  if (count > limit) fail('pi_session_header_too_large');
  return buffer.subarray(0, count);
}

function verifyHeader(bytes: Buffer, sessionId: string) {
  let header;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('invalid_pi_session_header');
  }
  if (
    !header ||
    typeof header !== 'object' ||
    Array.isArray(header) ||
    header.type !== 'session' ||
    header.version !== 3 ||
    typeof header.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(header.id)
  )
    fail('invalid_pi_session_header');
  if (header.id !== sessionId) fail('pi_session_header_mismatch');
}

export async function inspectPiSnapshot(
  input: unknown,
  sourceRoot: string
): Promise<{ snapshot: PiContextSnapshot; identity: FileIdentity }> {
  const snapshot = selectedSnapshot(input, sourceRoot);
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    fail('unsupported_pi_filesystem_profile');
  }
  const handles: FileHandle[] = [];
  try {
    await requireCanonical(snapshot.sessionDir);
    const root = await openDirectories(snapshot.sessionDir, handles);
    await verifyHandlePath(root, snapshot.sessionDir);
    const rootIdentity = inode(await root.stat({ bigint: true }));
    let file = null;
    let fileIdentity = null;
    let parent = root;
    let parentPath = snapshot.sessionDir;
    let header = null;
    if (snapshot.sessionFile !== null) {
      const relative = path.relative(snapshot.sessionDir, snapshot.sessionFile).split(path.sep);
      const leaf = relative.pop();
      for (const component of relative) {
        parent = await open(
          `${fdPath(parent)}/${component}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        handles.push(parent);
        parentPath = path.join(parentPath, component);
      }
      await verifyHandlePath(parent, parentPath);
      try {
        // NONBLOCK prevents a FIFO from hanging before the regular-file check.
        file = await open(
          `${fdPath(parent)}/${leaf}`,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        handles.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (file) {
        const stat = await file.stat({ bigint: true });
        if (!stat.isFile()) fail('pi_session_file_not_regular');
        fileIdentity = inode(stat);
        await verifyHandlePath(file, snapshot.sessionFile);
        await requireCanonical(snapshot.sessionFile);
        header = await headerBytes(file);
        verifyHeader(header, snapshot.sessionId);
        // Re-read only the bounded header: appending transcript records is fine.
        if (!header.equals(await headerBytes(file))) fail('pi_session_header_changed');
        await verifyHandlePath(file, snapshot.sessionFile);
      }
    }
    await requireCanonical(snapshot.sessionDir);
    await verifyHandlePath(root, snapshot.sessionDir);
    await verifyHandlePath(parent, parentPath);
    const headerDigest = header ? createHash('sha256').update(header).digest('hex') : null;
    return {
      snapshot: Object.freeze({
        ...snapshot,
        status: file ? 'ready' : 'pending',
        headerVersion: file ? 3 : null,
        headerDigest,
        pendingReason: file ? null : snapshot.sessionFile === null ? 'session_file_unassigned' : 'session_file_missing',
      }),
      identity: Object.freeze({ root: rootIdentity, file: fileIdentity, header: headerDigest }),
    };
  } finally {
    // Each fd is owned by this validation; no retained watcher or background work.
    await Promise.all(handles.reverse().map((handle) => handle.close()));
  }
}

/** Independent envelope/file validation, NOT authentication of envelope provenance. */
export async function validatePiSnapshot(snapshot: unknown, canonicalSourceDir: string) {
  return (await inspectPiSnapshot(snapshot, canonicalSourceDir)).snapshot;
}

function trustedContext(ctx: PiContext, expectedManager?: PiContext['sessionManager']) {
  if (!ctx || typeof ctx !== 'object') fail('invalid_pi_extension_context');
  const manager = ctx.sessionManager;
  if (!manager || typeof manager !== 'object' || (expectedManager && manager !== expectedManager)) {
    fail('pi_session_manager_changed');
  }
  if (
    typeof manager.getSessionId !== 'function' ||
    typeof manager.getSessionFile !== 'function' ||
    typeof manager.getSessionDir !== 'function'
  )
    fail('unsupported_pi_extension_context');
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  const sessionDir = manager.getSessionDir();
  return { manager, sessionId, sessionFile: sessionFile === undefined ? null : sessionFile, sessionDir };
}

function sameSession(
  a: Pick<SelectedSnapshot, 'sessionId' | 'sessionFile' | 'sessionDir'>,
  b: Pick<SelectedSnapshot, 'sessionId' | 'sessionFile' | 'sessionDir'>
) {
  return a.sessionId === b.sessionId && a.sessionFile === b.sessionFile && a.sessionDir === b.sessionDir;
}

/**
 * The caller must supply the source directory independently of tool input.
 * start() returns a per-epoch closure. Call on session_start; invalidate on
 * session_shutdown and before a session switch/reload. Old closures never revive.
 */
export function createPiDelegationContextGuard({
  profile,
  canonicalSourceDir,
}: {
  profile: string;
  canonicalSourceDir: string;
}) {
  if (profile !== PI_EXTENSION_CONTEXT_PROFILE) fail('unsupported_pi_extension_profile');
  const sourceRoot = canonicalPiPath(canonicalSourceDir);
  type State = {
    epoch: string;
    pinned: PiContextSnapshot | null;
    identity: FileIdentity | null;
    captures: WeakMap<PiContextSnapshot, { ctx: PiContext; manager: PiContext['sessionManager'] }>;
  };
  let active: State | null = null;

  function shutdown() {
    active = null;
  }

  function start() {
    const state: State = { epoch: randomUUID(), pinned: null, identity: null, captures: new WeakMap() };
    active = state;
    const current = () => {
      if (active !== state) fail('stale_pi_extension_epoch');
    };
    function verifyPinned(snapshot: PiContextSnapshot, identity: FileIdentity) {
      if (state.pinned && !sameSession(state.pinned, snapshot)) fail('pi_session_retarget_requires_new_epoch');
      if (state.identity && state.identity.root !== identity.root) fail('pi_source_directory_replaced');
      if (state.identity?.file && state.identity.file !== identity.file) fail('pi_session_file_replaced');
      if (state.identity?.header && state.identity.header !== identity.header) fail('pi_session_header_replaced');
    }
    async function capture(ctx: PiContext, toolCallId: string, toolName: string) {
      current();
      const before = trustedContext(ctx);
      current();
      if (state.pinned && !sameSession(state.pinned, before)) fail('pi_session_retarget_requires_new_epoch');
      const result = await inspectPiSnapshot(
        { profile, epoch: state.epoch, toolCallId, toolName, ...before },
        sourceRoot
      );
      current();
      const after = trustedContext(ctx, before.manager);
      current();
      if (!sameSession(before, after)) fail('pi_session_changed_during_capture');
      verifyPinned(result.snapshot, result.identity);
      state.pinned ??= result.snapshot;
      state.identity = result.identity;
      state.captures.set(result.snapshot, { ctx, manager: before.manager });
      return result.snapshot;
    }
    async function recheck(captured: PiContextSnapshot) {
      current();
      const record = state.captures.get(captured);
      if (!record) fail('unrecognized_pi_context_capture');
      const before = trustedContext(record.ctx, record.manager);
      current();
      if (!sameSession(captured, before)) fail('pi_session_changed_before_recheck');
      const result = await inspectPiSnapshot(captured, sourceRoot);
      current();
      const after = trustedContext(record.ctx, record.manager);
      current();
      if (!sameSession(captured, after)) fail('pi_session_changed_during_recheck');
      verifyPinned(result.snapshot, result.identity);
      state.identity = result.identity;
      state.captures.set(result.snapshot, record);
      return result.snapshot;
    }
    return Object.freeze({
      epoch: state.epoch,
      capture,
      recheck,
      shutdown() {
        if (active === state) shutdown();
      },
    });
  }
  return Object.freeze({ start, shutdown });
}
