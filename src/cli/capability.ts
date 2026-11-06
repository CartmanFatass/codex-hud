import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchProfileDigest } from '../core/capabilities.js';
import { canonicalJson, digest } from '../core/canonical.js';
import { executableIdentity, launchProbeEnvironment } from '../core/launch/fingerprint.js';
import type { CapabilityManifestV1, LaunchCommand, LaunchProfile } from '../core/types/capabilities.js';

import { parseCapabilityManifest, matchesCapability, type CapabilityExpectation } from '../core/capability-manifest.js';
export { matchesCapability, type CapabilityExpectation } from '../core/capability-manifest.js';

/** Release composition must replace this placeholder with the immutable reviewed build identifier. */
export const HUD_REVISION = 'b45-unverified';
/** The same G04 file as the B4 verifier; no configuration, environment, or CLI path selector. */
export function shippedManifest(): CapabilityManifestV1 | null {
  let fd: number | undefined;
  try {
    fd = openSync(
      fileURLToPath(new URL('../core/launch/managed-cells.json', import.meta.url)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 262_144) return null;
    const bytes = Buffer.alloc(262_145);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > 262_144) return null;
    return parseCapabilityManifest(bytes.subarray(0, length));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Startup-only, bounded executable discovery. Never execute shell text or accept a configured version. */
export async function discoverExecutable(command: LaunchCommand, env: NodeJS.ProcessEnv) {
  env = launchProbeEnvironment(env);
  const identity = await executableIdentity(command, env);
  if (!command.argv || !identity.resolved) return { ...identity, version: null };
  // A script/wrapper's --version can dispatch another executable. Its actual
  // target cannot be attested by this bounded native-executable preflight.
  let fd: number | undefined;
  try {
    fd = openSync(identity.resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const header = Buffer.alloc(4);
    if (readSync(fd, header, 0, 4, 0) !== 4 || !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
      return { ...identity, version: null };
  } catch {
    return { ...identity, version: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const output = await new Promise<string | null>((resolve) => {
    execFile(
      identity.resolved!,
      ['--version'],
      { env, timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 8192, encoding: 'utf8' },
      (error, stdout) => resolve(error ? null : stdout.trim())
    );
  });
  // Version output is measured data. It is never printed or used as an executable/command.
  const version = output?.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/)?.[1] ?? null;
  const after = await executableIdentity(command, env);
  if (canonicalJson(after.file) !== canonicalJson(identity.file) || after.resolved !== identity.resolved)
    return { ...after, version: null };
  return { ...identity, version };
}

/** Shared release convention: numbers alone never constitute timeout evidence. */
export function clientTimeoutFingerprint(
  profile: LaunchProfile,
  startup: {
    executable: Awaited<ReturnType<typeof discoverExecutable>>;
    command: LaunchCommand;
    configFingerprint: string;
    helperRevision: string | null;
  }
): string {
  return digest({
    profile: launchProfileDigest(profile),
    ...startup,
    clientToolTimeoutMs: profile.clientToolTimeoutMs,
    responseMarginMs: profile.responseMarginMs,
  });
}

export function verifiedClientTimeout(options: {
  manifest: CapabilityManifestV1 | null;
  selected: LaunchProfile | null;
  matchingProfiles: readonly LaunchProfile[];
  /** Only trusted startup observations supply this; missing proof remains false. */
  actual: CapabilityExpectation | null;
}): boolean {
  const { selected, matchingProfiles, actual } = options;
  return (
    selected !== null &&
    matchingProfiles.length === 1 &&
    matchingProfiles[0] === selected &&
    selected.clientToolTimeoutMs !== null &&
    selected.responseMarginMs > 0 &&
    selected.clientToolTimeoutMs > selected.responseMarginMs &&
    actual !== null &&
    actual.key.harness === selected.harness &&
    actual.key.profileDigest === launchProfileDigest(selected) &&
    actual.key.operation === 'launch' &&
    matchesCapability(options.manifest, actual)
  );
}
