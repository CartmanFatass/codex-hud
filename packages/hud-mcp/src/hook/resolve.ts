import type { CallBudget } from '../../../../src/ledger/call-budget.js';
import { unlinkSync } from 'node:fs';
import type { ScopeSnapshot, ScopeSnapshotPort } from '../../../../src/core/ledger-scope-read.js';
import {
  CLAUDE_VERSION,
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
  scopes: ScopeSnapshotPort;
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
  },
  budget?: CallBudget
): { record: HookRecord; premise: ScopeSnapshot } {
  budget?.check('source');
  const { config, scopes } = options;
  privateDirectory(config.directory);
  budget?.check('source');
  const premise = scopes.read(expected.processKey);
  const paths = recordPaths(config, premise, expected.callId);
  // Retain the small tombstone through harness exit. A late publication can never
  // revive a refused call, including through another physical MCP instance.
  marker(paths.seen);
  try {
    budget?.check('source');
    if (exists(paths.conflict)) throw new Error('Duplicate publication');
    const bytes = privateRead(paths.record, MAX_RECORD_BYTES);
    budget?.check('source');
    if (!bytes.endsWith('\n')) throw new Error('Incomplete record');
    const value: unknown = JSON.parse(bytes);
    if (!object(value)) throw new Error('Invalid hook record');
    const { fingerprint, ...body } = value;
    if (
      hash(body) !== fingerprint ||
      value.version !== 1 ||
      value.implementation !== IMPLEMENTATION ||
      value.claudeVersion !== CLAUDE_VERSION ||
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
      canonical(value.premise) !== canonical(premise)
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
    try {
      options.observe?.({
        hookStartMonoMs: value.hookStartMonoMs,
        hookStartUncertaintyMs: value.hookStartUncertaintyMs,
        publishedMonoMs: value.publishedMonoMs,
        agent: isRoot ? 'root' : 'native_child',
        sessionId: value.sessionId as string,
      });
    } catch {
      /* Optional diagnostic only. */
    }
    if (!isRoot) throw new Error('Native child cannot select root context');
    budget?.check('source');
    return { record: value as unknown as HookRecord, premise };
  } finally {
    try {
      unlinkSync(paths.record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
