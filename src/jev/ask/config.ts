// Ported from the owner's jev-ask settings and credential loading (design §4.6).
// HUD `config.json` `jev` overrides explicitly selected TOML `[jev]`.
// A blank state directory is an error, never a fresh empty folder.
// Credentials are re-read on each call, with environment overrides for tests/CI.
// Credential values are never written into errors.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as TOML from '@iarna/toml';
import { decideProviderId } from '../decide.js';
import { JevFailure } from './error.js';

export const ASK_MAX_WAIT_MS = 2 * 60 * 60 * 1000;
export const ASK_MAX_WAIT_CAP_MS = 4 * 60 * 60 * 1000;
export const ASK_QUEUE_LIMIT = 4;
export const ASK_LIVE_LIMIT = 8;
export const ASK_ABANDON_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
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
  decisions: {
    provider?: 'openai' | 'typesafe';
    openai: { baseUrl?: string };
    typesafe: { model?: string };
  };
  ask: {
    maxWaitMs: number;
    queueLimit: number;
    liveLimit: number;
    abandonMs: number;
  };
}

export interface LoadJevConfigOptions {
  configJsonPath?: string;
  /**
   * Already-parsed HUD `config.json`, or the `jev` object itself.
   * A HUD object is read from its `jev` key. A bare `[jev]` table is accepted only when `configJsonIsJev` is set.
   */
  configJson?: unknown;
  configJsonIsJev?: boolean;
  tomlPath?: string;
  tomlText?: string;
  /** Environment captured when jev_ask was called. Not `process.env` unless the caller passes that. */
  capturedEnv?: Record<string, string | undefined>;
  /** Home used only to expand a leading `~`. Defaults to the process home. */
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

export function defaultJevTomlPath(home = homedir()): string {
  return path.join(home, '.config', 'jev-ask', 'config.toml');
}

export function defaultJevEnvPath(home = homedir()): string {
  return path.join(home, '.hud', 'jev.env');
}

export function defaultHudHome(
  env: Record<string, string | undefined> = process.env,
  home = env.HOME || homedir()
): string {
  return env.HUD_HOME || path.join(home, '.hud');
}

export function defaultHudConfigPath(home = homedir()): string {
  return path.join(home, '.hud', 'config.json');
}

export function loadJevConfig(options: LoadJevConfigOptions = {}): JevConfig {
  const home = options.home ?? homedir();
  const sources = {
    ...options,
    configJsonPath: options.configJsonPath ?? path.join(defaultHudHome(options.capturedEnv ?? {}, home), 'config.json'),
    tomlPath: options.tomlPath ?? options.capturedEnv?.JEV_ASK_CONFIG,
  };
  const toml = readToml(sources);
  const json = readJsonJev(sources);
  if (!toml && !json) throw new JevFailure('config', `configuration not found: ${sources.configJsonPath}`);
  const stateDir = requiredStateDir(pickString(json, 'stateDir', toml, 'state_dir', home, true));
  const cdpSeconds = pickNumber(undefined, '', toml, 'jev_cdp_seconds');
  const jsonTimeout = pickNumber(json, 'cdpTimeoutMs', undefined, '');
  return {
    cdpUrl: pickString(json, 'cdpUrl', toml, 'cdp_url', home, false) || DEFAULT_CDP_URL,
    chrome: emptyToUndefined(pickString(json, 'chrome', toml, 'chrome', home, true)),
    profile: emptyToUndefined(pickString(json, 'profile', toml, 'profile', home, true)),
    userAgent: pickString(json, 'userAgent', toml, 'user_agent', home, false) || DEFAULT_USER_AGENT,
    stateDir,
    providerRoot: pickString(json, 'providerRoot', toml, 'provider_root', home, false) || DEFAULT_PROVIDER_ROOT,
    geminiRoot: pickString(json, 'geminiRoot', toml, 'gemini_root', home, false) || DEFAULT_GEMINI_ROOT,
    model: pickString(json, 'model', toml, 'model', home, false) || DEFAULT_MODEL,
    effortWord: pickString(json, 'effortWord', toml, 'effort_word', home, false) || DEFAULT_EFFORT_WORD,
    geminiEffortLabel:
      pickString(json, 'geminiEffortLabel', toml, 'gemini_effort_label', home, false) || DEFAULT_GEMINI_EFFORT_LABEL,
    keepaliveSeconds:
      pickNumber(json, 'keepaliveSeconds', toml, 'gemini_keepalive_seconds') ?? DEFAULT_KEEPALIVE_SECONDS,
    cdpTimeoutMs: jsonTimeout ?? (cdpSeconds !== undefined ? cdpSeconds * 1000 : DEFAULT_CDP_TIMEOUT_MS),
    proxy: resolveProxy(json, toml, options.capturedEnv),
    decisions: resolveDecisions(json),
    ask: resolveAsk(json),
  };
}

/**
 * Read the credential file from disk. No cache: each job calls this again.
 * A missing file yields no keys. The file is opened with `O_NOFOLLOW` and
 * `O_NONBLOCK`, then checked with `fstat` on that descriptor. A symlink cannot be
 * swapped in between the check and the read, and a FIFO is refused instead of
 * blocking the open. A symlink, a non-regular file, or a mode other than 0600
 * is `jev_env_perms`.
 *
 * Line format: optional `export ` prefix, `NAME=VALUE`, and one matching pair of
 * single or double quotes around the value. There is no interpolation.
 */
export function readCredentialsEnv(file: string): JevCredentials {
  const creds: JevCredentials = { textModel: {} };
  for (const [name, value] of readPrivateAssignments(file)) {
    const field = CREDENTIAL_FIELDS[name as keyof typeof CREDENTIAL_FIELDS];
    if (Object.hasOwn(CREDENTIAL_FIELDS, name)) creds[field] = value;
    else if (name.startsWith('TEXT_MODEL_')) creds.textModel[name] = value;
  }
  return creds;
}

function readPrivateAssignments(file: string): Map<string, string> {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return new Map();
    if (code === 'ELOOP' || code === 'EPERM' || code === 'ENOTSUP') {
      throw new JevFailure('jev_env_perms', 'credential file must be a regular file with mode 0600');
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new JevFailure('jev_env_perms', 'credential file must be a regular file with mode 0600');
    }
    const assignments = new Map<string, string>();
    for (const rawLine of fs.readFileSync(fd, 'utf8').split('\n')) {
      const assignment = parseEnvAssignment(rawLine);
      if (assignment) assignments.set(assignment.name, assignment.value);
    }
    return assignments;
  } finally {
    fs.closeSync(fd);
  }
}

