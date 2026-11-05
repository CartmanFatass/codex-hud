/**
 * Isolated Linux lab adapter, not a production caller-identity or capability grant.
 * Reviewed API profile only; selecting this label does not attest a running binary.
 * Official pinned source (v0.73.1, commit prefix 781152fc):
 * https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/extensions/types.ts
 * https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/session-manager.ts
 * Tool execute(toolCallId, params, signal, onUpdate, ctx) supplies ExtensionContext.
 * Only its sessionManager's three identity getters are read. Upstream persistence
 * is lazy: an absent session file is pending, never proof of an existing session.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const PI_EXTENSION_CONTEXT_PROFILE = 'pi-extension-v0.73.1-781152fc';
export const PI_EXTENSION_CONTEXT_LIMITS = Object.freeze({
  headerBytes: 64 * 1024,
  pathBytes: 4096,
  pathComponents: 128,
  sessionIdBytes: 128,
  toolCallIdBytes: 256,
  toolNameBytes: 128,
});

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function boundedId(value, kind, max, pattern) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) fail(`invalid_pi_${kind}`);
  return value;
}

function canonicalPath(value) {
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

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function selectedSnapshot(input, sourceRoot) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_pi_snapshot');
  if (input.profile !== PI_EXTENSION_CONTEXT_PROFILE) fail('unsupported_pi_extension_profile');
  const root = canonicalPath(sourceRoot);
  const sessionDir = canonicalPath(input.sessionDir);
  if (root !== sessionDir) fail('pi_session_dir_mismatch');
  const sessionFile = input.sessionFile === null ? null : canonicalPath(input.sessionFile);
  if (sessionFile !== null && !inside(root, sessionFile)) fail('pi_session_file_outside_source');
  return {
    profile: PI_EXTENSION_CONTEXT_PROFILE,
    epoch: boundedId(input.epoch, 'epoch', 128, /^[A-Za-z0-9_-]+$/),
    toolCallId: boundedId(input.toolCallId, 'tool_call_id', 256, /^[A-Za-z0-9_.:-]+$/),
    toolName: boundedId(input.toolName, 'tool_name', 128, /^[A-Za-z_][A-Za-z0-9_-]*$/),
    sessionId: boundedId(input.sessionId, 'session_id', 128, /^[A-Za-z0-9_-]+$/),
    sessionFile,
    sessionDir,
  };
}

const inode = (stat) => `${stat.dev}:${stat.ino}`;
const fdPath = (handle) => `/proc/self/fd/${handle.fd}`;

async function requireCanonical(value) {
  if ((await realpath(value)) !== value) fail('pi_path_not_canonical');
}

/**
 * Hold every directory by fd and open the next component relative to that fd.
 * O_NOFOLLOW on the final file alone does not protect intermediate directories.
 * /proc/self/fd is intentional Linux-only lab scope; unsupported hosts fail shut.
 */
async function openDirectories(directory, handles) {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let current = await open('/', flags);
  handles.push(current);
  for (const part of directory.split('/').filter(Boolean)) {
    current = await open(`${fdPath(current)}/${part}`, flags);
    handles.push(current);
  }
  return current;
}

async function verifyHandlePath(handle, expected) {
  if ((await realpath(fdPath(handle))) !== expected) fail('pi_path_changed_during_validation');
}

async function headerBytes(handle) {
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

function verifyHeader(bytes, sessionId) {
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

async function inspectSnapshot(input, sourceRoot) {
  const snapshot = selectedSnapshot(input, sourceRoot);
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    fail('unsupported_pi_filesystem_profile');
  }
  const handles = [];
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
        if (error.code !== 'ENOENT') throw error;
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
export async function validateSnapshot(snapshot, canonicalSourceDir) {
  return (await inspectSnapshot(snapshot, canonicalSourceDir)).snapshot;
}

function trustedContext(ctx, expectedManager) {
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

function sameSession(a, b) {
  return a.sessionId === b.sessionId && a.sessionFile === b.sessionFile && a.sessionDir === b.sessionDir;
}

/**
 * The caller must supply the source directory independently of tool input.
 * start() returns a per-epoch closure. Call on session_start; invalidate on
 * session_shutdown and before a session switch/reload. Old closures never revive.
 */
export function createLabPiExtensionContextGuard({ profile, canonicalSourceDir }) {
  if (profile !== PI_EXTENSION_CONTEXT_PROFILE) fail('unsupported_pi_extension_profile');
  const sourceRoot = canonicalPath(canonicalSourceDir);
  let active = null;

  function shutdown() {
    active = null;
  }

  function start() {
    const state = { epoch: randomUUID(), pinned: null, identity: null, captures: new WeakMap() };
    active = state;
    const current = () => {
      if (active !== state) fail('stale_pi_extension_epoch');
    };
    function verifyPinned(snapshot, identity) {
      if (state.pinned && !sameSession(state.pinned, snapshot)) fail('pi_session_retarget_requires_new_epoch');
      if (state.identity && state.identity.root !== identity.root) fail('pi_source_directory_replaced');
      if (state.identity?.file && state.identity.file !== identity.file) fail('pi_session_file_replaced');
      if (state.identity?.header && state.identity.header !== identity.header) fail('pi_session_header_replaced');
    }
    async function capture(ctx, toolCallId, toolName) {
      current();
      const before = trustedContext(ctx);
      current();
      if (state.pinned && !sameSession(state.pinned, before)) fail('pi_session_retarget_requires_new_epoch');
      const result = await inspectSnapshot(
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
    async function recheck(captured) {
      current();
      const record = state.captures.get(captured);
      if (!record) fail('unrecognized_pi_context_capture');
      const before = trustedContext(record.ctx, record.manager);
      current();
      if (!sameSession(captured, before)) fail('pi_session_changed_before_recheck');
      const result = await inspectSnapshot(captured, sourceRoot);
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

/**
 * Exact pinned extension execute signature. This adapter never reads model args,
 * claims, RPC state, cwd, environment, or any other ctx field. onCapture receives
 * only a verified observation, not a delegation capability. Recheck immediately
 * before a separately authorized external effect; this wrapper performs none.
 */
export function makeLabPiContextExecute({ lifecycle, toolName, onCapture }) {
  if (!lifecycle || typeof lifecycle.capture !== 'function' || typeof lifecycle.recheck !== 'function') {
    fail('invalid_pi_context_lifecycle');
  }
  boundedId(toolName, 'tool_name', 128, /^[A-Za-z_][A-Za-z0-9_-]*$/);
  if (typeof onCapture !== 'function') fail('invalid_pi_capture_consumer');
  return async function execute(toolCallId, params, signal, onUpdate, ctx) {
    const captured = await lifecycle.capture(ctx, toolCallId, toolName);
    const checked = await lifecycle.recheck(captured);
    return onCapture(checked);
  };
}
