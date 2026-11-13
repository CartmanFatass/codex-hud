/** `hud trust <dir>` writes grok, agy and claude trust files. Dispatch never calls this. */
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { HudIO } from './hud.js';
import { CliError, privateHome } from './private-home.js';

const SKIPPED = 'skipped (worker bypass flag shows no trust dialog)';

export async function trustCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.length !== 1 || !args[0]) throw new CliError('usage: hud trust <dir>');
  const dir = resolveDir(args[0]);
  const lines = ['grok', 'agy', 'claude', 'codex'].map((agent) => {
    try {
      return `${agent}: ${trustAgent(agent, dir, io.env)}`;
    } catch (error) {
      return `${agent}: failed (${reason(error)})`;
    }
  });
  await io.stdout(lines.join('\n') + '\n');
  return lines.some((line) => line.includes(': failed (')) ? 1 : 0;
}

function resolveDir(arg: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(arg);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(code === 'ENOENT' ? `not a directory: ${arg}` : `cannot resolve ${arg}`);
  }
  if (!fs.statSync(resolved).isDirectory()) throw new CliError(`not a directory: ${arg}`);
  return resolved;
}

function reason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code) return code;
  const message = error instanceof Error ? error.message : 'error';
  return message.length <= 80 && !message.includes('\n') ? message : 'error';
}

function trustAgent(agent: string, dir: string, env: NodeJS.ProcessEnv): string {
  if (agent === 'codex') return SKIPPED;
  const file = trustFile(agent, env);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('symlinked target');
    if (!stat.isFile()) throw new Error('not a file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'not installed';
    throw error;
  }
  const edit =
    agent === 'grok'
      ? (text: string) => grokEdit(text, dir)
      : agent === 'agy'
        ? (text: string) => agyEdit(text, dir)
        : (text: string) => claudeEdit(text, dir);
  return commit(file, agent, edit, env);
}

function trustFile(agent: string, env: NodeJS.ProcessEnv): string {
  if (agent === 'claude' && env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  if (!env.HOME) throw new Error('HOME is not set');
  if (agent === 'grok') return join(env.HOME, '.grok', 'trusted_folders.toml');
  if (agent === 'agy') return join(env.HOME, '.gemini', 'antigravity-cli', 'settings.json');
  return join(env.HOME, '.claude.json');
}

/** Backup, write a temp with the original mode, rename only if the file is unchanged. At most 3 tries. */
function commit(file: string, agent: string, edit: (text: string) => string | null, env: NodeJS.ProcessEnv): string {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const read = readNoFollow(file);
    const text = read.data.toString('utf8');
    const next = edit(text);
    if (next === null || next === text) return 'already trusted';
    const backup = backupPath(agent, basename(file), env);
    fs.writeFileSync(backup, read.data, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(backup, 0o600);
    const tmp = join(dirname(file), `.hud-trust-${process.pid}-${attempt}.tmp`);
    let renamed = false;
    try {
      fs.writeFileSync(tmp, next, { mode: 0o600 });
      fs.chmodSync(tmp, read.mode);
      if (readNoFollow(file).data.equals(read.data)) {
        fs.renameSync(tmp, file);
        renamed = true;
      }
    } finally {
      if (!renamed && fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    if (renamed) return 'trusted';
  }
  throw new Error('file changed during edit');
}

function backupPath(agent: string, base: string, env: NodeJS.ProcessEnv): string {
  const home = privateHome(env);
  const dir = join(home, 'backups', 'trust');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(join(home, 'backups'), 0o700);
  fs.chmodSync(dir, 0o700);
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, (ms) => ms.slice(1, 4) + 'Z')
    .replace(/[-:]/g, '');
  const plain = join(dir, `${agent}-${stamp}-${base}`);
  return fs.existsSync(plain) ? join(dir, `${agent}-${stamp}-${process.pid}-${base}`) : plain;
}

function readNoFollow(file: string): { data: Buffer; mode: number } {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('symlinked target');
  if (!stat.isFile()) throw new Error('not a file');
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('symlinked target');
    throw error;
  }
  try {
    return { data: fs.readFileSync(fd), mode: stat.mode & 0o777 };
  } finally {
    fs.closeSync(fd);
  }
}

function grokEdit(text: string, dir: string): string | null {
  if (grokTrusted(text, dir)) return null;
  const block = `[folders."${tomlEscape(dir)}"]\ntrusted = true\ndecided_at = ${Math.floor(Date.now() / 1000)}\n`;
  if (!text) return block;
  if (text.endsWith('\n\n')) return text + block;
  return text + (text.endsWith('\n') ? '\n' : '\n\n') + block;
}

function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function grokTrusted(text: string, dir: string): boolean {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (folderPath(lines[i]) !== dir) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (line.startsWith('[')) break;
      if (/^trusted\s*=\s*true(?:\s|#|$)/.test(line)) return true;
    }
  }
  return false;
}

function folderPath(line: string): string | null {
  const trimmed = line.trim();
  const prefix = '[folders.';
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(']')) return null;
  const raw = trimmed.slice(prefix.length, -1).trim();
  if (!raw.startsWith('"')) return null;
  let out = '';
  for (let i = 1; i < raw.length; i++) {
    const char = raw[i];
    if (char === '\\') {
      const next = raw[++i];
      if (next !== '\\' && next !== '"') return null;
      out += next;
    } else if (char === '"') return raw.slice(i + 1).trim() === '' ? out : null;
    else out += char;
  }
  return null;
}

function agyEdit(text: string, dir: string): string | null {
  const value = jsonObject(text);
  const list = value.trustedWorkspaces;
  if (list === undefined) value.trustedWorkspaces = [dir];
  else if (!Array.isArray(list)) throw new Error('trustedWorkspaces is not an array');
  else if (list.includes(dir)) return null;
  else list.push(dir);
  return JSON.stringify(value, null, indentOf(text)) + (text.endsWith('\n') ? '\n' : '');
}

function claudeEdit(text: string, dir: string): string | null {
  const value = jsonObject(text);
  if (value.projects === undefined) value.projects = {};
  if (!value.projects || typeof value.projects !== 'object' || Array.isArray(value.projects))
    throw new Error('projects is not an object');
  const projects = value.projects as Record<string, unknown>;
  const entry = projects[dir];
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const row = entry as Record<string, unknown>;
    if (row.hasTrustDialogAccepted === true) return null;
    row.hasTrustDialogAccepted = true;
  } else if (entry === undefined) projects[dir] = { hasTrustDialogAccepted: true };
  else throw new Error('project entry is not an object');
  return JSON.stringify(value, null, 2) + (text.endsWith('\n') ? '\n' : '');
}

function jsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('unparseable JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
  return value as Record<string, unknown>;
}

function indentOf(text: string): string | number {
  const found = text.match(/\n([ \t]+)(?=\S)/);
  if (!found) return 2;
  return found[1].startsWith('\t') ? '\t' : found[1].length;
}
