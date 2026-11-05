import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { loadDelegateConfig, validateDelegateConfig } from './config.js';
import { LinuxProcessReader } from './process.js';
import { FileCallerRegistry, MemoryCallerRegistry, registerCaller } from './registry.js';
import { createLedgerCallerRegistry } from './ledger-registry.js';
import { SessionRefResolver } from './resolvers.js';
import { HudMcpServer, serveStdioProcess } from './server.js';
import { LedgerCallerRegistry } from './ledger-registry.js';
import { ReadOnlyScopeSnapshot } from '../../../src/core/ledger-scope-read.js';
import { DelegationService } from './delegation.js';
import { createShippedCodexCapabilityVerifier } from '../../../src/core/launch/index.js';
import { readHookConfig, selectsClaudeHook } from './hook/record.js';
import { fileURLToPath } from 'node:url';
import { openLedger } from '../../../src/ledger/ledger.js';
import { shippedManifest, verifiedClientTimeout } from '../../../src/cli/capability.js';
import { ParentLifetime } from './lifetime.js';
import { loadCacheConfig } from '../../../src/core/cache-config.js';
import { PiEvidenceChannel } from './pi-channel.js';
const lifetime = new ParentLifetime();
const home = process.env.HUD_HOME;
if (!home || !isAbsolute(home)) throw new Error('HUD_HOME must name an absolute private HUD directory');
// Loaded once per process: advice is a pure lookup, so a change takes effect in the next session.
// An invalid file never stops startup; every advice field stays empty and carries the detail code.
const cache = loadCacheConfig(home);
const file = join(home, 'delegate.json');
const config = existsSync(file) ? loadDelegateConfig(file) : validateDelegateConfig({ version: 1, profiles: [] });
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
  const fakeDirectory = process.env.HUD_MCP_REGISTRY_DIR;
  if (fakeDirectory && !isAbsolute(fakeDirectory)) throw new Error('HUD_MCP_REGISTRY_DIR must be absolute');
  if (!existsSync(join(home, 'ledger.sqlite')) && !fakeDirectory) {
    const directory = lstatSync(home);
    if (
      !directory.isDirectory() ||
      realpathSync(home) !== home ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0
    )
      throw new Error('HUD_HOME must be a private owned directory');
    const initial = await openLedger(join(home, 'ledger.sqlite'));
    await initial.close();
  }
  const registry = existsSync(join(home, 'ledger.sqlite'))
    ? await createLedgerCallerRegistry(home)
    : fakeDirectory
      ? new FileCallerRegistry(fakeDirectory)
      : new MemoryCallerRegistry();
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
  // The identity registry verified this harness instance and source; use its direct
  // binary rather than PATH, a wrapper, profile overrides, or persisted target text.
  let wakeExecutable: string | undefined;
  if (registration.source?.harness === 'codex' && registration.harnessPid) {
    try {
      const before = reader.get(registration.harnessPid);
      const executable = realpathSync(`/proc/${registration.harnessPid}/exe`);
      const after = reader.get(registration.harnessPid);
      if (before.procStart === registration.harnessProcStart && after.procStart === before.procStart)
        wakeExecutable = executable;
    } catch {
      /* Endpoint unavailable is projected as adapter none. */
    }
  }
  const scopes =
    registry instanceof LedgerCallerRegistry ? new ReadOnlyScopeSnapshot(join(home, 'ledger.sqlite')) : undefined;
  const hookConfig = process.env.HUD_CLAUDE_HOOK_CONFIG;
  const hook =
    profile && selectsClaudeHook(profile) && hookConfig && scopes
      ? { config: readHookConfig(hookConfig), scopes }
      : undefined;
  // A release binds reviewed cells to this revision and the exact runtime tuple.
  // This build ships an empty, explicitly unverified matrix.
  const capability = createShippedCodexCapabilityVerifier({
    hudRevision: 'b45-unverified',
    versions: {
      hudRevision: 'b45-unverified',
      harness: 'unverified',
      host: 'none',
      shell: 'none',
      node: process.versions.node,
      platform: process.platform,
      kernel: 'unverified',
      mcpClient: 'unverified',
    },
  });
  // B6 selects timeout numbers by first harness/source match. Never attest a different
  // selected profile, or an ambiguous same-source configuration.
  const timeoutProfiles = config.profiles.filter(
    (p) => p.harness === registration.caller.harness && p.source.root === registration.source?.rootPath
  );
  const waitTimeoutVerified = verifiedClientTimeout({
    manifest: shippedManifest(),
    selected: profile,
    matchingProfiles: timeoutProfiles,
    // No complete parent/client runtime attestation is shipped by this composition.
    // Release/B14 must supply measured startup facts matching T-05-14, not a child's
    // launch cell, HookConfig version declaration, or arbitrary configured timeout.
    actual: null,
  });
  const bodies =
    registry instanceof LedgerCallerRegistry
      ? new DelegationService({
          ledger: registry.ledger,
          home,
          config,
          registration,
          reader,
          capability,
          waitTimeoutVerified,
          wakeExecutable,
          cache,
          hudRunPath: fileURLToPath(new URL('../../../../../../bin/hud-run', import.meta.url)),
        })
      : undefined;
  const server = new HudMcpServer(
    new SessionRefResolver(registration, reader, profile, undefined, hook, scopes, piChannel),
    bodies,
    () => lifetime.alive()
  );
  piChannel?.signal.addEventListener('abort', () => server.shutdown(), { once: true });
  if (piChannel?.signal.aborted) server.shutdown();
  let discardPendingOutput = false;
  let closing: Promise<void> | undefined;
  server.shutdownSignal.addEventListener(
    'abort',
    () => {
      closing ??= bodies?.close();
    },
    { once: true }
  );
  try {
    ({ discardPendingOutput } = await serveStdioProcess(server, () => lifetime.alive()));
  } finally {
    piChannel?.close();
    await (closing ?? bodies?.close());
    if (registry instanceof LedgerCallerRegistry) await registry.ledger.close();
  }
  // All owned stores/waiters are closed; an unread native stdout WriteWrap must not retain the process.
  if (discardPendingOutput) process.exit(0);
} finally {
  piChannel?.close();
}
