// Ported from owner's aistudio.py: make_key, aggregate state, reserve/update.
// util-linux flock(2) and Python fcntl.flock share the same lock on the same inode.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JevFailure } from '../ask/error.js';
import { readHudConfig, requiredJevLocation } from '../ask/config.js';
import { getHudHome } from '../../hud-home.js';
import { assertLeaseHeld, type HeldLease } from '../ask/lease.js';
import { assertStateDir, fsyncDirectory } from '../ask/names.js';
import {
  assertLabel,
  pyIsSpace,
  pyStrip,
  pythonUniversalNewlines,
  sha256Hex,
  type OperationRecord,
} from '../ask/records.js';
import type { OracleStore } from './oracle.js';

export function normalizeStudioPrompt(prompt: string): string {
  const text = pythonUniversalNewlines(prompt.replace(/^\uFEFF+/, ''));
  return pyStrip(
    text
      .split('\n')
      .map((line) => {
        const chars = Array.from(line);
        while (chars.length && pyIsSpace(chars[chars.length - 1]!.codePointAt(0)!)) chars.pop();
        return chars.join('');
      })
      .join('\n')
  );
}
export function studioKey(
  label: string,
  prompt: string,
  model: string,
  thinking: string,
  conversation: string
): string {
  assertLabel(label);
  return `${label}-${sha256Hex([model, thinking, conversation, normalizeStudioPrompt(prompt)].join('\x1f')).slice(0, 10)}`;
}
export interface StudioConfig {
  stateDir: string;
  models: string[];
  model: string;
  thinking: string;
  cdpUrl?: string;
}
/** HUD JSON only. Snake-case fields from earlier HUD configuration remain readable. */
export function loadStudioConfig(
  options: {
    configJsonPath?: string;
    tomlPath?: string;
    tomlText?: string;
    home?: string;
    capturedEnv?: Record<string, string | undefined>;
  } = {}
): StudioConfig {
  const home = options.home ?? homedir();
  const env = options.capturedEnv ?? process.env;
  const configJsonPath = options.configJsonPath ?? join(getHudHome(env, home), 'config.json');
  const table = studioTable(readHudConfig(configJsonPath));
  const raw = table.stateDir ?? table.state_dir;
  const stateDir = requiredJevLocation(typeof raw === 'string' ? raw : undefined, 'aistudio.stateDir').replace(
    /^~(?=\/|$)/,
    home
  );
  const models = table.models ?? ['gemini-4-argon'];
  const model = table.model ?? table.default_model ?? (Array.isArray(models) ? models[0] : 'gemini-4-argon');
  const thinking = table.thinking ?? table.default_thinking ?? 'High';
  if (
    !Array.isArray(models) ||
    !models.length ||
    !models.every((m) => typeof m === 'string' && /^[A-Za-z0-9_.\/-]+$/.test(m)) ||
    typeof model !== 'string' ||
    !models.includes(model) ||
    !['Low', 'Medium', 'High'].includes(String(thinking))
  )
    throw new JevFailure('aistudio_config', 'aistudio_config');
  assertStateDir(stateDir);
  const endpoint = table.cdpUrl ?? table.cdp_url;
  const cdpUrl = typeof endpoint === 'string' && endpoint ? endpoint : undefined;
  return { stateDir, models: models as string[], model, thinking: thinking as string, ...(cdpUrl ? { cdpUrl } : {}) };
}
function studioTable(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new JevFailure('aistudio_config', 'aistudio_config');
  const table = (value as Record<string, unknown>).aistudio;
  if (table === undefined) return {};
  if (!table || typeof table !== 'object' || Array.isArray(table))
    throw new JevFailure('aistudio_config', 'aistudio_config');
  return table as Record<string, unknown>;
}

interface StudioState {
  keys: Record<string, OperationRecord>;
  [key: string]: unknown;
}
export interface StudioStoreOptions {
  flockPath?: string;
  lockSeconds?: number;
  signal?: AbortSignal;
}
/** Node keeps the inherited open-file description alive after the bounded helper exits. */
export async function withStudioLock<T>(
  stateDir: string,
  fn: () => T | Promise<T>,
  options: StudioStoreOptions = {}
): Promise<T> {
  assertStateDir(stateDir);
  const fd = openSync(join(stateDir, 'aistudio_chat_state.lock'), 'a+', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const seconds = options.lockSeconds ?? 3;
      const child = spawn(options.flockPath ?? '/usr/bin/flock', ['-w', String(seconds), '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd],
      });
      let ended = false;
      const abort = () => child.kill('SIGKILL');
      const timer = setTimeout(abort, Math.max(1, seconds * 1000) + 1_000);
      options.signal?.addEventListener('abort', abort, { once: true });
      const finish = (error?: Error) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      child.once('error', () => finish(new JevFailure('aistudio_lock_unavailable', 'aistudio_lock_unavailable')));
      child.once('exit', (code) =>
        finish(code === 0 ? undefined : new JevFailure('aistudio_lock_failed', 'aistudio_lock_failed'))
      );
      if (options.signal?.aborted) abort();
    });
    options.signal?.throwIfAborted();
    return await fn();
  } finally {
    closeSync(fd);
  }
}
export function studioStore(stateDir: string, key: string, options: StudioStoreOptions = {}): OracleStore {
  const file = join(stateDir, 'aistudio_chat_state.json');
  const load = (): StudioState => {
    if (!existsSync(file)) return { keys: {} };
    let state: StudioState;
    try {
      state = JSON.parse(readFileSync(file, 'utf8')) as StudioState;
    } catch {
      throw new JevFailure('record_corrupt', 'record_corrupt');
    }
    if (!state || !state.keys || typeof state.keys !== 'object' || Array.isArray(state.keys))
      throw new JevFailure('record_corrupt', 'record_corrupt');
    return state;
  };
  const save = async (delta: OperationRecord, lease: HeldLease, click = false) =>
    withStudioLock(
      stateDir,
      () => {
        if (
          lease.stateDir !== stateDir ||
          (lease.kind === 'wait' && lease.key !== key) ||
          (click && lease.kind !== 'browser')
        )
          throw new JevFailure('lease_required', 'lease_required');
        assertLeaseHeld(lease);
        const state = load();
        const previous = state.keys[key] ?? {};
        if (click && previous.attempted_at) throw new JevFailure('already_attempted', 'already_attempted');
        const next: OperationRecord = {
          ...previous,
          ...Object.fromEntries(Object.entries(delta).filter(([, value]) => value !== undefined)),
          key,
        };
        // A Python reservation remains irrevocable, including when an observer saves later.
        if (previous.attempted_at) {
          next.attempted_at = previous.attempted_at;
          next.send_attempted = true;
        }
        if (click) {
          next.attempted_at = new Date().toISOString();
          next.status = 'send_attempted';
          next.send_attempted = true;
          next.send_effect = 'uncertain';
        }
        if (previous.status === 'done') {
          next.status = 'done';
          next.completion = 'COMPLETE';
        }
        state.keys[key] = next;
        const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        const fd = openSync(temp, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify(state, null, 1));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, file);
        fsyncDirectory(stateDir, fsyncSync);
        return next;
      },
      options
    );
  return {
    read: () => withStudioLock(stateDir, () => load().keys[key] ?? null, options),
    save: (delta, lease) => save(delta, lease),
    click: (delta, lease) => save(delta, lease, true),
    async release() {
      throw new JevFailure('aistudio_release_forbidden', 'aistudio_release_forbidden');
    },
  };
}
