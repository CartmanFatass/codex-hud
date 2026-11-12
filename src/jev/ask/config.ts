// HUD-owned configuration only. Legacy files are read exclusively by `hud import`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHudHome } from '../../hud-home.js';
import type { DecisionProviderId } from '../decide.js';
import { JevFailure } from './error.js';

export interface DecisionConfig {
  primary: DecisionProviderId;
  fallback?: DecisionProviderId;
  /** Compatibility alias; new configuration uses primary. */
  provider?: DecisionProviderId;
  openai: { baseUrl?: string };
  typesafe: { model?: string };
}
export interface JevCredentials {
  geminiApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  typesafeApiKey?: string;
  typesafeModel?: string;
  mistralApiKey?: string;
  mistralBaseUrl?: string;
  textModel: Record<string, string>;
}
export function readHudConfig(file: string): Record<string, unknown> {
  try {
    return object(JSON.parse(fs.readFileSync(file, 'utf8')), 'config.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new JevFailure('config', 'config.json must be a readable JSON object');
  }
}
export function resolveDecisions(root: Record<string, unknown>): DecisionConfig {
  const legacy = object(object(root.jev ?? {}, 'jev').decisions ?? {}, 'jev.decisions');
  const raw = object(root.decisions ?? {}, 'decisions');
  const primary = raw.primary ?? raw.provider ?? legacy.provider ?? 'openai';
  const fallback = raw.fallback;
  for (const [name, value] of [
    ['primary', primary],
    ['fallback', fallback],
  ]) {
    if (value !== undefined && value !== 'gemini' && value !== 'typesafe' && value !== 'openai')
      throw new JevFailure('config', `decisions.${name} must be gemini, typesafe or openai`);
  }
  const openai = object(raw.openai ?? legacy.openai ?? {}, 'decisions.openai');
  const typesafe = object(raw.typesafe ?? legacy.typesafe ?? {}, 'decisions.typesafe');
  if (openai.baseUrl !== undefined && typeof openai.baseUrl !== 'string')
    throw new JevFailure('config', 'decisions.openai.baseUrl must be a string');
  if (typesafe.model !== undefined && typeof typesafe.model !== 'string')
    throw new JevFailure('config', 'decisions.typesafe.model must be a string');
  return {
    primary: primary as DecisionConfig['primary'],
    fallback: fallback as DecisionConfig['fallback'],
    ...(raw.provider !== undefined || legacy.provider !== undefined
      ? { provider: primary as DecisionConfig['primary'] }
      : {}),
    openai: openai as DecisionConfig['openai'],
    typesafe: typesafe as DecisionConfig['typesafe'],
  };
}
export function readPrivateAssignments(file: string): Map<string, string> {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new JevFailure('jev_env_perms', 'credential file must be a regular file with mode 0600');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536)
      throw new JevFailure('jev_env_perms', 'credential file must be a regular file with mode 0600, maximum 64 KiB');
    return parseAssignments(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}
export function parseAssignments(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (let line of text.split('\n')) {
    line = line.trim().replace(/^export\s+/, '');
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]))
      value = value.slice(1, -1);
    result.set(match[1], value);
  }
  return result;
}
const CREDENTIAL_FIELDS = {
  GEMINI_API_KEY: 'geminiApiKey',
  OPENAI_API_KEY: 'openaiApiKey',
  OPENAI_BASE_URL: 'openaiBaseUrl',
  TYPESAFE_API_KEY: 'typesafeApiKey',
  TYPESAFE_MODEL: 'typesafeModel',
  MISTRAL_API_KEY: 'mistralApiKey',
  MISTRAL_BASE_URL: 'mistralBaseUrl',
} as const;
export function readCredentialsEnv(file: string): JevCredentials {
  const creds: JevCredentials = { textModel: {} };
  for (const [name, value] of readPrivateAssignments(file)) {
    if (Object.hasOwn(CREDENTIAL_FIELDS, name))
      creds[CREDENTIAL_FIELDS[name as keyof typeof CREDENTIAL_FIELDS]] = value;
    else if (name.startsWith('TEXT_MODEL_')) creds.textModel[name] = value;
  }
  return creds;
}
export function readHudCredentials(
  env: Record<string, string | undefined> = process.env,
  hudHome = getHudHome(env)
): JevCredentials {
  const creds = readCredentialsEnv(path.join(hudHome, 'credentials.env'));
  for (const [name, field] of Object.entries(CREDENTIAL_FIELDS)) {
    if (env[name] !== undefined) creds[field as (typeof CREDENTIAL_FIELDS)[keyof typeof CREDENTIAL_FIELDS]] = env[name];
  }
  for (const [name, value] of Object.entries(env))
    if (name.startsWith('TEXT_MODEL_') && value !== undefined) creds.textModel[name] = value;
  return creds;
}
export function decisionKeys(creds: JevCredentials): Record<DecisionProviderId, boolean> {
  return { gemini: !!creds.geminiApiKey, openai: !!creds.openaiApiKey, typesafe: !!creds.typesafeApiKey };
}
export function decisionFallback(config: DecisionConfig, creds: JevCredentials, primary = config.primary): DecisionProviderId | undefined {
  return config.fallback && config.fallback !== primary ? config.fallback :
    (['gemini', 'openai', 'typesafe'] as const).find((id) => id !== primary && decisionKeys(creds)[id]);
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new JevFailure('config', `${name} must be an object`);
  return value as Record<string, unknown>;
}
