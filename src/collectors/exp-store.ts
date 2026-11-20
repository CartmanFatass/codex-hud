import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EXP_ACCOUNTS,
  defaultExpConfig,
  expAlias,
  expInteger,
  expMicros,
  expTimeZone,
  type ExpAccount,
  type ExpConfig,
  type ExpData,
  type ExpEdit,
  type ExpGrant,
  type ExpGrantTerms,
  type ExpProfile,
} from '../exp-config.js';
import { expCycle, grantCycle, grantTerms } from '../exp-cycle.js';
import { PROXY_ERRORS, proxyTime, proxyWindows, type ExpProxySnapshot } from '../exp-proxy.js';
import { appendExpEvent, prepareExpDir, readExpBalance } from './exp-ledger.js';
import { expNativePath, readExpNativeSeen } from './exp-native.js';
import { writePrivateFile } from './small-model.js';

const expConfigPath = (hudHome: string) => join(hudHome, 'exp', 'config.json');
export const expProxyPath = (hudHome: string) => join(hudHome, 'exp', 'proxy.json');

/** Directory and marker metadata only. Never read auth.json, config.toml or shell definitions. */
export function knownExpProfiles(env = process.env): ExpProfile[] {
  const home = env.HOME || homedir();
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(home)
      .filter((n) => n === '.codex' || n.startsWith('.codex-'))
      .sort();
  } catch {
    /* An explicit CODEX_HOME can still be available. */
  }
  const candidates = [...names.map((n) => join(home, n)), join(home, '.codex_home'), env.CODEX_HOME];
  const profiles = new Map<string, ExpProfile>();
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      const resolved = fs.realpathSync(candidate);
      if (profiles.has(resolved) || !fs.statSync(resolved).isDirectory()) continue;
      if (
        ['auth.json', 'config.toml'].some((file) =>
          fs.statSync(join(resolved, file), { throwIfNoEntry: false })?.isFile()
        )
      ) {
        profiles.set(resolved, { home: resolved, name: basename(candidate) });
      }
    } catch {
      /* Missing or inaccessible profile. */
    }
  }
  return [...profiles.values()];
}

