/** Native session facts, not evidence from prompts, report text or requested session ids. */
import * as fs from 'node:fs';
import { isAbsolute } from 'node:path';
import type { JobSession } from '../mcp/job-contracts.js';
import { readFileBounded } from '../utils/atomic-fs.js';
import { cliAgents } from './cli-kinds.js';

const nativeId = (id: unknown): id is string => typeof id === 'string' && /^[\w][\w.-]{0,127}$/.test(id);

export function piSessionHeader(file: string) {
  if (!isAbsolute(file)) return;
  try {
    const path = fs.realpathSync(file);
    const { bytes } = readFileBounded(path, 64 * 1024);
    const head: { type?: unknown; id?: unknown; cwd?: unknown } | null = JSON.parse(bytes.toString('utf8').split('\n', 1)[0]);
    if (head?.type === 'session' && typeof head.id === 'string' && head.id) return { id: head.id, path, cwd: head.cwd };
  } catch { /* Missing, unreadable or not a native session. */ }
}

export function cliSession(agent: unknown, id: unknown): JobSession | undefined {
  const harness = cliAgents.find(kind => kind === agent);
  if (harness && nativeId(id)) return { harness, id };
}

/** A native init record precedes conversation output; do not read earlier turns. */
export function cliStreamSession(file: string, agent: string, offset: number, validate?: (stat: fs.Stats) => void) {
  const { bytes, truncated } = readFileBounded(file, 256 * 1024, { offset, validate });
  const lines = bytes.toString('utf8').split('\n');
  if (truncated) lines.pop();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const id = agent === 'claude' && event?.type === 'system' && event.subtype === 'init' ? event.session_id
      : agent === 'agy' && event?.event === 'init' ? event.conversation_id : undefined;
    if (nativeId(id)) return id;
  }
}
