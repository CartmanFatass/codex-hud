/**
 * The calling Codex, Claude, or Pi session for `hud roster` when `--root` is omitted.
 *
 * The walk follows `findHarness` / `actualSourceRoot` in `packages/hud-mcp/src/process.ts`.
 * Claude's session id is the registry `sessions/<pid>.json` that resolver already requires.
 * Pi's session id is the `--session` / `--session-id` pair from `resolvePiSession`.
 * Codex's session id is the thread the bar reads with `resolveDaemonThread`.
 * A missing or contradictory carrier is no identity. A `node:test` ancestor stops the
 * walk so the unit gate does not bind a developer's live session.
 */

import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { isCanonicalAbsolutePath } from '../core/canonical.js';
import { makeSourceId } from '../core/identity.js';
import type { Harness } from '../core/types/identity.js';
import { resolveDaemonThread, processStart } from '../collectors/daemon-binding.js';
import { parseRosterRoot, type RosterRoot } from './selection.js';

const ENV_KEYS = new Set([
  'HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_SESSION_ID',
  'PI_SESSION_ID',
  'NODE_TEST_CONTEXT',
]);

export interface CallerProcess {
  pid: number;
  ppid: number;
  procStart: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
}

export interface CallerProbe {
  ppid: number;
  /** Environment of the `hud` process. Claude injects `CLAUDE_CODE_SESSION_ID` here. */
  env: NodeJS.ProcessEnv;
  read(pid: number): CallerProcess | null;
  readText(path: string, maxBytes: number): string | null;
  /** Canonical directory, or null. */
  realpath(path: string): string | null;
  /** Codex thread from the daemon log. Null when the bar cannot tell. */
  codexThread(root: string, pid: number, since: number): string | null;
  started(pid: number): number | null;
}

