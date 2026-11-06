import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { discoverExecutable } from '../../../src/cli/capability.js';
import { launchProfileDigest } from '../../../src/core/capabilities.js';
import { canonicalJson, digest } from '../../../src/core/canonical.js';
import { matchesCapability, type CapabilityExpectation } from '../../../src/core/capability-manifest.js';
import { makeSourceId } from '../../../src/core/identity.js';
import { observeRuntimeBuild } from '../../../src/core/runtime-build.js';
import { launchProbeEnvironment } from '../../../src/core/launch/fingerprint.js';
import type { CapabilityVerifier, ManagedCapabilityRequest } from '../../../src/core/launch/capability.js';
import type { DelegateConfig, LaunchProfile } from '../../../src/core/types/capabilities.js';
import type { Registration } from './registry.js';
import { actualSourceRoot, inferHarness, type ProcessReaderPort } from './process.js';

export const MANAGED_NATIVE_TOPOLOGY = 'codex-direct-stdio/headless-argv-v1';
const VERSION = '0.166.0';
const BOOTSTRAP = ['/usr/bin/env', '/usr/bin/mkfifo', '/bin/sh'] as const;
const installedRoot = fileURLToPath(new URL('../../../../../../', import.meta.url)).replace(/\/$/, '');
type Observation = Awaited<ReturnType<typeof discoverExecutable>>;
export interface ManagedRuntimeInput {
  registration: Registration;
  reader: ProcessReaderPort;
  config: DelegateConfig;
  selected: LaunchProfile | null;
  env: NodeJS.ProcessEnv;
}

function bootstrapFile(path: string) {
  const canonicalPath = realpathSync(path);
  const fd = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const identity = (stat: NonNullable<ReturnType<typeof lstatSync>>) => ({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 2 * 1024 * 1024) throw new Error('bootstrap_file');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (
      length !== before.size ||
      canonicalJson(identity(fstatSync(fd))) !== canonicalJson(identity(before)) ||
      realpathSync(path) !== canonicalPath ||
      canonicalJson(identity(lstatSync(canonicalPath))) !== canonicalJson(identity(before))
    )
      throw new Error('bootstrap_changed');
    return {
      path,
      canonicalPath,
      sha256: createHash('sha256').update(bytes.subarray(0, length)).digest('hex'),
      identity: identity(before),
    };
  } finally {
    closeSync(fd);
  }
}

/** Trusted construction seam for isolated SIMULATED fixtures only. Production calls
 * createManagedNativeRuntime below; no config/env/tool argument can select paths or facts.
 */
export class ManagedNativeRuntime {
  private readonly root: string;
  private readonly syntheticRoot: boolean;
  private readonly bootstrapPaths: readonly [string, string, string];
  constructor(root?: string, bootstrapPaths?: readonly [string, string, string]) {
    if (
      bootstrapPaths !== undefined &&
      (root === undefined ||
        root === installedRoot ||
        !Array.isArray(bootstrapPaths) ||
        bootstrapPaths.length !== 3 ||
        bootstrapPaths.some(
          (path) =>
            typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || Buffer.byteLength(path) > 4096
        ))
    )
      throw new Error('invalid_synthetic_bootstrap_paths');
    this.root = root ?? installedRoot;
    this.syntheticRoot = root !== undefined;
    this.bootstrapPaths = Object.freeze([...(bootstrapPaths ?? BOOTSTRAP)]) as readonly [string, string, string];
  }

