import { parseLimits } from '../../../src/core/link/limits.js';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { validateLaunchCommand } from '../../../src/core/capabilities.js';
import type { DelegateConfig } from '../../../src/core/types/capabilities.js';
import { Refusal } from './errors.js';
import { object, readJson } from './io.js';

export type { DelegateConfig, DelegateProfile } from '../../../src/core/types/capabilities.js';
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !v.includes('\0');
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
function keys(o: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (
    required.some((k) => !Object.hasOwn(o, k)) ||
    Object.keys(o).some((k) => !required.includes(k) && !optional.includes(k))
  )
    bad();
}
function bad(): never {
  throw new Refusal('configuration_invalid');
}
function command(value: unknown, nullable: boolean): void {
  if (nullable && value === null) return;
  if (!object(value) || !validateLaunchCommand(value)) bad();
  keys(value, Object.hasOwn(value, 'argv') ? ['argv'] : ['shell', 'shellPath']);
}
export const RETIRE_DEFAULTS = Object.freeze({
  afterReportMs: 600000,
  reviewerAfterReportMs: 120000,
  idleMs: 3600000,
  blockedWaitMs: 3600000,
  maxRunMs: 14400000,
});
function defaults(value: unknown, fallback: Record<string, number>, min: number, max: number) {
  if (value === undefined) return { ...fallback };
  if (!object(value)) bad();
  keys(value, [], Object.keys(fallback));
  for (const item of Object.values(value))
    if (!Number.isSafeInteger(item) || (item as number) < min || (item as number) > max) bad();
  return { ...fallback, ...value };
}
/** Configuration only; managedShellVerified is not a product capability gate. */
export function validateDelegateConfig(value: unknown): DelegateConfig {
  value = structuredClone(value);
  if (!object(value)) bad();
  keys(value, ['version', 'profiles'], ['limits', 'wake']);
  try {
    value.limits = parseLimits(value.limits);
  } catch {
    bad();
  }
  value.wake = defaults(value.wake, { recoveryMs: 30000 }, 1, 2147483647);
  if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 128) bad();
  const names = new Set<string>();
  for (const p of value.profiles) {
    if (!object(p)) bad();
    keys(
      p,
      [
        'name',
        'harness',
        'source',
        'launch',
        'headless',
        'resume',
        'resumeHeadless',
        'host',
        'env',
        'mcpServerName',
        'claimTransport',
        'clientToolTimeoutMs',
        'responseMarginMs',
        'orphan_policy',
        'managedShellVerified',
      ],
      ['roles', 'callSource', 'retire']
    );
    p.retire = defaults(p.retire, RETIRE_DEFAULTS, 0, 2147483647);
    if ((p.retire as Record<string, number>).maxRunMs < 1) bad();
    if (!text(p.name) || names.has(p.name) || !['claude', 'codex', 'pi'].includes(p.harness as string)) bad();
    names.add(p.name);
    if (!object(p.source)) bad();
    keys(p.source, ['root', 'label']);
    if (!text(p.source.root) || !isAbsolute(p.source.root) || !text(p.source.label)) bad();
    try {
      const canonicalRoot = realpathSync(p.source.root);
      if (!statSync(canonicalRoot).isDirectory()) bad();
      p.source.root = canonicalRoot;
    } catch {
      bad();
    }
    command(p.launch, false);
    for (const key of ['headless', 'resume', 'resumeHeadless']) command(p[key], true);
    if (!object(p.host)) bad();
    keys(p.host, ['kind', 'layout']);
    if (
      !['herdr', 'tmux', 'none'].includes(p.host.kind as string) ||
      !['tab', 'split', 'pane', 'none'].includes(p.host.layout as string)
    )
      bad();
    if ((p.host.kind === 'none') !== (p.host.layout === 'none')) bad();
    if (!object(p.env) || Object.values(p.env).some((v) => typeof v !== 'string' || v.includes('\0'))) bad();
    if (!text(p.mcpServerName) || !['config_env', 'launch_message'].includes(p.claimTransport as string)) bad();
    if (p.clientToolTimeoutMs !== null && !integer(p.clientToolTimeoutMs)) bad();
    if (
      !integer(p.responseMarginMs) ||
      (typeof p.clientToolTimeoutMs === 'number' && (p.responseMarginMs as number) >= p.clientToolTimeoutMs)
    )
      bad();
    if (!['continue', 'stop'].includes(p.orphan_policy as string) || typeof p.managedShellVerified !== 'boolean') bad();
    if (p.callSource !== undefined) {
      if (!object(p.callSource)) bad();
      keys(p.callSource, ['kind']);
      if (!(
        (p.harness === 'claude' && p.callSource.kind === 'claude_pre_tool_use_v1') ||
        (p.harness === 'pi' && p.callSource.kind === 'pi_extension_v1')
      ))
        bad();
    }
    if (p.roles !== undefined) {
      if (!object(p.roles)) bad();
      for (const [role, mapping] of Object.entries(p.roles)) {
        if (!text(role) || !object(mapping)) bad();
        keys(mapping, ['model'], ['effort']);
        if (!text(mapping.model) || (mapping.effort !== undefined && !text(mapping.effort))) bad();
      }
    }
  }
  return structuredClone(value) as unknown as DelegateConfig;
}
export function loadDelegateConfig(file: string): DelegateConfig {
  try {
    return validateDelegateConfig(readJson(file, 262144));
  } catch {
    throw new Refusal('configuration_invalid');
  }
}

