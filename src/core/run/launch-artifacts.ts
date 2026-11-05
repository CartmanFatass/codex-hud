import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import type { LaunchCommand } from '../types/capabilities.js';

/** Finite supervisor-owned support files, not a general file-write capability. */
export type LaunchArtifactKind = 'claude-hook' | 'claude-settings' | 'claude-mcp';
export type LaunchArtifactName = `${LaunchArtifactKind}.${string}.json`;
export interface LaunchArtifactPayload {
  name: LaunchArtifactName;
  base64: string;
}
const pattern = /^(claude-hook|claude-settings|claude-mcp)\.([a-f0-9]{64})\.json$/;
export const MAX_LAUNCH_ARTIFACT_BYTES = 131_072;
export const MAX_TOTAL_LAUNCH_ARTIFACT_BYTES = 262_144;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (): never => {
  throw new Error('invalid_launch_artifacts');
};

export function launchArtifactPath(home: string, runId: string, name: LaunchArtifactName): string {
  if (!isAbsolute(home) || resolve(home) !== home || !/^[A-Za-z0-9_-]{1,128}$/.test(runId) || !pattern.test(name))
    fail();
  return join(home, 'runs', runId, name);
}

export function encodeLaunchArtifact(kind: LaunchArtifactKind, bytes: Buffer): LaunchArtifactPayload {
  const payload: LaunchArtifactPayload = { name: `${kind}.${hash(bytes)}.json`, base64: bytes.toString('base64') };
  decodeLaunchArtifacts([payload]);
  return payload;
}

/** Strict bounded decoding, also used by the final fd-relative writer. */
export function decodeLaunchArtifacts(
  payloads: readonly LaunchArtifactPayload[] | undefined
): { name: LaunchArtifactName; bytes: Buffer }[] {
  if (payloads === undefined) return [];
  if (!Array.isArray(payloads) || payloads.length > 3) fail();
  const seen = new Set<string>();
  let total = 0;
  return payloads.map((payload) => {
    if (
      !payload ||
      Object.keys(payload).sort().join(',') !== 'base64,name' ||
      typeof payload.name !== 'string' ||
      typeof payload.base64 !== 'string' ||
      payload.base64.length > Math.ceil(MAX_LAUNCH_ARTIFACT_BYTES / 3) * 4
    )
      fail();
    const match = pattern.exec(payload.name);
    if (!match || seen.has(match[1])) fail();
    const bytes = Buffer.from(payload.base64, 'base64');
    if (
      bytes.length < 1 ||
      bytes.length > MAX_LAUNCH_ARTIFACT_BYTES ||
      bytes.toString('base64') !== payload.base64 ||
      hash(bytes) !== match![2]
    )
      fail();
    total += bytes.length;
    if (total > MAX_TOTAL_LAUNCH_ARTIFACT_BYTES) fail();
    try {
      const json = JSON.parse(bytes.toString('utf8'));
      if (!json || typeof json !== 'object' || Array.isArray(json)) fail();
    } catch {
      fail();
    }
    seen.add(match![1]);
    return { name: payload.name, bytes };
  });
}

/** Existing launchDigest commits the DAG through exact content-addressed argv paths.
 * Every supplied support file must be reachable from those paths; no unused file writes.
 */
export function validateLaunchArtifacts(
  payloads: readonly LaunchArtifactPayload[] | undefined,
  home: string,
  runId: string,
  command: LaunchCommand
): { name: LaunchArtifactName; bytes: Buffer }[] {
  const entries = decodeLaunchArtifacts(payloads);
  if (!entries.length) return entries;
  if (!command.argv) fail();
  const paths = entries.map(({ name }) => launchArtifactPath(home, runId, name));
  const reachable = new Set<number>();
  for (let index = 0; index < paths.length; index++) if (command.argv!.includes(paths[index])) reachable.add(index);
  const strings = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
  };
  for (const index of reachable) {
    const values = strings(JSON.parse(entries[index].bytes.toString('utf8')));
    for (let candidate = 0; candidate < paths.length; candidate++)
      if (values.some((value) => value.includes(paths[candidate]))) reachable.add(candidate);
  }
  if (reachable.size !== entries.length) fail();
  return entries;
}