  async observe(input: ManagedRuntimeInput) {
    const started = performance.now();
    let executingInstalledCode = false;
    try {
      executingInstalledCode =
        realpathSync(fileURLToPath(import.meta.url)) ===
        join(installedRoot, 'packages/hud-mcp/dist/packages/hud-mcp/src/managed-runtime.js');
    } catch {
      /* Missing canonical execution anchor remains unverified. */
    }
    const build = this.syntheticRoot || executingInstalledCode ? observeRuntimeBuild(this.root) : null;
    const manifest = build?.capabilityManifests.get('packages/hud-mcp/dist/src/core/launch/managed-cells.json') ?? null;
    const runtime = {
      node: process.versions.node,
      platform: process.platform,
      kernel: release(),
      architecture: process.arch,
    };
    let probes = 0;
    let parent: { sourceId: string; profileDigest: string; nativeExecutableIdentity: Observation } | null = null;
    let bootstrapFiles: ReturnType<typeof bootstrapFile>[] | null = null;
    let recheckParent: (() => void) | null = null;
    try {
      const { registration: registration, reader, selected, config } = input;
      const caller = registration.caller;
      const source = registration.source;
      if (
        runtime.platform !== 'linux' ||
        !selected ||
        selected.harness !== 'codex' ||
        !source ||
        source.harness !== 'codex' ||
        caller.harness !== 'codex' ||
        caller.sourceId !== source.sourceId ||
        caller.instanceKind !== 'dedicated' ||
        caller.pid !== process.pid ||
        registration.harnessPid !== caller.ppid ||
        registration.harnessProcStart !== caller.parentProcStart ||
        selected.source.root !== source.rootPath ||
        makeSourceId('codex', source.rootPath) !== source.sourceId ||
        !config.profiles.includes(selected) ||
        config.profiles.filter((p) => p.harness === 'codex' && p.source.root === source.rootPath).length !== 1
      )
        throw new Error('parent_unverified');
      const domain = reader.domain();
      const observe = () => {
        const self = reader.get(process.pid);
        const native = reader.get(caller.ppid);
        if (
          self.pid !== caller.pid ||
          self.procStart !== caller.procStart ||
          self.ppid !== caller.ppid ||
          native.pid !== caller.ppid ||
          native.procStart !== caller.parentProcStart ||
          native.pidNamespace !== self.pidNamespace ||
          inferHarness(native) !== 'codex' ||
          actualSourceRoot(native, 'codex') !== source.rootPath ||
          canonicalJson(reader.domain()) !== canonicalJson(domain)
        )
          throw new Error('parent_changed');
        return { self, native, executable: realpathSync(`/proc/${native.pid}/exe`) };
      };
      const before = observe();
      probes++;
      const executable = await discoverExecutable({ argv: [before.executable] }, launchProbeEnvironment(input.env));
      const after = observe();
      if (
        canonicalJson(before) !== canonicalJson(after) ||
        executable.resolved !== before.executable ||
        executable.version !== VERSION ||
        !executable.file
      )
        throw new Error('parent_native_unverified');
      parent = {
        sourceId: source.sourceId,
        profileDigest: launchProfileDigest(selected),
        nativeExecutableIdentity: executable,
      };
      bootstrapFiles = this.bootstrapPaths.map(bootstrapFile);
      recheckParent = () => {
        if (canonicalJson(observe()) !== canonicalJson(before)) throw new Error('parent_departed');
        const stat = lstatSync(before.executable);
        if (
          canonicalJson({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }) !==
          canonicalJson(executable.file)
        )
          throw new Error('parent_executable_changed');
      };
    } catch {
      parent = null;
      bootstrapFiles = null;
    }

    // Target observations never supply the parent/client version, even for the same path.
    const launchExecutableIdentities = new Map<string, { path: string; version: string }>();
    const observations = new Map<string, Observation>();
    const targets = new Map<string, { profile: LaunchProfile; operation: 'spawn' | 'resume'; observed: Observation }>();
    for (const profile of input.config.profiles) {
      for (const operation of ['spawn', 'resume'] as const) {
        const command = operation === 'spawn' ? profile.headless : profile.resumeHeadless;
        if (!command?.argv) continue;
        const env = launchProbeEnvironment(input.env, profile.env);
        const key = JSON.stringify([command.argv[0], env]);
        let observed = observations.get(key);
        if (!observed) {
          probes++;
          observed = await discoverExecutable(command, env);
          observations.set(key, observed);
        }
        if (observed.resolved && observed.version) {
          launchExecutableIdentities.set(JSON.stringify([profile.name, operation, 'headless']), {
            path: observed.resolved,
            version: observed.version,
          });
          targets.set(
            JSON.stringify([
              launchProfileDigest({
                ...profile,
                env: Object.fromEntries(
                  Object.entries(profile.env).filter(
                    ([key]) => !['HUD_CLAIM', 'HUD_RUN', 'HUD_LINK', 'HUD_HOME'].includes(key)
                  )
                ),
              }),
              operation,
            ]),
            { profile: structuredClone(profile), operation, observed }
          );
        }
      }
    }
    try {
      recheckParent?.();
    } catch {
      parent = null;
      bootstrapFiles = null;
    }
    // Copy all inputs into the closure. Verification performs only bounded in-memory
    // comparison/hash of the already bounded fingerprint, no file I/O or subprocesses.
    const frozenParent = parent && structuredClone(parent);
    const frozenBootstrap = bootstrapFiles && structuredClone(bootstrapFiles);
    const expectation = (request: ManagedCapabilityRequest): CapabilityExpectation | null => {
      if (
        !build ||
        !frozenParent ||
        !frozenBootstrap ||
        request.configurationCoverage === 'partial' ||
        request.key.harness !== 'codex' ||
        request.key.mode !== 'headless' ||
        request.key.hostKind !== 'none' ||
        request.key.layout !== 'none' ||
        !['spawn', 'resume'].includes(request.key.operation) ||
        (request.key.operation === 'resume' && request.key.resumeFrom !== 'headless') ||
        !/^[a-f0-9]{64}$/.test(request.profileFingerprint)
      )
        return null;
      const target = targets.get(JSON.stringify([request.key.profileDigest, request.key.operation]));
      if (
        !target ||
        target.profile.harness !== 'codex' ||
        target.profile.host.kind !== 'none' ||
        target.profile.host.layout !== 'none' ||
        target.observed.version !== VERSION ||
        !target.observed.file ||
        request.sourceId !== makeSourceId('codex', target.profile.source.root) ||
        request.executableIdentity.path !== target.observed.resolved ||
        request.executableIdentity.version !== VERSION
      )
        return null;
      return {
        key: request.key,
        sourceId: request.sourceId,
        topology: MANAGED_NATIVE_TOPOLOGY,
        profileFingerprint: digest({
          schema: 'managed-native-runtime-v1',
          target: request.profileFingerprint,
          parent: frozenParent,
          architecture: runtime.architecture,
          bootstrapFiles: frozenBootstrap,
        }),
        versions: {
          hudRevision: build.buildId,
          harness: target.observed.version,
          host: 'none',
          shell: 'none',
          node: runtime.node,
          platform: runtime.platform,
          kernel: runtime.kernel,
          mcpClient: frozenParent.nativeExecutableIdentity.version!,
        },
      };
    };
    const capability: CapabilityVerifier = {
      verify(request) {
        if (request.key.mode === 'visible') return { ok: false, reason: 'visible_launch_not_in_this_build' };
        return matchesCapability(manifest, expectation(request))
          ? { ok: true, reason: null }
          : { ok: false, reason: 'capability_unverified' };
      },
    };
    return {
      capability,
      launchExecutableIdentities,
      expectation,
      startup: {
        elapsedMs: performance.now() - started,
        bytes: build?.bytes ?? 0,
        probes,
        buildId: build?.buildId ?? null,
        parentObserved: parent !== null,
        bootstrapObserved: bootstrapFiles !== null,
      },
    };
  }
}

/** Main's sole narrow composition. Fixed installed manifest/cells; no overrides. */
export async function createManagedNativeRuntime(input: ManagedRuntimeInput) {
  return new ManagedNativeRuntime().observe(input);
}