/** Compatibility name for callers that explicitly read a legacy file. */
export const readJevEnv = readCredentialsEnv;

const CREDENTIAL_FIELDS = {
  OPENAI_API_KEY: 'openaiApiKey',
  OPENAI_BASE_URL: 'openaiBaseUrl',
  TYPESAFE_API_KEY: 'typesafeApiKey',
  TYPESAFE_MODEL: 'typesafeModel',
  MISTRAL_API_KEY: 'mistralApiKey',
  MISTRAL_BASE_URL: 'mistralBaseUrl',
} as const;

/** Per-name precedence: environment > credentials.env > legacy jev.env. No other tool's files. */
export function readHudCredentials(
  env: Record<string, string | undefined> = process.env,
  hudHome = defaultHudHome(env)
): JevCredentials {
  const legacy = readCredentialsEnv(path.join(hudHome, 'jev.env'));
  const current = readCredentialsEnv(path.join(hudHome, 'credentials.env'));
  const creds: JevCredentials = { ...legacy, ...current, textModel: { ...legacy.textModel, ...current.textModel } };
  for (const [name, field] of Object.entries(CREDENTIAL_FIELDS)) {
    if (env[name] !== undefined) creds[field as (typeof CREDENTIAL_FIELDS)[keyof typeof CREDENTIAL_FIELDS]] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('TEXT_MODEL_') && value !== undefined) creds.textModel[name] = value;
  }
  return creds;
}

/**
 * Choose the decision backend. Explicit `decisions.provider` wins. Otherwise a
 * single present key wins, and both keys default to TypeSafe (owner, 2026-11-07).
 * The same rule is `decideProviderId`. The returned error never includes a key value.
 */
