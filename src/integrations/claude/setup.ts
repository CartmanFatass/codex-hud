/** Setup is orchestration only: the existing statusline writer owns every settings edit. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { safePath } from '../panel/receipt.js';
import type { ClaudeBinding } from './binding.js';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export function readLocal(file: string): Buffer {
  safePath(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.mode & 0o022 || s.size > 1024 * 1024)
      throw new Error('unsafe_setup_file');
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    const n = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (n > 1024 * 1024) throw new Error('setup_file_limit');
    return bytes.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}
function json(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('invalid_setup_json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_setup_json');
  return value as Record<string, unknown>;
}
export function enabledFields(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value)
    .flatMap(([key, item]) => {
      const name = prefix ? `${prefix}.${key}` : key;
      if (item === true) return [name];
      if (item && typeof item === 'object' && !Array.isArray(item))
        return enabledFields(item as Record<string, unknown>, name);
      // Unknown non-boolean enabled values cannot quietly disappear from parity.
      if (item !== false && item !== null && item !== '' && item !== 0) return [name];
      return [];
    })
    .sort();
}
export function draftInventory(home: string, configPath: string) {
  const file = join(home, '.claude/settings.json');
  const settings = readLocal(file);
  const config = readLocal(configPath);
  return {
    version: 1,
    settingsHash: hash(settings),
    configPath,
    configHash: hash(config),
    enabledFields: enabledFields(json(config)),
  };
}
const COMPACT_FIELDS = new Set([
  'model',
  'context',
  'cost',
  'width',
  'display.model',
  'display.context',
  'display.cost',
  'display.width',
]);
export function parity(binding: ClaudeBinding, home: string): { status: string; gaps: string[] } {
  if (!binding.parityInventory) return { status: 'NOT_VERIFIED', gaps: ['parity_inventory_missing'] };
  const inventory = json(readLocal(binding.parityInventory));
  if (inventory.version !== 1 || typeof inventory.configPath !== 'string' || !isAbsolute(inventory.configPath))
    throw new Error('invalid_parity_inventory');
  const actual = draftInventory(home, inventory.configPath);
  if (
    inventory.settingsHash !== actual.settingsHash ||
    inventory.configHash !== actual.configHash ||
    JSON.stringify(inventory.enabledFields) !== JSON.stringify(actual.enabledFields)
  )
    throw new Error('parity_inventory_stale');
  const gaps = actual.enabledFields.filter((field) => !COMPACT_FIELDS.has(field));
  const setting = json(readLocal(join(home, '.claude/settings.json'))).statusLine;
  const command = setting && typeof setting === 'object' ? (setting as { command?: unknown }).command : '';
  if (typeof command !== 'string') gaps.push('unknown_statusline_setting');
  else if (/[|;&<>`\n]|\$\(|\b(?:tee|toktrack|width)\b|--width/.test(command)) gaps.push('statusline_wrapper');
  return { status: gaps.length ? 'BLOCKED' : 'PASS', gaps };
}
export function setupCommand(args: readonly string[], binding: ClaudeBinding, env: NodeJS.ProcessEnv): object {
  const home = env.HOME;
  if (!home || (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== join(home, '.claude')))
    throw new Error('setup_requires_home_claude_config');
  const words = args.length ? [...args] : ['preview'];
  const valid =
    (words.length === 1 && words[0] === 'preview') ||
    (words.length === 3 &&
      ((words[0] === 'apply' && words[1] === '--plan') || (words[0] === 'restore' && words[1] === '--backup')) &&
      isAbsolute(words[2]));
  if (!valid) throw new Error('setup_requires_preview_or_explicit_plan_backup');
  const comparison = words[0] === 'restore' ? null : parity(binding, home);
  if (words[0] === 'apply' && comparison?.status !== 'PASS') return { status: 'BLOCKED', comparison };
  // Do not accept a hand-authored replacement command; pin the plan to this release's preview.
  if (words[0] === 'apply') {
    const plan = json(readLocal(words[2]));
    const preview = invoke(['preview'], binding, env) as Record<string, unknown>;
    if (JSON.stringify(plan) !== JSON.stringify(preview)) throw new Error('statusline_plan_stale_or_foreign');
  }
  const result = invoke(words, binding, env);
  return {
    status: words[0] === 'preview' ? 'PREVIEW' : 'DONE',
    comparison,
    statusline: result,
    order:
      'Apply statusLine LAST, after native plugin and alias changes. Restore statusLine FIRST, then alias, then native plugin changes.',
  };
}
function invoke(args: string[], binding: ClaudeBinding, env: NodeJS.ProcessEnv): object {
  const result = spawnSync(binding.node, [join(binding.release, 'bin/hud'), 'statusline', 'settings', ...args], {
    env: { ...env, HUD_HOME: binding.hudHome },
    encoding: 'utf8',
    timeout: 1200,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || result.error) throw new Error('statusline_settings_failed');
  return json(Buffer.from(result.stdout));
}