// The thin host uses only native executable/env/options configuration. Legacy delegate config above is source-registration compatibility, not runtime policy.
export { loadNativeHostConfig, validateNativeHostConfig } from '../../../src/managed/host-config.js';
export type { NativeHostConfig, NativeProfile } from '../../../src/managed/host-config.js';

/** Native source registration only. Historical task/claim/retirement fields are never required or interpreted. */
export function validateNativeSourceConfig(value: unknown): DelegateConfig {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.profiles)) bad();
  const profiles = structuredClone(value.profiles) as Record<string, unknown>[];
  const names = new Set<string>();
  for (const profile of profiles) {
    if (
      !object(profile) ||
      !text(profile.name) ||
      names.has(profile.name) ||
      !['codex', 'claude', 'pi'].includes(profile.harness as string)
    )
      bad();
    names.add(profile.name);
    if (!object(profile.source) || !text(profile.source.root) || !isAbsolute(profile.source.root)) bad();
    try {
      profile.source.root = realpathSync(profile.source.root);
      if (!statSync(profile.source.root as string).isDirectory()) bad();
    } catch {
      bad();
    }
    profile.source.label ??= profile.name;
    if (!text(profile.source.label)) bad();
    profile.env ??= {};
    if (
      !object(profile.env) ||
      Object.values(profile.env).some((item) => typeof item !== 'string' || item.includes('\0'))
    )
      bad();
    profile.mcpServerName ??= 'hud';
    if (!text(profile.mcpServerName)) bad();
    profile.launch ??= { argv: [profile.harness] };
    command(profile.launch, false);
    if (profile.callSource !== undefined) {
      if (
        !object(profile.callSource) ||
        Object.keys(profile.callSource).length !== 1 ||
        !(
          (profile.harness === 'claude' && profile.callSource.kind === 'claude_pre_tool_use_v1') ||
          (profile.harness === 'pi' && profile.callSource.kind === 'pi_extension_v1')
        )
      )
        bad();
    }
  }
  return { version: 1, profiles } as unknown as DelegateConfig;
}
export function loadNativeSourceConfig(file: string): DelegateConfig {
  try {
    return validateNativeSourceConfig(readJson(file, 262144));
  } catch {
    throw new Refusal('configuration_invalid');
  }
}
