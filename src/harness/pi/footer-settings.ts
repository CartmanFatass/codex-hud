/** p10k's segment keys, now stored only in HUD's explicitly owned config. */
import { lstatSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { readFileBounded, writePrivateFile } from '../../utils/atomic-fs.js';
import { getHudHome } from '../../hud-home.js';
export const FOOTER_KEYS = ['model', 'thinking', 'path', 'git', 'mcp', 'skill', 'lens', 'viz', 'statuses'] as const;
export const BAND_KEYS = ['session', 'context', 'cache', 'tokens', 'tps', 'ttft', 'cost', 'time'] as const;
export type FooterSettings = {
  footer?: Partial<Record<(typeof FOOTER_KEYS)[number], boolean>>;
  band?: Partial<Record<(typeof BAND_KEYS)[number], boolean>>;
};
export function validateFooterSettings(raw: unknown): FooterSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid_pi_footer');
  for (const [group, values] of Object.entries(raw)) {
    if (group !== 'footer' && group !== 'band') throw Error('invalid_pi_footer');
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw Error('invalid_pi_footer');
    const keys: readonly string[] = group === 'footer' ? FOOTER_KEYS : BAND_KEYS;
    for (const [key, value] of Object.entries(values))
      if (!keys.includes(key) || typeof value !== 'boolean') throw Error('invalid_pi_footer');
  }
  return structuredClone(raw) as FooterSettings;
}
export const footerConfigPath = (env: NodeJS.ProcessEnv = process.env) => join(getHudHome(env), 'config.json');
function safeAncestors(directory: string): void {
  let cursor = resolve(directory);
  for (;;) {
    try {
      const s = lstatSync(cursor);
      if (!s.isDirectory() || s.isSymbolicLink()) throw Error('unsafe_pi_footer_config');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function readConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const file = footerConfigPath(env);
  safeAncestors(dirname(file));
  try {
    const { bytes, truncated } = readFileBounded(file, 65536, { validate: (stat) => {
      if (!stat.isFile() || stat.size > 65536) throw Error('invalid_pi_footer_config');
    } });
    if (truncated) throw Error('invalid_pi_footer_config');
    const raw = JSON.parse(bytes.toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid_pi_footer_config');
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
export function loadFooterSettings(env: NodeJS.ProcessEnv): FooterSettings {
  try {
    const raw = readConfig(env).piFooter;
    return raw === undefined ? {} : validateFooterSettings(raw);
  } catch {
    return {};
  }
}
/** Explicit command write, never on startup; preserve all unrelated sections. */
export function saveFooterSettings(next: FooterSettings, env: NodeJS.ProcessEnv): void {
  validateFooterSettings(next);
  const config = readConfig(env);
  config.piFooter = next;
  const file = footerConfigPath(env);
  const body = JSON.stringify(config, null, 2) + '\n';
  if (Buffer.byteLength(body) > 65536) throw Error('invalid_pi_footer_config');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  safeAncestors(dirname(file));
  writePrivateFile(file, body, { mkdir: false });
}
