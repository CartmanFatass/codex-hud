// HUD-owned configuration only. Legacy files are read exclusively by `hud import`.
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { getHudHome } from '../../hud-home.js';
import { decideProviderId } from '../decide.js';
import { JevFailure } from './error.js';

export const ASK_MAX_WAIT_MS = 2 * 60 * 60 * 1000;
export const ASK_MAX_WAIT_CAP_MS = 4 * 60 * 60 * 1000;
export const ASK_QUEUE_LIMIT = 4;
export const ASK_LIVE_LIMIT = 8;
export const ASK_ABANDON_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PROVIDER_ROOT = 'https://chatgpt.com/';
export const DEFAULT_GEMINI_ROOT = 'https://gemini.google.com/app';
export const DEFAULT_MODEL = 'GPT-6';
export const DEFAULT_EFFORT_WORD = 'Pro';
export const DEFAULT_GEMINI_EFFORT_LABEL = 'Argon 高';
export const DEFAULT_KEEPALIVE_SECONDS = 15;
export const DEFAULT_CDP_TIMEOUT_MS = 60_000;
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
export const OPENAI_DECISION_MODEL = 'gpt-6-luna';
export const DEFAULT_TYPESAFE_MODEL = 'jev-latest';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
export interface JevProxy {
  server?: string;
  bypass?: string;
}
export interface DecisionConfig {
  primary: 'typesafe' | 'openai';
  fallback: 'typesafe' | 'openai';
  /** Compatibility alias; new configuration uses primary. */
  provider?: 'typesafe' | 'openai';
  openai: { baseUrl?: string };
  typesafe: { model?: string };
}
export interface JevConfig {
  cdpUrl: string;
  chrome?: string;
  profile?: string;
  userAgent: string;
  stateDir: string;
  providerRoot: string;
  geminiRoot: string;
  model: string;
  effortWord: string;
  geminiEffortLabel: string;
  keepaliveSeconds: number;
  cdpTimeoutMs: number;
  proxy: JevProxy;
  decisions: DecisionConfig;
  ask: { maxWaitMs: number; queueLimit: number; liveLimit: number; abandonMs: number };
}
export interface LoadJevConfigOptions {
  configJsonPath?: string;
  configJson?: unknown;
  configJsonIsJev?: boolean;
  /** Ignored legacy inputs; no runtime TOML reads. */
  tomlPath?: string;
  tomlText?: string;
  capturedEnv?: Record<string, string | undefined>;
  home?: string;
}
export interface JevCredentials {
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  typesafeApiKey?: string;
  typesafeModel?: string;
  mistralApiKey?: string;
  mistralBaseUrl?: string;
  textModel: Record<string, string>;
}
export type DecisionChoice =
  | { ok: true; provider: 'openai'; model: typeof OPENAI_DECISION_MODEL; baseUrl: string; apiKey: string }
  | { ok: true; provider: 'typesafe'; model: string; apiKey: string }
  | { ok: false; error: 'jev_credentials_missing'; provider: string; variable: string };
