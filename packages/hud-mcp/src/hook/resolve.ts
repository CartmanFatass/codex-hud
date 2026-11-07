import { unlinkSync } from 'node:fs';
import type { ScopeSnapshot, ScopeSnapshotPort } from '../../../../src/core/ledger-scope-read.js';
import {
  IMPLEMENTATION,
  MAX_RECORD_BYTES,
  canonical,
  exists,
  hash,
  marker,
  object,
  privateDirectory,
  privateRead,
  recordPaths,
  type HookConfig,
  type HookRecord,
} from './record.js';

export interface ClaudeHookSourceOptions {
  config: HookConfig;
  /** Explicit historical experiment only; absent on the native source path. */
  scopes?: ScopeSnapshotPort;
  /** Probe-only timing observer, after validation; never receives hook stdin. */
  observe?: (sample: {
    hookStartMonoMs: number;
    hookStartUncertaintyMs: number;
    publishedMonoMs: number;
    agent: 'root' | 'native_child';
    sessionId?: string;
  }) => void;
}
/** Exact one-shot evidence lookup. No transcript reads or delayed retry. */
export function consumeHookRecord(
  options: ClaudeHookSourceOptions,
  expected: {
    processKey: string;
    sourceId: string;
    bootId: string;
    callId: string;
    toolName: string;
    sessionId?: string;
  }
): { record: HookRecord; premise?: ScopeSnapshot } {
  const { config, scopes } = options;
  privateDirectory(config.directory);
  const premise = scopes?.read(expected.processKey);
  if (!premise && !expected.sessionId) throw new Error('Native session source required');
  const paths = recordPaths(config, premise ?? { ...expected, sessionId: expected.sessionId! }, expected.callId);
  // Retain the small tombstone through harness exit. A late publication can never
  // revive a refused call, including through another physical MCP instance.
  marker(paths.seen);
  try {
    if (exists(paths.conflict)) throw new Error('Duplicate publication');
    const bytes = privateRead(paths.record, MAX_RECORD_BYTES);
    if (!bytes.endsWith('\n')) throw new Error('Incomplete record');
    const value: unknown = JSON.parse(bytes);
    if (!object(value)) throw new Error('Invalid hook record');
    const { fingerprint, ...body } = value;
    if (
      hash(body) !== fingerprint ||
      value.version !== 1 ||
      value.implementation !== IMPLEMENTATION ||
      value.profileFingerprint !== config.profileFingerprint ||
      value.sourceId !== expected.sourceId ||
      value.processKey !== expected.processKey ||
      value.bootId !== expected.bootId ||
      value.serverName !== config.serverName ||
      value.toolUseId !== expected.callId ||
      value.toolName !== expected.toolName ||
      typeof value.sessionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.sessionId) ||
      (expected.sessionId !== undefined && value.sessionId !== expected.sessionId) ||
      !object(value.agent) ||
      !(
        (value.agent.kind === 'root' && value.agent.id === null) ||
        (value.agent.kind === 'native_child' && typeof value.agent.id === 'string' && value.agent.id.length > 0)
      ) ||
      (premise ? canonical(value.premise) !== canonical(premise) : value.premise !== undefined)
    )
      throw new Error('Conflicting hook record');
    const now = Number(process.hrtime.bigint()) / 1e6;
    if (
      typeof value.hookStartMonoMs !== 'number' ||
      typeof value.publishedMonoMs !== 'number' ||
      typeof value.hookStartUncertaintyMs !== 'number' ||
      !Number.isFinite(value.hookStartUncertaintyMs) ||
      value.hookStartUncertaintyMs < 0 ||
      value.hookStartUncertaintyMs > 30000 ||
      !Number.isFinite(value.hookStartMonoMs) ||
      !Number.isFinite(value.publishedMonoMs) ||
      value.hookStartMonoMs > value.publishedMonoMs ||
      value.publishedMonoMs > now ||
      now - value.hookStartMonoMs > 30000
    )
      throw new Error('Stale hook record');
    if (exists(paths.conflict)) throw new Error('Duplicate publication');
    const isRoot = value.agent.kind === 'root';
    options.observe?.({
      hookStartMonoMs: value.hookStartMonoMs,
      hookStartUncertaintyMs: value.hookStartUncertaintyMs,
      publishedMonoMs: value.publishedMonoMs,
      agent: isRoot ? 'root' : 'native_child',
      sessionId: value.sessionId as string,
    });
    if (!isRoot) throw new Error('Native child cannot select root context');
    return { record: value as unknown as HookRecord, premise };
  } finally {
    try {
      unlinkSync(paths.record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
