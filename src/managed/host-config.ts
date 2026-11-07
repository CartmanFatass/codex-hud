import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexManagedAdapterFactory } from '../harness/codex/managed-adapter.js';
import { ClaudeSdkAdapterFactory } from '../harness/claude/sdk-adapter.js';
import { createPiAdapterFactory } from '../harness/pi/rpc-adapter.js';
import type { HostProfile } from './host.js';
import type { ManagedHarness } from './types.js';
export interface NativeProfile {
  id: string;
  harness: ManagedHarness;
  executable?: string;
  args?: string[];
  env?: Record<string, string>;
  options?: Record<string, unknown>;
}
export interface NativeHostConfig {
  version: 1;
  profiles: NativeProfile[];
}
export function validateNativeHostConfig(value: unknown): NativeHostConfig {
  const config = value as NativeHostConfig;
  if (!config || config.version !== 1 || !Array.isArray(config.profiles)) throw new Error('invalid_native_config');
  const ids = new Set<string>();
  for (const profile of config.profiles) {
    if (
      !profile ||
      typeof profile.id !== 'string' ||
      !profile.id ||
      ids.has(profile.id) ||
      !['codex', 'claude', 'pi'].includes(profile.harness)
    )
      throw new Error('invalid_native_profile');
    ids.add(profile.id);
    if (
      profile.executable !== undefined &&
      (typeof profile.executable !== 'string' || !profile.executable || profile.executable.includes('\0'))
    )
      throw new Error('invalid_native_executable');
    if (
      profile.args !== undefined &&
      (!Array.isArray(profile.args) || profile.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))
    )
      throw new Error('invalid_native_args');
    if (
      profile.env !== undefined &&
      (!profile.env ||
        typeof profile.env !== 'object' ||
        Object.values(profile.env).some((item) => typeof item !== 'string'))
    )
      throw new Error('invalid_native_env');
    if (
      profile.options !== undefined &&
      (!profile.options || typeof profile.options !== 'object' || Array.isArray(profile.options))
    )
      throw new Error('invalid_native_options');
  }
  return config;
}
export function loadNativeHostConfig(home: string): NativeHostConfig {
  const path = join(home, 'native.json');
  return existsSync(path)
    ? validateNativeHostConfig(JSON.parse(readFileSync(path, 'utf8')))
    : {
        version: 1,
        profiles: [
          { id: 'codex', harness: 'codex' },
          { id: 'claude', harness: 'claude' },
          { id: 'pi', harness: 'pi' },
        ],
      };
}
export function nativeProfiles(home: string, config = loadNativeHostConfig(home)): HostProfile[] {
  return config.profiles.map((profile) => {
    const env = { ...process.env, ...profile.env } as Record<string, string>;
    // Only identities which would impersonate the calling native session are removed.
    for (const key of [
      'HUD_CALLER_ID',
      'HUD_CONTEXT_ID',
      'HUD_CONTEXT_GENERATION',
      'HUD_MCP_PROFILE',
      'HUD_CLAUDE_HOOK_CONFIG',
      'HUD_PI_EVIDENCE_FD',
    ])
      delete env[key];
    const options = profile.options ?? {};
    switch (profile.harness) {
      case 'codex':
        return {
          id: profile.id,
          factory: new CodexManagedAdapterFactory({
            ...options,
            executable: profile.executable ?? 'codex',
            args: profile.args,
            env,
          }),
        };
      case 'claude':
        return {
          id: profile.id,
          factory: new ClaudeSdkAdapterFactory({
            sdkOptions: {
              ...options,
              env,
              ...(profile.executable ? { pathToClaudeCodeExecutable: profile.executable } : {}),
            },
          }),
        };
      case 'pi':
        return {
          id: profile.id,
          factory: createPiAdapterFactory({
            ...options,
            cliPath: profile.executable ?? 'pi',
            args: profile.args,
            env,
          }),
        };
    }
  });
}