export function defaultHudConfigPath(home = homedir()): string {
  return path.join(getHudHome(process.env, home), 'config.json');
}
export function readHudConfig(file: string): Record<string, unknown> {
  try {
    return object(JSON.parse(fs.readFileSync(file, 'utf8')), 'config.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new JevFailure('config', 'config.json must be a readable JSON object');
  }
}
export function loadJevConfig(options: LoadJevConfigOptions = {}): JevConfig {
  const env = options.capturedEnv ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const root =
    options.configJson === undefined
      ? readHudConfig(options.configJsonPath ?? path.join(getHudHome(env, home), 'config.json'))
      : object(options.configJson, 'config.json');
  const json = options.configJsonIsJev ? root : object(root.jev ?? {}, 'jev');
  const text = (key: string, fallback = ''): string => {
    if (json[key] === undefined) return fallback;
    if (typeof json[key] !== 'string') throw new JevFailure('config', `jev.${key} must be a string`);
    return json[key] as string;
  };
  const location = (key: string) => requiredJevLocation(text(key), `jev.${key}`).replace(/^~(?=\/|$)/, home);
  const number = (key: string, fallback: number) => finiteNumber(json[key] ?? fallback, `jev.${key}`);
  const ask = object(json.ask ?? {}, 'jev.ask');
  return {
    cdpUrl: location('cdpUrl'),
    chrome: location('chrome'),
    profile: location('profile'),
    stateDir: location('stateDir'),
    userAgent: text('userAgent', DEFAULT_USER_AGENT),
    providerRoot: text('providerRoot', DEFAULT_PROVIDER_ROOT),
    geminiRoot: text('geminiRoot', DEFAULT_GEMINI_ROOT),
    model: text('model', DEFAULT_MODEL),
    effortWord: text('effortWord', DEFAULT_EFFORT_WORD),
    geminiEffortLabel: text('geminiEffortLabel', DEFAULT_GEMINI_EFFORT_LABEL),
    keepaliveSeconds: number('keepaliveSeconds', DEFAULT_KEEPALIVE_SECONDS),
    cdpTimeoutMs: number('cdpTimeoutMs', DEFAULT_CDP_TIMEOUT_MS),
    proxy: resolveProxy(json, env),
    decisions: resolveDecisions(options.configJsonIsJev ? { jev: json } : root),
    ask: {
      maxWaitMs: Math.min(ASK_MAX_WAIT_CAP_MS, finiteNumber(ask.maxWaitMs ?? ASK_MAX_WAIT_MS, 'ask.maxWaitMs')),
      queueLimit: finiteNumber(ask.queueLimit ?? ASK_QUEUE_LIMIT, 'ask.queueLimit'),
      liveLimit: finiteNumber(ask.liveLimit ?? ASK_LIVE_LIMIT, 'ask.liveLimit'),
      abandonMs: finiteNumber(ask.abandonMs ?? ASK_ABANDON_MS, 'ask.abandonMs'),
    },
  };
}
export function requiredJevLocation(value: string | undefined, key: string): string {
  if (!value?.trim()) throw new JevFailure('pre_send', `Missing ${key} in $HUD_HOME/config.json; run hud import`);
  return value;
}
export function assertJevLocations(config: Pick<JevConfig, 'cdpUrl' | 'chrome' | 'profile' | 'stateDir'>): void {
  for (const key of ['cdpUrl', 'chrome', 'profile', 'stateDir'] as const)
    requiredJevLocation(config[key], `jev.${key}`);
}
export function resolveDecisions(root: Record<string, unknown>): DecisionConfig {
  const legacy = object(object(root.jev ?? {}, 'jev').decisions ?? {}, 'jev.decisions');
  const raw = object(root.decisions ?? {}, 'decisions');
  const primary = raw.primary ?? raw.provider ?? legacy.provider ?? 'typesafe';
  const fallback = raw.fallback ?? 'openai';
  for (const [name, value] of [
    ['primary', primary],
    ['fallback', fallback],
  ]) {
    if (value !== 'typesafe' && value !== 'openai')
      throw new JevFailure('config', `decisions.${name} must be typesafe or openai`);
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
/** Explicit-file compatibility helper, never implicit fallback. */
export const readJevEnv = readCredentialsEnv;
/** Explicit source-scoped keyEnv lookup; no host matching or legacy file discovery. */
export function readHudCredentialName(
  name: string,
  env: Record<string, string | undefined>,
  hudHome = getHudHome(env)
): string | undefined {
  return env[name] ?? readPrivateAssignments(path.join(hudHome, 'credentials.env')).get(name);
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
export function selectDecisionProvider(config: JevConfig, creds: JevCredentials): DecisionChoice {
  const decision = decideProviderId(config.decisions.primary ?? config.decisions.provider, {
    typesafe: !!creds.typesafeApiKey,
    openai: !!creds.openaiApiKey,
  });
  if (!decision.ok) return { ...decision, error: 'jev_credentials_missing' };
  if (decision.provider === 'typesafe')
    return {
      ok: true,
      provider: 'typesafe',
      model: config.decisions.typesafe.model || creds.typesafeModel || DEFAULT_TYPESAFE_MODEL,
      apiKey: creds.typesafeApiKey ?? '',
    };
  return {
    ok: true,
    provider: 'openai',
    model: OPENAI_DECISION_MODEL,
    baseUrl: config.decisions.openai.baseUrl || creds.openaiBaseUrl || DEFAULT_OPENAI_BASE_URL,
    apiKey: creds.openaiApiKey ?? '',
  };
}
export function credentialsForJob(envFile: string, config: JevConfig): DecisionChoice {
  return selectDecisionProvider(config, readCredentialsEnv(envFile));
}
export function proxyForSpawn(captured: Record<string, string | undefined>, home?: string): Record<string, string> {
  try {
    return hostProxyEnv(loadJevConfig({ capturedEnv: captured, home }));
  } catch (error) {
    if (!(error instanceof JevFailure)) throw error;
    return proxyProcessEnv({
      server: firstEnv(captured, ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']),
      bypass: firstEnv(captured, ['no_proxy', 'NO_PROXY']),
    });
  }
}
export function hostProxyEnv(config: JevConfig): Record<string, string> {
  return proxyProcessEnv(config.proxy);
}
export function proxyProcessEnv(proxy: JevProxy): Record<string, string> {
  const hosts = [
    ...new Set([
      '127.0.0.1',
      'localhost',
      ...(proxy.bypass ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ]),
  ];
  return {
    NO_PROXY: hosts.join(','),
    no_proxy: hosts.join(','),
    ...(proxy.server ? { HTTPS_PROXY: proxy.server, https_proxy: proxy.server } : {}),
  };
}
export function chromeProxyFlags(proxy: JevProxy): string[] {
  if (!proxy.server?.trim()) return [];
  const hosts = (proxy.bypass ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [`--proxy-server=${proxy.server.trim()}`, ...(hosts.length ? [`--proxy-bypass-list=${hosts.join(';')}`] : [])];
}
function resolveProxy(json: Record<string, unknown>, env: Record<string, string | undefined>): JevProxy {
  const proxy = object(json.proxy ?? {}, 'jev.proxy');
  return {
    server:
      typeof proxy.server === 'string' && proxy.server.trim()
        ? proxy.server.trim()
        : firstEnv(env, ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']),
    bypass:
      typeof proxy.bypass === 'string' && proxy.bypass.trim()
        ? proxy.bypass.trim()
        : firstEnv(env, ['no_proxy', 'NO_PROXY']),
  };
}
function firstEnv(env: Record<string, string | undefined>, names: string[]): string | undefined {
  for (const name of names) if (env[name]?.trim()) return env[name]!.trim();
  return undefined;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new JevFailure('config', `${name} must be an object`);
  return value as Record<string, unknown>;
}
function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new JevFailure('config', `${name} must be a non-negative number`);
  return value;
}
