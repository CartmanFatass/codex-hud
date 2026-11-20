import type { ExpProxySnapshot } from './exp-proxy.js';

export const EXP_ACCOUNTS = ['anthropic-api', 'openai-api'] as const;
export type ExpAccount = (typeof EXP_ACCOUNTS)[number];
export interface ExpGrantTerms {
  grantMicros: number;
  renewalDay: number;
  timeZone: string;
  startsAt?: number;
}
export interface ExpGrant extends Omit<ExpGrantTerms, 'startsAt'> {
  enabled: boolean;
  schedule?: { startsAt: number; previous?: ExpGrantTerms };
}
export interface ExpBalance {
  startDate: string;
  endDate: string;
  timeZone: string;
  remainingMicros: number | null;
  billedMicros: number;
  unpriced: number;
  lastCalibration?: { at: string; remainingMicros: number };
}
export interface ExpConfig {
  version: 1;
  codex: { enabled: boolean; aliases: Record<string, string> };
  proxy: { enabled: boolean; profile: string | null; intervalMinutes: number; bindingVersion?: string };
  grants: Record<ExpAccount, ExpGrant>;
}
export interface ExpProfile {
  home: string;
  name: string;
  lastNativeSeenAt?: number;
}
export interface ExpData {
  config: ExpConfig;
  profiles: ExpProfile[];
  proxySnapshot?: ExpProxySnapshot;
  balances?: Partial<Record<ExpAccount, ExpBalance>>;
  unreadable?: true;
}

export type ExpEdit =
  | { field: 'codex-enabled' | 'proxy-enabled'; value: boolean }
  | { field: 'alias'; profile: string; value: string }
  | { field: 'binding'; value: string | null }
  | { field: 'interval'; value: number }
  | { field: 'grant-enabled'; account: ExpAccount; value: boolean }
  | { field: 'grant' | 'renewal' | 'calibration'; account: ExpAccount; value: number }
  | { field: 'zone'; account: ExpAccount; value: string };

export function defaultExpConfig(): ExpConfig {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const grant = { enabled: false, grantMicros: 0, renewalDay: 1, timeZone };
  return {
    version: 1,
    codex: { enabled: false, aliases: {} },
    proxy: { enabled: false, profile: null, intervalMinutes: 15 },
    grants: { 'anthropic-api': { ...grant }, 'openai-api': { ...grant } },
  };
}
export const expInteger = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
export const expMicros = (n: unknown): n is number => expInteger(n, 0, Number.MAX_SAFE_INTEGER);
export function parseExpUsd(text: string): number | undefined {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) return;
  const micros = Number(match[1] + (match[2] ?? '').padEnd(6, '0'));
  return expMicros(micros) ? micros : undefined;
}
export function expUsd(micros: number): string {
  const digits = String(micros).padStart(7, '0');
  return `${digits.slice(0, -6)}.${digits.slice(-6).replace(/0{1,4}$/, '')}`;
}
export function expApproxUsd(micros: number): string {
  const cents = Math.round(Math.abs(micros) / 10_000);
  return cents ? `≈$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` : '≈$0';
}
export function expTimeZone(value: string): boolean {
  if (!/^[a-z0-9_+\-/]{1,64}$/i.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
export const expAlias = (value: string): boolean => value.length <= 80 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
