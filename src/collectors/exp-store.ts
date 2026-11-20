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
  type ExpConfig,
  type ExpData,
  type ExpEdit,
  type ExpProfile,
} from '../exp-config.js';
import { writePrivateFile } from './small-model.js';

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

export function readExpConfig(hudHome: string): ExpConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(join(hudHome, 'exp', 'config.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultExpConfig();
    throw err;
  }
  const config = JSON.parse(raw) as ExpConfig;
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
    !expInteger(config.proxy.intervalMinutes, 5, 60) ||
    !EXP_ACCOUNTS.every((account) => {
      const grant = config.grants?.[account];
      return (
        typeof grant?.enabled === 'boolean' &&
        expMicros(grant.grantMicros) &&
        expInteger(grant.renewalDay, 1, 31) &&
        typeof grant.timeZone === 'string' &&
        expTimeZone(grant.timeZone)
      );
    })
  )
    throw new Error('Invalid EXP configuration');
  return config;
}

export function readExpData(hudHome: string, env = process.env): ExpData {
  const profiles = knownExpProfiles(env);
  try {
    return { config: readExpConfig(hudHome), profiles };
  } catch {
    return { config: defaultExpConfig(), profiles, unreadable: true };
  }
}

/** Saves only the edited field against the latest config. A calibration never rewrites configuration. */
export function saveExpEdit(hudHome: string, edit: ExpEdit, nowMs: number, env = process.env): void {
  const dir = join(hudHome, 'exp');
  const config = readExpConfig(hudHome);
  const known = (home: string) => knownExpProfiles(env).some((p) => p.home === home);
  const invalid = () => {
    throw new Error('Invalid EXP setting');
  };
  switch (edit.field) {
    case 'codex-enabled':
      config.codex.enabled = edit.value;
      break;
    case 'proxy-enabled':
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
      break;
    case 'interval':
      if (!expInteger(edit.value, 5, 60)) invalid();
      config.proxy.intervalMinutes = edit.value;
      break;
    default: {
      if (!EXP_ACCOUNTS.includes(edit.account)) invalid();
      const grant = config.grants[edit.account];
      switch (edit.field) {
        case 'grant-enabled':
          grant.enabled = edit.value;
          break;
        case 'grant':
          if (!expMicros(edit.value)) invalid();
          grant.grantMicros = edit.value;
          break;
        case 'renewal':
          if (!expInteger(edit.value, 1, 31)) invalid();
          grant.renewalDay = edit.value;
          break;
        case 'zone':
          if (!expTimeZone(edit.value)) invalid();
          grant.timeZone = edit.value;
          break;
        case 'calibration':
          if (!expMicros(edit.value)) invalid();
          break;
      }
    }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('EXP directory is not a directory');
  fs.chmodSync(dir, 0o700);
  if (edit.field !== 'calibration') {
    writePrivateFile(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
    return;
  }
  const event = {
    type: 'calibration',
    id: randomUUID(),
    at: new Date(nowMs).toISOString(),
    remainingMicros: edit.value,
  };
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(
    join(dir, `ledger-${edit.account}.jsonl`),
    O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK,
    0o600
  );
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('EXP ledger is not a file');
    fs.fchmodSync(fd, 0o600);
    fs.appendFileSync(fd, JSON.stringify(event) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}