function harnessOf(argv: readonly string[]): Harness | null {
  const name = basename(argv[0] ?? '');
  if (name === 'claude' || name === 'codex' || name === 'pi') return name;
  if (['node', 'nodejs'].includes(name) && argv.slice(1, 3).some((arg) => /\/pi-coding-agent\//.test(arg))) return 'pi';
  return null;
}

function canonicalRoot(probe: CallerProbe, explicit: string | undefined, fallback: string | undefined): string | null {
  if (!explicit && !fallback) return null;
  const root = probe.realpath(explicit || fallback!);
  return root && isCanonicalAbsolutePath(root) ? root : null;
}

function rootFrom(harness: Harness, root: string, sessionId: string): RosterRoot | null {
  try {
    return parseRosterRoot(`${makeSourceId(harness, root)}/${sessionId}`);
  } catch {
    return null;
  }
}

function claudeSession(proc: CallerProcess, probe: CallerProbe): RosterRoot | null {
  const root = canonicalRoot(probe, proc.env.CLAUDE_CONFIG_DIR, proc.env.HOME ? `${proc.env.HOME}/.claude` : undefined);
  if (!root) return null;
  const text = probe.readText(join(root, 'sessions', `${proc.pid}.json`), 16384);
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if (body.pid !== proc.pid || String(body.procStart) !== proc.procStart || typeof body.sessionId !== 'string')
    return null;
  const claimed = probe.env.CLAUDE_CODE_SESSION_ID;
  if (claimed !== undefined && claimed !== body.sessionId) return null;
  return rootFrom('claude', root, body.sessionId);
}

function piDirectory(argv: readonly string[], probe: CallerProbe): string | null {
  if (argv.includes('--')) return null;
  const executable = basename(argv[0] ?? '');
  const entry = argv[1] ?? '';
  const selector =
    executable === 'pi'
      ? 1
      : ['node', 'nodejs'].includes(executable) && entry.startsWith('/') && /\/pi-coding-agent\//.test(entry)
        ? 2
        : -1;
  if (selector < 0 || argv[selector] !== '--session-dir') return null;
  const root = argv[selector + 1];
  if (!root || !root.startsWith('/')) return null;
  if (argv.slice(selector + 2).some((arg) => arg === '--session-dir' || arg.startsWith('--session-dir='))) return null;
  const canonical = probe.realpath(root);
  return canonical === root && isCanonicalAbsolutePath(canonical) ? canonical : null;
}

function piSessionId(argv: readonly string[], root: string, probe: CallerProbe): string | null {
  if (argv.some((arg) => arg === '--fork' || arg.startsWith('--fork='))) return null;
  let session: string | null = null;
  let expected: string | null = null;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') break;
    if (arg === '--session-id' || arg.startsWith('--session-id=')) {
      if (expected !== null) return null;
      expected = arg === '--session-id' ? (argv[++index] ?? null) : arg.slice('--session-id='.length);
      if (!expected) return null;
    } else if (arg === '--session' || arg.startsWith('--session=')) {
      if (session !== null) return null;
      session = arg === '--session' ? (argv[++index] ?? null) : arg.slice('--session='.length);
      if (!session) return null;
    }
  }
  if (session?.startsWith('/')) {
    if (!session.startsWith(`${root}/`)) return null;
    const text = probe.readText(session, 16384);
    if (!text) return null;
    let header: unknown;
    try {
      header = JSON.parse(text.split('\n')[0] ?? '');
    } catch {
      return null;
    }
    if (header === null || typeof header !== 'object' || Array.isArray(header)) return null;
    const body = header as Record<string, unknown>;
    if (body.type !== 'session' || typeof body.id !== 'string' || !body.id) return null;
    if (expected !== null && body.id !== expected) return null;
    return body.id;
  }
  if (session) return null;
  return expected;
}

function piSession(proc: CallerProcess, probe: CallerProbe): RosterRoot | null {
  const root = piDirectory(proc.argv, probe);
  if (!root) return null;
  const sessionId = piSessionId(proc.argv, root, probe);
  if (!sessionId) return null;
  const claimed = probe.env.PI_SESSION_ID;
  if (claimed !== undefined && claimed !== sessionId) return null;
  return rootFrom('pi', root, sessionId);
}

function codexSession(proc: CallerProcess, probe: CallerProbe): RosterRoot | null {
  const root = canonicalRoot(probe, proc.env.CODEX_HOME, proc.env.HOME ? `${proc.env.HOME}/.codex` : undefined);
  if (!root) return null;
  const since = probe.started(proc.pid);
  if (since === null) return null;
  const thread = probe.codexThread(root, proc.pid, Math.floor(since));
  if (!thread) return null;
  return rootFrom('codex', root, thread);
}

/** Null when this process is not a child of a harness whose session can be proved. */
export function callerRoot(probe: CallerProbe): RosterRoot | null {
  let pid = probe.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const proc = probe.read(pid);
    if (!proc) return null;
    if (proc.env.NODE_TEST_CONTEXT) return null;
    const harness = harnessOf(proc.argv);
    if (harness === 'claude') return claudeSession(proc, probe);
    if (harness === 'pi') return piSession(proc, probe);
    if (harness === 'codex') return codexSession(proc, probe);
    if (proc.ppid === pid) return null;
    pid = proc.ppid;
  }
  return null;
}

function liveRead(pid: number): CallerProcess | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    const ppid = Number(fields[1]);
    const procStart = fields[19];
    if (!procStart || !Number.isInteger(ppid) || ppid < 1) return null;
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0');
    if (argv.at(-1) === '') argv.pop();
    const env: Record<string, string> = {};
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0')) {
      const index = entry.indexOf('=');
      if (index <= 0) continue;
      const key = entry.slice(0, index);
      if (ENV_KEYS.has(key)) env[key] = entry.slice(index + 1);
    }
    return { pid, ppid, procStart, argv, env };
  } catch {
    return null;
  }
}

function liveReadText(path: string, maxBytes: number): string | null {
  try {
    const info = fs.lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) return null;
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function liveRealpath(path: string): string | null {
  try {
    const root = fs.realpathSync(path);
    return fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/**
 * Live identity. Under `node --test` this returns null without reading a home
 * directory: the test process is not a harness session.
 */
export function liveCallerRoot(env: NodeJS.ProcessEnv): RosterRoot | null {
  if (process.env.NODE_TEST_CONTEXT) return null;
  return callerRoot({
    ppid: process.ppid,
    env,
    read: liveRead,
    readText: liveReadText,
    realpath: liveRealpath,
    codexThread: (root, pid, since) => resolveDaemonThread(join(root, 'logs_2.sqlite'), { pid, since }),
    started: processStart,
  });
}