export function selectDecisionProvider(config: JevConfig, creds: JevCredentials): DecisionChoice {
  const decision = decideProviderId(config.decisions.provider, {
    typesafe: Boolean(creds.typesafeApiKey),
    openai: Boolean(creds.openaiApiKey),
  });
  if (!decision.ok) {
    return { ok: false, error: 'jev_credentials_missing', provider: decision.provider, variable: decision.variable };
  }
  if (decision.provider === 'typesafe') {
    return {
      ok: true,
      provider: 'typesafe',
      model: config.decisions.typesafe.model || creds.typesafeModel || DEFAULT_TYPESAFE_MODEL,
      apiKey: creds.typesafeApiKey ?? '',
    };
  }
  return {
    ok: true,
    provider: 'openai',
    model: OPENAI_DECISION_MODEL,
    baseUrl: config.decisions.openai.baseUrl || creds.openaiBaseUrl || DEFAULT_OPENAI_BASE_URL,
    apiKey: creds.openaiApiKey ?? '',
  };
}

/** One job start: read the env file again, then select. */
export function credentialsForJob(envFile: string, config: JevConfig): DecisionChoice {
  return selectDecisionProvider(config, readJevEnv(envFile));
}

/** Names `hud setup --import-jev-env` copies. Anything else in the source is ignored. */
export const IMPORT_ENV_NAMES = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'TYPESAFE_API_KEY', 'TYPESAFE_MODEL'] as const;

/**
 * The Jev install's `.env`, `<root>/.env`, from the jev-ask `[jev].root` the spec names.
 * Explicit import only; no discovery in another tool's home. Job time uses HUD credentials.
 */
export function jevInstallEnvPath(options: { tomlPath?: string; tomlText?: string; home?: string } = {}): string {
  const home = options.home ?? homedir();
  if (!options.tomlPath && options.tomlText === undefined) {
    throw new JevFailure('config', 'import requires --from or JEV_ASK_CONFIG');
  }
  const table = readToml({ tomlPath: options.tomlPath, tomlText: options.tomlText });
  const root = table?.root;
  if (typeof root !== 'string' || !root.trim()) {
    throw new JevFailure('config', 'configuration must name [jev].root to locate the Jev .env');
  }
  return path.join(expandUser(root, home), '.env');
}

/**
 * Merge imported known names into `$HUD_HOME/credentials.env` (0600, temp file then rename).
 * The source is not required to be 0600; `readJevEnv` still refuses that at job time.
 * The returned list is names only.
 */
export function importJevEnv(options: {
  hudHome: string;
  from?: string;
  home?: string;
  tomlPath?: string;
  tomlText?: string;
}): { file: string; names: string[] } {
  if (!options.hudHome.startsWith('/')) throw new JevFailure('config', 'HUD home must be absolute');
  const source = options.from ?? jevInstallEnvPath(options);
  const copied = readImportSource(source);
  if (copied.length === 0) {
    throw new JevFailure('jev_env_empty', 'no known Jev credential names in source');
  }
  const file = path.join(options.hudHome, 'credentials.env');
  const merged = readPrivateAssignments(file);
  for (const entry of copied) merged.set(entry.name, entry.value);
  // Quotes retain leading/trailing spaces literally; this format never evaluates shell syntax.
  const body = [...merged].map(([name, value]) => `${name}="${value}"`).join('\n') + '\n';
  writePrivate(file, body);
  return { file, names: copied.map((entry) => entry.name) };
}

/** Proxy variables for a runtime child. Config wins, then the captured environment. */
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

/**
 * Environment for the host process (`--use-env-proxy`). `NO_PROXY` always
 * contains `127.0.0.1` and `localhost`, so CDP and `/json/*` stay direct.
 */
export function hostProxyEnv(config: JevConfig): Record<string, string> {
  return proxyProcessEnv(config.proxy);
}

export function proxyProcessEnv(proxy: JevProxy): Record<string, string> {
  const hosts: string[] = [];
  const add = (host: string) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  add('127.0.0.1');
  add('localhost');
  for (const part of (proxy.bypass ?? '').split(',')) add(part.trim());
  const list = hosts.join(',');
  const env: Record<string, string> = { NO_PROXY: list, no_proxy: list };
  if (proxy.server) {
    env.HTTPS_PROXY = proxy.server;
    env.https_proxy = proxy.server;
  }
  return env;
}