function expConfigFile(hudHome: string): { config: ExpConfig; savedAt?: number } {
  let fd: number;
  try {
    fd = fs.openSync(expConfigPath(hudHome), 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: defaultExpConfig() };
    throw err;
  }
  try {
    return { config: parseExpConfig(fs.readFileSync(fd, 'utf8')), savedAt: fs.fstatSync(fd).mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

export const readExpConfig = (hudHome: string): ExpConfig => expConfigFile(hudHome).config;

export async function readExpConfigAsync(hudHome: string): Promise<ExpConfig> {
  return parseExpConfig(await fs.promises.readFile(expConfigPath(hudHome), 'utf8'));
}

function parseExpConfig(raw: string): ExpConfig {
  const config = JSON.parse(raw) as ExpConfig;
  const validTime = (at: unknown) => expInteger(at, 0, 8.64e15);
  const validTerms = (terms: ExpGrantTerms | undefined) =>
    expMicros(terms?.grantMicros) &&
    expInteger(terms?.renewalDay, 1, 31) &&
    typeof terms?.timeZone === 'string' &&
    expTimeZone(terms.timeZone) &&
    (terms.startsAt === undefined || validTime(terms.startsAt));
  const aliases = config?.codex?.aliases;
  if (
    config?.version !== 1 ||
    typeof config.codex?.enabled !== 'boolean' ||
    !aliases ||
    typeof aliases !== 'object' ||
    Array.isArray(aliases) ||
    !Object.values(aliases).every((a) => typeof a === 'string' && expAlias(a)) ||
    typeof config.proxy?.enabled !== 'boolean' ||
    !(
      config.proxy.profile === null ||
      (typeof config.proxy.profile === 'string' && isAbsolute(config.proxy.profile))
    ) ||
    (config.proxy.bindingVersion !== undefined &&
      !(typeof config.proxy.bindingVersion === 'string' && /^[a-f0-9-]{36}$/.test(config.proxy.bindingVersion))) ||
    !expInteger(config.proxy.intervalMinutes, 5, 60) ||
    !EXP_ACCOUNTS.every((account) => {
      const grant = config.grants?.[account];
      const schedule = grant?.schedule;
      return (
        typeof grant?.enabled === 'boolean' &&
        validTerms(grant) &&
        (schedule === undefined ||
          (schedule &&
            validTime(schedule.startsAt) &&
            (schedule.previous === undefined || validTerms(schedule.previous))))
      );
    })
  )
    throw new Error('Invalid EXP configuration');
  return config;
}

export const proxyBindingVersion = (proxy: ExpConfig['proxy']) => proxy.bindingVersion ?? 'legacy';

export function parseProxySnapshot(raw: string, proxy: ExpConfig['proxy']): ExpProxySnapshot | undefined {
  if (!proxy.enabled || !proxy.profile) return;
  const bindingVersion = proxyBindingVersion(proxy);
  try {
    const data = JSON.parse(raw) as ExpProxySnapshot;
    if (
      data?.profile !== proxy.profile ||
      data.bindingVersion !== bindingVersion ||
      (data.observedAtMs !== null && !proxyTime(data.observedAtMs)) ||
      (data.error !== null && !PROXY_ERRORS.includes(data.error)) ||
      !expInteger(data.failures, 0, Number.MAX_SAFE_INTEGER) ||
      (data.nextAttemptMs !== null && !proxyTime(data.nextAttemptMs))
    )
      return;
    const { observedAtMs, error, failures, nextAttemptMs } = data;
    return {
      profile: proxy.profile,
      bindingVersion,
      observedAtMs,
      error,
      failures,
      nextAttemptMs,
      ...proxyWindows(data),
    };
  } catch {
    return;
  }
}

const legacySavedAt = (grant: ExpGrant, savedAt?: number) => (grant.enabled && !grant.schedule ? savedAt : undefined);

export function readExpGrantBalance(hudHome: string, account: ExpAccount, now: number, enabledOnly = false) {
  const { config, savedAt } = expConfigFile(hudHome);
  const grant = config.grants[account];
  if (enabledOnly && !grant.enabled) return;
  return readExpBalance(hudHome, account, grant, now, legacySavedAt(grant, savedAt));
}

export function readExpData(hudHome: string, env = process.env, now = Date.now()): ExpData {
  const profiles = knownExpProfiles(env);
  try {
    const { config, savedAt } = expConfigFile(hudHome);
    let proxySnapshot: ExpProxySnapshot | undefined;
    if (config.proxy.enabled && config.proxy.profile) {
      try {
        proxySnapshot = parseProxySnapshot(fs.readFileSync(expProxyPath(hudHome), 'utf8'), config.proxy);
      } catch {
        /* No observation yet. */
      }
    }

    const balances: NonNullable<ExpData['balances']> = {};
    for (const account of EXP_ACCOUNTS) {
      const grant = config.grants[account];
      balances[account] = readExpBalance(hudHome, account, grant, now, legacySavedAt(grant, savedAt));
    }
    for (const profile of profiles) {
      const seen = readExpNativeSeen(expNativePath(hudHome, profile.home));
      if (seen !== undefined) profile.lastNativeSeenAt = seen;
    }
    return { config, profiles, proxySnapshot, balances };
  } catch {
    return { config: defaultExpConfig(), profiles, unreadable: true };
  }
}

/** Saves only the edited field against the latest config. A calibration never rewrites configuration. */
export function saveExpEdit(hudHome: string, edit: ExpEdit, nowMs: number, env = process.env): void | Promise<void> {
  const { config, savedAt } = expConfigFile(hudHome);
  for (const account of EXP_ACCOUNTS) {
    const grant = config.grants[account];
    const legacy = legacySavedAt(grant, savedAt);
    if (legacy !== undefined) grant.schedule = { startsAt: expCycle(grant, legacy).end };
  }
  const known = (home: string) => knownExpProfiles(env).some((p) => p.home === home);
  const invalid = () => {
    throw new Error('Invalid EXP setting');
  };
  switch (edit.field) {
    case 'codex-enabled':
      config.codex.enabled = edit.value;
      break;
    case 'proxy-enabled':
      if (config.proxy.enabled !== edit.value) config.proxy.bindingVersion = randomUUID();
      config.proxy.enabled = edit.value;
      break;
    case 'alias':
      if (!known(edit.profile) || !expAlias(edit.value)) invalid();
      if (edit.value) config.codex.aliases[edit.profile] = edit.value;
      else delete config.codex.aliases[edit.profile];
      break;
    case 'binding':
      if (edit.value !== null && !known(edit.value)) invalid();
      config.proxy.profile = edit.value;
      config.proxy.bindingVersion = randomUUID();
      break;
    case 'interval':
      if (!expInteger(edit.value, 5, 60)) invalid();
      config.proxy.intervalMinutes = edit.value;
      break;
    default: {
      if (!EXP_ACCOUNTS.includes(edit.account)) invalid();
      const grant = config.grants[edit.account];
      const changeTerms = (changed: boolean) => {
        if (changed && grant.schedule) {
          grant.schedule = {
            startsAt: grantCycle(grant, nowMs).end,
            previous: grantTerms(grant, nowMs, undefined),
          };
        }
      };
      switch (edit.field) {
        case 'grant-enabled':
          if (edit.value && !grant.schedule) grant.schedule = { startsAt: expCycle(grant, nowMs).end };
          grant.enabled = edit.value;
          break;
        case 'grant':
          if (!expMicros(edit.value)) invalid();
          changeTerms(grant.grantMicros !== edit.value);
          grant.grantMicros = edit.value;
          break;
        case 'renewal':
          if (!expInteger(edit.value, 1, 31)) invalid();
          changeTerms(grant.renewalDay !== edit.value);
          grant.renewalDay = edit.value;
          break;
        case 'zone':
          if (!expTimeZone(edit.value)) invalid();
          changeTerms(grant.timeZone !== edit.value);
          grant.timeZone = edit.value;
          break;
        case 'calibration':
          if (!expMicros(edit.value)) invalid();
          break;
      }
    }
  }
  if (edit.field !== 'calibration') {
    prepareExpDir(hudHome);
    writePrivateFile(expConfigPath(hudHome), JSON.stringify(config, null, 2) + '\n');
    return;
  }
  return appendExpEvent(hudHome, edit.account, {
    type: 'calibration',
    id: randomUUID(),
    at: new Date(nowMs).toISOString(),
    remainingMicros: edit.value,
  });
}
