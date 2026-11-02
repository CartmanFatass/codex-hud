import { join } from 'node:path';
import { ReadOnlyScopeSnapshot, type ScopeSnapshotPort } from '../../../../src/core/ledger-scope-read.js';
import {
  CLAUDE_VERSION,
  IMPLEMENTATION,
  HUD_TOOLS,
  hash,
  object,
  text,
  privateRead,
  publishRecord,
  readHookConfig,
  type HookConfig,
  type HookRecord,
} from './record.js';
import { verifyLaunch } from './process.js';

export function makeRecord(
  config: HookConfig,
  input: unknown,
  launch: ReturnType<typeof verifyLaunch>,
  scopes: ScopeSnapshotPort
): HookRecord {
  if (
    !object(input) ||
    input.hook_event_name !== 'PreToolUse' ||
    !text(input.tool_use_id) ||
    !text(input.tool_name, 512) ||
    !text(input.session_id) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.session_id) ||
    !HUD_TOOLS.some((t) => input.tool_name === `mcp__${config.serverName}__${t}`)
  )
    throw new Error('Invalid hook input');
  // Absent agent fields mean root ONLY under the pinned, no-custom-agent launch profile.
  // A one-sided, empty or null agent field is ambiguous, never a root default.
  const hasId = Object.hasOwn(input, 'agent_id'),
    hasType = Object.hasOwn(input, 'agent_type');
  if (hasId !== hasType || (hasId && (!text(input.agent_id) || !text(input.agent_type))))
    throw new Error('Ambiguous agent source');
  const premise = scopes.read(launch.processKey);
  const value: Omit<HookRecord, 'fingerprint'> = {
    version: 1,
    implementation: IMPLEMENTATION,
    claudeVersion: CLAUDE_VERSION,
    profileFingerprint: config.profileFingerprint,
    sourceId: launch.sourceId,
    processKey: launch.processKey,
    bootId: launch.bootId,
    serverName: config.serverName,
    toolUseId: input.tool_use_id,
    toolName: input.tool_name,
    sessionId: input.session_id,
    agent: hasId ? { kind: 'native_child', id: input.agent_id as string } : { kind: 'root', id: null },
    premise,
    hookStartMonoMs: launch.hookStartMonoMs,
    hookStartUncertaintyMs: launch.hookStartUncertaintyMs,
    publishedMonoMs: Number(process.hrtime.bigint()) / 1e6,
  };
  return { ...value, fingerprint: hash(value) };
}
export type HookPhase =
  | 'configRead'
  | 'inputRead'
  | 'launchVerified'
  | 'registryVerified'
  | 'scopeStart'
  | 'scopeRead'
  | 'recordBuilt'
  | 'launchRechecked'
  | 'published';
export async function runHook(
  configPath: string,
  timing?: (phase: HookPhase, monoMs: number) => void
): Promise<HookRecord> {
  const mark = (phase: HookPhase) => timing?.(phase, Number(process.hrtime.bigint()) / 1e6);
  const config = readHookConfig(configPath);
  mark('configRead');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 262144) throw new Error('Hook input exceeds 256 KiB');
    chunks.push(Buffer.from(chunk));
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  mark('inputRead');
  const launch = verifyLaunch(config);
  mark('launchVerified');
  // Claude owns its registry's permissions; the 0600 rule is for HUD publications.
  const registry: unknown = JSON.parse(
    privateRead(join(config.sourceRoot, 'sessions', `${launch.harnessPid}.json`), 16384, false)
  );
  if (
    !object(registry) ||
    registry.pid !== launch.harnessPid ||
    registry.procStart !== launch.harnessStart ||
    registry.pidDomain !== launch.claudePidDomain ||
    !object(input) ||
    registry.sessionId !== input.session_id
  )
    throw new Error('Current Claude registry mismatch');
  mark('registryVerified');
  const scopes = new ReadOnlyScopeSnapshot(config.ledgerPath);
  const record = makeRecord(config, input, launch, {
    read: (key) => {
      mark('scopeStart');
      const premise = scopes.read(key);
      mark('scopeRead');
      return premise;
    },
  });
  mark('recordBuilt');
  if (verifyLaunch(config).processKey !== launch.processKey) throw new Error('Launch changed before publication');
  mark('launchRechecked');
  publishRecord(config, record);
  mark('published');
  return record;
}