/** Chrome's own flags. Bypass entries stay comma-separated in config and semicolon-separated here. */
export function chromeProxyFlags(proxy: JevProxy): string[] {
  const server = proxy.server?.trim();
  if (!server) return [];
  const flags = [`--proxy-server=${server}`];
  const hosts = (proxy.bypass ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (hosts.length) flags.push(`--proxy-bypass-list=${hosts.join(';')}`);
  return flags;
}

function readToml(options: LoadJevConfigOptions): Record<string, unknown> | undefined {
  let text: string | undefined;
  if (options.tomlText !== undefined) text = options.tomlText;
  else if (options.tomlPath) {
    try {
      text = fs.readFileSync(options.tomlPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = TOML.parse(text);
  } catch {
    throw new JevFailure('config', 'configuration must contain a valid [jev] table');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JevFailure('config', 'configuration must contain a valid [jev] table');
  }
  const jev = (parsed as Record<string, unknown>).jev;
  if (!jev || typeof jev !== 'object' || Array.isArray(jev)) {
    throw new JevFailure('config', 'configuration must contain a valid [jev] table');
  }
  return jev as Record<string, unknown>;
}

function readJsonJev(options: LoadJevConfigOptions): Record<string, unknown> | undefined {
  if (options.configJson !== undefined) return jevSection(options.configJson, options.configJsonIsJev === true);
  if (!options.configJsonPath || !fs.existsSync(options.configJsonPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(options.configJsonPath, 'utf8'));
  } catch {
    throw new JevFailure('config', 'config.json must be valid JSON');
  }
  return jevSection(parsed, false);
}

function jevSection(value: unknown, asJev: boolean): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JevFailure('config', 'config.json must be an object');
  }
  const root = value as Record<string, unknown>;
  if (!asJev) {
    if (!Object.prototype.hasOwnProperty.call(root, 'jev')) return undefined;
    if (root.jev === undefined) return undefined;
    return asJevObject(root.jev);
  }
  return asJevObject(root);
}

function asJevObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JevFailure('config', 'config.json jev must be an object');
  }
  return value as Record<string, unknown>;
}

function pickString(
  json: Record<string, unknown> | undefined,
  camel: string,
  toml: Record<string, unknown> | undefined,
  snake: string,
  home: string,
  expandPath: boolean
): string | undefined {
  if (json && camel && Object.prototype.hasOwnProperty.call(json, camel) && json[camel] != null) {
    if (typeof json[camel] !== 'string') throw new JevFailure('config', `${camel} must be a string`);
    return expandPath ? expandUser(json[camel] as string, home) : (json[camel] as string);
  }
  const fromToml = snake ? toml?.[snake] : undefined;
  if (typeof fromToml === 'string') return expandPath ? expandUser(fromToml, home) : fromToml;
  return undefined;
}

function pickNumber(
  json: Record<string, unknown> | undefined,
  camel: string,
  toml: Record<string, unknown> | undefined,
  snake: string
): number | undefined {
  const fromJson = json && camel ? json[camel] : undefined;
  if (typeof fromJson === 'number' && Number.isFinite(fromJson)) return fromJson;
  const fromToml = toml && snake ? toml[snake] : undefined;
  if (typeof fromToml === 'number' && Number.isFinite(fromToml)) return fromToml;
  return undefined;
}

function requiredStateDir(value: string | undefined): string {
  if (value === undefined || !value.trim()) {
    throw new JevFailure('config', '[jev] state_dir must explicitly name the existing shared operation directory');
  }
  return value;
}

function resolveProxy(
  json: Record<string, unknown> | undefined,
  toml: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> | undefined
): JevProxy {
  let server: string | undefined;
  let bypass: string | undefined;
  const raw = json?.proxy;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const proxy = raw as Record<string, unknown>;
    if (typeof proxy.server === 'string') server = proxy.server;
    if (typeof proxy.bypass === 'string') bypass = proxy.bypass;
  }
  // An empty string is not a choice. Python `or` falls through to the next source.
  if (!server?.trim() && typeof toml?.proxy_server === 'string') server = toml.proxy_server;
  if (!bypass?.trim() && typeof toml?.proxy_bypass === 'string') bypass = toml.proxy_bypass;
  if (!server?.trim()) server = firstEnv(env, ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']);
  if (!bypass?.trim()) bypass = firstEnv(env, ['no_proxy', 'NO_PROXY']);
  return { server: server?.trim() || undefined, bypass: bypass?.trim() || undefined };
}

