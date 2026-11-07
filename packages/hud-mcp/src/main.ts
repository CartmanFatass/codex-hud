import { JevTools } from './jev-tools.js';
import { nativeParentWakeTarget } from './wake-registration.js';
import type { AuthenticatedToolExtension } from './server.js';
import type { ProcessStamp } from '../../../src/core/types/supervision.js';
import { NativeManagedTools } from './managed-tools.js';
import { NativeHostClient } from '../../../src/managed/host-ipc.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { loadNativeSourceConfig, validateNativeSourceConfig } from './config.js';
import { LinuxProcessReader } from './process.js';
import { MemoryCallerRegistry, registerCaller } from './registry.js';
import { SessionRefResolver } from './resolvers.js';
import { HudMcpServer, serveStdioProcess } from './server.js';
import { readHookConfig, selectsClaudeHook } from './hook/record.js';
import { ParentLifetime } from './lifetime.js';
import { PiEvidenceChannel } from './pi-channel.js';
const lifetime = new ParentLifetime();
const home = process.env.HUD_HOME;
if (!home || !isAbsolute(home)) throw new Error('HUD_HOME must name an absolute private HUD directory');
const file = join(home, 'delegate.json');
const config = existsSync(file)
  ? loadNativeSourceConfig(file)
  : validateNativeSourceConfig({ version: 1, profiles: [] });
const profileName = process.env.HUD_MCP_PROFILE;
const profile = config.profiles.find((p) => p.name === profileName) ?? null;
if (profileName && !profile) throw new Error('HUD_MCP_PROFILE is not present in delegate.json');
const reader = new LinuxProcessReader();
const piChannel =
  profile?.harness === 'pi' && profile.callSource?.kind === 'pi_extension_v1'
    ? PiEvidenceChannel.inherited()
    : undefined;
try {
  const piHost = piChannel && profile ? await piChannel.bindHost(reader, profile.source.root) : undefined;
  // Native sources are observed per call, not authorized by a HUD database.
  const directory = lstatSync(home);
  if (
    !directory.isDirectory() ||
    realpathSync(home) !== home ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error('HUD_HOME must be a private owned directory');
  const registry = new MemoryCallerRegistry();
  const registration = await registerCaller({
    reader,
    registry,
    profile,
    piHost,
    pid: process.pid,
    cwd: () => process.cwd(),
    envPane: process.env.HERDR_PANE_ID ?? null,
    nowMs: Date.now(),
  });
  const hookConfig = process.env.HUD_CLAUDE_HOOK_CONFIG;
  const hook = profile && selectsClaudeHook(profile) && hookConfig ? { config: readHookConfig(hookConfig) } : undefined;
  const client = new NativeHostClient(home);
  const extensions = [new NativeManagedTools(client), new JevTools(client)];
  const nativeTools: AuthenticatedToolExtension = {
    tools: extensions.flatMap((extension) => extension.tools),
    async invoke(source, name, args, signal) {
      let wake: unknown;
      let stamp: ProcessStamp | null = null;
      let executable: string | undefined;
      try {
        if (registration.harnessPid && registration.harnessProcStart) {
          const before = reader.get(registration.harnessPid);
          const domain = reader.domain();
          if (before.procStart === registration.harnessProcStart) {
            stamp = {
              pid: before.pid,
              proc_start: before.procStart,
              boot_id: domain.bootId,
              pid_domain: domain.pidDomain,
            };
            if (source.sessionRef.harness === 'codex') executable = realpathSync(`/proc/${before.pid}/exe`);
            if (reader.get(before.pid).procStart !== before.procStart) {
              stamp = null;
              executable = undefined;
            }
          }
        }
        wake = await client.invoke(
          source.sessionRef,
          'wake_register',
          { target: nativeParentWakeTarget(source.sessionRef, registration, home!, stamp, executable) },
          signal
        );
      } catch (error) {
        wake = { unavailable: error instanceof Error ? error.message : String(error) };
      }
      const extension = extensions.find((extension) => extension.tools.some((tool) => tool.name === name));
      if (!extension) throw new Error('unknown_native_tool');
      const result = await extension.invoke(source, name, args, signal);
      const created =
        name === 'managed_create'
          ? (result as { value?: { connectionId?: string; throughSeq?: number } }).value
          : undefined;
      return {
        ...(result as Record<string, unknown>),
        wake,
        ...(source.sessionRef.harness === 'claude'
          ? {
              backgroundWaiter: {
                argv: [
                  'hud',
                  'run',
                  'wait',
                  '--native-owner',
                  JSON.stringify(source.sessionRef),
                  ...(created?.connectionId
                    ? ['--connection', created.connectionId, '--after-seq', String(created.throughSeq ?? 0)]
                    : []),
                  '--notify',
                ],
                instruction:
                  'Start this command using the native background-task facility to receive a notification. Ordinary MCP replies do not wake Claude. Reuse the last observed throughSeq with --after-seq for later waiters; never advance past an unread result.',
              },
            }
          : {}),
      };
    },
  };
  const server = new HudMcpServer(
    new SessionRefResolver(registration, reader, profile, undefined, hook, undefined, piChannel),
    undefined,
    () => lifetime.alive(),
    undefined,
    nativeTools
  );
  piChannel?.signal.addEventListener('abort', () => server.shutdown(), { once: true });
  if (piChannel?.signal.aborted) server.shutdown();
  let discardPendingOutput = false;
  try {
    ({ discardPendingOutput } = await serveStdioProcess(server, () => lifetime.alive()));
  } finally {
    piChannel?.close();
  }
  // All owned stores/waiters are closed; an unread native stdout WriteWrap must not retain the process.
  if (discardPendingOutput) process.exit(0);
} finally {
  piChannel?.close();
}
