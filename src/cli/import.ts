// Explicit one-time migration. A plan contains names only; source values never enter output/errors.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as TOML from '@iarna/toml';
import { getHudHome } from '../hud-home.js';
import { resolveHudEnv } from '../utils/hud-env.js';
import { importableSettings } from '../settings.js';
import { parseAssignments } from '../jev/ask/config.js';
import type { HudIO } from './link-export.js';
import { CliError } from './private-home.js';
import { validateFooterSettings } from '../harness/pi/footer-settings.js';

export const IMPORT_HELP = `Usage: hud import preview|apply [--from <file>]...
Explicitly name each old hud-settings.json or jev-ask TOML. No Codex home is guessed.
For p10k settings: hud import preview|apply --pi-footer --from ABS (only config.json.piFooter).
Also merges $HUD_HOME/jev.env into credentials.env when present.
An explicitly named .env may be imported too (replaces the old setup command).
Existing destination names/keys win; changed existing files get timestamped 0600 backups.
Preview writes nothing. Output contains source/destination paths and names/counts, never values.
`;
const LIMIT = 65536;
type Plan = { source: string; destination: string; before?: Buffer; body: Buffer; added: string[]; skipped: string[] };

export async function importCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(IMPORT_HELP);
    return 0;
  }
  const mode = args[0];
  if (mode !== 'preview' && mode !== 'apply') throw new CliError('invalid_arguments');
  const piFooter = args[1] === '--pi-footer';
  const sources: string[] = [];
  for (let i = piFooter ? 2 : 1; i < args.length; i += 2) {
    if (args[i] !== '--from' || !args[i + 1] || args[i + 1].startsWith('--')) throw new CliError('invalid_arguments');
    if (piFooter && !path.isAbsolute(args[i + 1])) throw new CliError('invalid_arguments');
    sources.push(path.resolve(args[i + 1]));
  }
  if (piFooter && sources.length !== 1) throw new CliError('invalid_arguments');
  try {
    const home = getHudHome(io.env);
    if (!path.isAbsolute(home) || home.includes('\0')) throw new Error();
    safeAncestors(home);
    const plans: Plan[] = [];
    const staged = new Map<string, Buffer>();
    const destination = (file: string): Buffer | undefined =>
      staged.get(file) ?? readSafe(file, true, file.endsWith('.env'));
    const plan = (source: string, file: string, input: Record<string, unknown> | Map<string, string>) => {
      safeAncestors(path.dirname(file));
      const before = destination(file);
      const added: string[] = [],
        skipped: string[] = [];
      let body: Buffer;
      if (input instanceof Map) {
        const current = parseAssignments(before?.toString('utf8') ?? '');
        for (const [name, value] of input) {
          if (current.has(name)) skipped.push(name);
          else {
            current.set(name, value);
            added.push(name);
          }
        }
        // Append only new names, retaining comments and unrecognized existing entries verbatim.
        const suffix = added.map((name) => `${name}="${current.get(name)!}"`).join('\n');
        body = Buffer.from(
          (before?.toString('utf8') ?? '') +
            (before?.length && !before.toString('utf8').endsWith('\n') ? '\n' : '') +
            (suffix ? suffix + '\n' : '')
        );
      } else {
        const current = before ? jsonObject(before.toString('utf8')) : {};
        mergeMissing(current, input, '', added, skipped);
        body = Buffer.from(JSON.stringify(current, null, 2) + '\n');
      }
      // Bound the serialized destination, not just each source. Every reader and
      // the next import must still be able to consume a successful publication.
      if (added.length && body.length > LIMIT) throw new Error();
      plans.push({ source, destination: file, before, body, added, skipped });
      if (added.length) staged.set(file, body);
    };
    const legacy = path.join(home, 'jev.env');
    // The sole implicit source is HUD's own old credential filename, never another tool's home.
    if (!piFooter && !sources.includes(legacy) && readSafe(legacy, true) !== undefined) sources.unshift(legacy);
    for (const source of sources) {
      const bytes = readSafe(source)!;
      if (piFooter) {
        const settings = validateFooterSettings(jsonObject(bytes.toString('utf8')));
        plan(source, path.join(home, 'config.json'), { piFooter: settings });
      } else if (source.endsWith('.env')) {
        const entries = parseAssignments(bytes.toString('utf8'));
        const known = new Map(
          [...entries].filter(([name]) =>
            /^(?:(?:OPENAI|MISTRAL)_API_KEY|(?:OPENAI|MISTRAL)_BASE_URL|TYPESAFE_API_KEY|TYPESAFE_MODEL|TEXT_MODEL_[A-Z0-9_]+)$/.test(
              name
            )
          )
        );
        plan(source, path.join(home, 'credentials.env'), known);
      } else if (source.endsWith('.json')) {
        const imported = importableSettings(jsonObject(bytes.toString('utf8')));
        plan(source, resolveHudEnv(io.env, 'HUD_SETTINGS_PATH') || path.join(home, 'hud-settings.json'), imported);
      } else {
        const raw = TOML.parse(bytes.toString('utf8')) as Record<string, unknown>;
        plan(source, path.join(home, 'config.json'), tomlConfiguration(raw));
      }
    }
    const lines: string[] = [];
    for (const item of plans) {
      lines.push(`${item.source} -> ${item.destination}`);
      lines.push(`add ${item.added.length}: ${item.added.join(', ') || '(none)'}`);
      for (const name of item.skipped) lines.push(`skip existing: ${name}`);
    }
    if (!sources.length)
      lines.push('No sources; name old settings/TOML with --from. No Codex settings source guessed.');
    // Validate the complete plan before changing anything. Each destination is written once.
    if (mode === 'apply') {
      const touched = new Set<string>();
      for (const item of plans) {
        if (!item.added.length || touched.has(item.destination)) continue;
        touched.add(item.destination);
        const original = plans.find((p) => p.destination === item.destination)!.before;
        const current = readSafe(item.destination, true, item.destination.endsWith('.env'));
        if (!equal(current, original)) throw new Error();
        fs.mkdirSync(path.dirname(item.destination), { recursive: true, mode: 0o700 });
        safeAncestors(path.dirname(item.destination));
        if (original !== undefined) {
          const backup = `${item.destination}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID()}`;
          fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
          lines.push(`backup: ${backup}`);
        }
        const temp = `${item.destination}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temp, staged.get(item.destination)!, { flag: 'wx', mode: 0o600 });
          if (!equal(readSafe(item.destination, true, item.destination.endsWith('.env')), original)) throw new Error();
          fs.renameSync(temp, item.destination);
        } finally {
          fs.rmSync(temp, { force: true });
        }
      }
      lines.push(`applied ${touched.size} destination(s)`);
    }
    await io.stdout(lines.join('\n') + '\n');
    return 0;
  } catch {
    // Includes parser/filesystem failures: they may quote input values.
    io.stderr('import_refused: unreadable, unsafe, oversized or invalid source/destination\n');
    return 1;
  }
}
function equal(a: Buffer | undefined, b: Buffer | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.equals(b);
}
function safeAncestors(directory: string): void {
  let cursor = path.resolve(directory);
  for (;;) {
    try {
      const s = fs.lstatSync(cursor);
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function readSafe(file: string, optional = false, credential = false): Buffer | undefined {
  safeAncestors(path.dirname(file));
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > LIMIT || !(s.mode & 0o444) || (credential && (s.mode & 0o777) !== 0o600))
      throw new Error();
    const bytes = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > LIMIT) throw new Error();
    return bytes.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}
function jsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error('invalid_import_json');
  }
}
const STUDIO_ALIASES: Readonly<Record<string, string>> = {
  stateDir: 'state_dir',
  model: 'default_model',
  thinking: 'default_thinking',
  cdpUrl: 'cdp_url',
};
function mergeMissing(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  prefix: string,
  added: string[],
  skipped: string[]
): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const name = prefix + key;
    // These HUD JSON aliases remain runtime-supported; a canonical imported key
    // must not take precedence over an existing logical value under its alias.
    const alias = prefix === 'aistudio.' ? STUDIO_ALIASES[key] : undefined;
    if (alias && Object.hasOwn(current, alias)) {
      skipped.push(name);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!Object.hasOwn(current, key)) current[key] = {};
      const existing = current[key];
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) skipped.push(name);
      else
        mergeMissing(existing as Record<string, unknown>, value as Record<string, unknown>, name + '.', added, skipped);
    } else if (Object.hasOwn(current, key)) skipped.push(name);
    else {
      current[key] = value;
      added.push(name);
    }
  }
}
function tomlConfiguration(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const mapping = {
    cdp_url: 'cdpUrl',
    chrome: 'chrome',
    profile: 'profile',
    state_dir: 'stateDir',
    user_agent: 'userAgent',
    provider_root: 'providerRoot',
    gemini_root: 'geminiRoot',
    model: 'model',
    effort_word: 'effortWord',
    gemini_effort_label: 'geminiEffortLabel',
    gemini_keepalive_seconds: 'keepaliveSeconds',
  };
  for (const section of ['jev', 'aistudio'] as const) {
    const source = raw[section];
    if (source === undefined) continue;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error();
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      const dest =
        section === 'jev'
          ? mapping[key as keyof typeof mapping]
          : (
              {
                cdp_url: 'cdpUrl',
                state_dir: 'stateDir',
                models: 'models',
                default_model: 'model',
                default_thinking: 'thinking',
              } as Record<string, string>
            )[key];
      if (dest) out[dest] = value;
      if (section === 'jev' && key === 'jev_cdp_seconds' && typeof value === 'number') out.cdpTimeoutMs = value * 1000;
      if (section === 'jev' && (key === 'proxy_server' || key === 'proxy_bypass')) {
        const proxy = (out.proxy ??= {}) as Record<string, unknown>;
        proxy[key === 'proxy_server' ? 'server' : 'bypass'] = value;
      }
    }
    result[section] = out;
  }
  if (!Object.keys(result).length) throw new Error();
  return result;
}
