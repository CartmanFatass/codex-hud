/** Invocation proof is published by the process that will exec the agent, not
 * by observing whoever happens to be in the pane after `agent start`. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { binScript } from '../mcp/paths.js';
import { readJsonBounded, writeFileAtomic, writeJsonPrivate } from '../utils/atomic-fs.js';
import { isValidPid, procStat } from '../utils/proc.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function launchDir(task: string, launch: string) {
  if (!uuid.test(launch)) throw Error('invalid CLI invocation generation');
  return join(task, 'cli-invocations', launch);
}
export function prepareCliInvocation(task: string, launch: string, agent: string, real: string) {
  const dir = launchDir(task, launch), token = `--hud-invocation=${randomUUID()}`;
  if (!/^[a-z]+$/.test(agent) || /[:\r\n]/.test(dir)) throw Error('invalid CLI invocation path');
  const exec = [process.execPath, binScript('hud-cli'), '--exec-witness', join(dir, 'witness.json'), real].map(quote).join(' ');
  // Ordinary manual invocations still run the CLI but cannot publish/replace a witness.
  writeFileAtomic(join(dir, agent), `#!/bin/sh\nif [ "$1" = ${quote(token)} ]; then\n  shift\n  exec ${exec} "$@"\nfi\nexec ${quote(real)} "$@"\n`, { mode: 0o700, exclusive: true });
  return { dir, token };
}
export function invocationWitness(task: string, launch?: string): { pid: number; start: string } | null {
  try {
    if (!launch) return null;
    const record = readJsonBounded(join(launchDir(task, launch), 'witness.json'), 512) as { pid?: unknown; start?: unknown };
    return isValidPid(record?.pid) && typeof record.start === 'string' && /^\d+$/.test(record.start) ? { pid: record.pid, start: record.start } : null;
  } catch { return null; }
}
export function execWitness(file: string, real: string, argv: string[]): never {
  const start = procStat(process.pid)?.start;
  const execve = (process as NodeJS.Process & { execve?: (path: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve;
  if (!start || !execve) throw Error('cannot witness CLI invocation');
  // Atomic link, never overwrite: replaying the same command cannot adopt a later PID.
  writeJsonPrivate(file, { pid: process.pid, start }, { mkdir: false, exclusive: true });
  return execve(real, [real, ...argv], process.env);
}