function resolveDecisions(json: Record<string, unknown> | undefined): JevConfig['decisions'] {
  const out: JevConfig['decisions'] = { openai: {}, typesafe: {} };
  const raw = json?.decisions;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const decisions = raw as Record<string, unknown>;
  if (decisions.provider !== undefined) {
    if (decisions.provider !== 'openai' && decisions.provider !== 'typesafe') {
      throw new JevFailure('config', 'decisions.provider must be openai or typesafe');
    }
    out.provider = decisions.provider;
  }
  if (decisions.openai && typeof decisions.openai === 'object' && !Array.isArray(decisions.openai)) {
    const baseUrl = (decisions.openai as Record<string, unknown>).baseUrl;
    if (baseUrl !== undefined && typeof baseUrl !== 'string')
      throw new JevFailure('config', 'decisions.openai.baseUrl must be a string');
    if (typeof baseUrl === 'string' && baseUrl) out.openai.baseUrl = baseUrl;
  }
  if (decisions.typesafe && typeof decisions.typesafe === 'object' && !Array.isArray(decisions.typesafe)) {
    const model = (decisions.typesafe as Record<string, unknown>).model;
    if (model !== undefined && typeof model !== 'string')
      throw new JevFailure('config', 'decisions.typesafe.model must be a string');
    if (typeof model === 'string' && model) out.typesafe.model = model;
  }
  return out;
}

function resolveAsk(json: Record<string, unknown> | undefined): JevConfig['ask'] {
  const ask: JevConfig['ask'] = {
    maxWaitMs: ASK_MAX_WAIT_MS,
    queueLimit: ASK_QUEUE_LIMIT,
    liveLimit: ASK_LIVE_LIMIT,
    abandonMs: ASK_ABANDON_MS,
  };
  const raw = json?.ask;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ask;
  const table = raw as Record<string, unknown>;
  if (table.maxWaitMs !== undefined) ask.maxWaitMs = finiteNumber(table.maxWaitMs, 'ask.maxWaitMs');
  if (table.queueLimit !== undefined) ask.queueLimit = finiteNumber(table.queueLimit, 'ask.queueLimit');
  if (table.liveLimit !== undefined) ask.liveLimit = finiteNumber(table.liveLimit, 'ask.liveLimit');
  if (table.abandonMs !== undefined) ask.abandonMs = finiteNumber(table.abandonMs, 'ask.abandonMs');
  if (ask.maxWaitMs > ASK_MAX_WAIT_CAP_MS) ask.maxWaitMs = ASK_MAX_WAIT_CAP_MS;
  return ask;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new JevFailure('config', `${name} must be a non-negative number`);
  }
  return value;
}

function firstEnv(env: Record<string, string | undefined> | undefined, names: string[]): string | undefined {
  if (!env) return undefined;
  for (const name of names) {
    const value = env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function expandUser(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

function parseEnvAssignment(rawLine: string): { name: string; value: string } | null {
  let line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;
  if (line.startsWith('export ') || line.startsWith('export\t')) line = line.slice('export'.length).trim();
  const eq = line.indexOf('=');
  if (eq <= 0) return null;
  const name = line.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  return { name, value: unquoteEnv(line.slice(eq + 1).trim()) };
}

function unquoteEnv(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}

function importableName(name: string): boolean {
  if ((IMPORT_ENV_NAMES as readonly string[]).includes(name)) return true;
  return /^TEXT_MODEL_[A-Z0-9_]+$/.test(name);
}

/** Source files are not always 0600. Symlinks and FIFOs are still refused. Values never enter errors. */
function readImportSource(file: string): Array<{ name: string; value: string }> {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new JevFailure('config', 'Jev .env was not found');
    if (code === 'ELOOP' || code === 'EPERM' || code === 'ENOTSUP' || code === 'ENXIO') {
      throw new JevFailure('jev_env_perms', 'Jev .env must be a regular file');
    }
    throw new JevFailure('config', 'Jev .env could not be read');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new JevFailure('jev_env_perms', 'Jev .env must be a regular file');
    const found = new Map<string, string>();
    for (const rawLine of fs.readFileSync(fd, 'utf8').split('\n')) {
      const assignment = parseEnvAssignment(rawLine);
      if (!assignment || !importableName(assignment.name)) continue;
      found.set(assignment.name, assignment.value);
    }
    const ordered: Array<{ name: string; value: string }> = [];
    for (const name of IMPORT_ENV_NAMES) {
      const value = found.get(name);
      if (value !== undefined) ordered.push({ name, value });
    }
    for (const name of [...found.keys()].filter((item) => item.startsWith('TEXT_MODEL_')).sort()) {
      ordered.push({ name, value: found.get(name) ?? '' });
    }
    return ordered;
  } finally {
    fs.closeSync(fd);
  }
}

function writePrivate(file: string, body: string): void {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
