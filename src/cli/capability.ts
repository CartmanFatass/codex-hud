import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capabilityKey, capabilitySupport, launchProfileDigest } from '../core/capabilities.js';
import { canonicalJson, digest } from '../core/canonical.js';
import { executableIdentity, launchProbeEnvironment } from '../core/launch/fingerprint.js';
import type {
  CapabilityKey,
  CapabilityManifestV1,
  CapabilityVersions,
  LaunchCommand,
  LaunchProfile,
} from '../core/types/capabilities.js';

/** Release composition must replace this placeholder with the immutable reviewed build identifier. */
export const HUD_REVISION = 'b45-unverified';
export interface CapabilityExpectation {
  key: CapabilityKey;
  sourceId: string;
  profileFingerprint: string;
  topology: string;
  versions: CapabilityVersions;
}
const versionKeys = ['hudRevision', 'harness', 'host', 'shell', 'node', 'platform', 'kernel', 'mcpClient'] as const;
const placeholder = (value: string) => !value || /(?:^|[-/: ])(?:unverified|unknown|pending)(?:$|[-/: ])/i.test(value);
const fields = (value: object, names: readonly string[]) =>
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
const record = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validCell(cell: CapabilityManifestV1['cells'][number], revision: string | null): boolean {
  if (
    !fields(cell, [
      'key',
      'support',
      'versions',
      'topology',
      'sourceId',
      'profileFingerprint',
      'evidence',
      'results',
      'incomplete',
    ])
  )
    return false;
  const key = cell.key;
  if (
    !fields(key, [
      'harness',
      'profileDigest',
      'hostKind',
      'layout',
      'mode',
      'operation',
      ...(key.operation === 'resume' ? ['resumeFrom'] : []),
    ]) ||
    !['claude', 'codex', 'pi'].includes(key.harness) ||
    !/^[a-f0-9]{64}$/.test(key.profileDigest) ||
    !['herdr', 'tmux', 'none'].includes(key.hostKind) ||
    !['tab', 'split', 'pane', 'none'].includes(key.layout) ||
    !['visible', 'headless'].includes(key.mode) ||
    !['launch', 'spawn', 'resume'].includes(key.operation) ||
    (key.operation === 'resume' && !['visible', 'headless'].includes(key.resumeFrom)) ||
    (key.hostKind === 'none') !== (key.layout === 'none') ||
    (key.hostKind === 'none' && key.mode !== 'headless') ||
    !['verified', 'unverified', 'unsupported'].includes(cell.support) ||
    !Array.isArray(cell.incomplete) ||
    cell.incomplete.some((item) => typeof item !== 'string')
  )
    return false;
  if (
    (cell.topology !== null && typeof cell.topology !== 'string') ||
    (cell.sourceId !== null && !hash(cell.sourceId)) ||
    (cell.profileFingerprint !== null && !hash(cell.profileFingerprint)) ||
    !record(cell.results) ||
    Object.entries(cell.results).some(
      ([name, value]) =>
        !['identity', 'input', 'scope', 'receipt', 'singleSubmission'].includes(name) ||
        !['passed', 'failed', 'unverified'].includes(value)
    )
  )
    return false;
  if (cell.evidence !== null) {
    const evidence = cell.evidence;
    if (
      !record(evidence) ||
      !fields(evidence, [
        'script',
        'report',
        'reportSha256',
        'artifactDigest',
        'observedAt',
        'reviewStatus',
        'scope',
      ]) ||
      typeof evidence.script !== 'string' ||
      !evidence.script ||
      typeof evidence.report !== 'string' ||
      !evidence.report ||
      !hash(evidence.reportSha256) ||
      !hash(evidence.artifactDigest) ||
      !Number.isFinite(evidence.observedAt) ||
      evidence.observedAt < 0 ||
      !['pending', 'accepted', 'rejected'].includes(evidence.reviewStatus) ||
      !['probe', 'product'].includes(evidence.scope)
    )
      return false;
  }
  if (
    cell.versions !== null &&
    (!fields(cell.versions, versionKeys) ||
      cell.versions.hudRevision !== revision ||
      versionKeys.some((name) => typeof cell.versions![name] !== 'string'))
  )
    return false;
  if (
    cell.support === 'verified' &&
    (capabilitySupport(cell) !== 'verified' || versionKeys.some((name) => placeholder(cell.versions![name])))
  )
    return false;
  return true;
}

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
    return JSON.parse(bytes.subarray(0, length).toString('utf8')) as CapabilityManifestV1;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Full actual-runtime match. A child Codex cell cannot attest a Claude parent timeout. */
export function matchesCapability(
  manifest: CapabilityManifestV1 | null,
  expected: CapabilityExpectation | null
): boolean {
  try {
    if (
      !manifest ||
      !expected ||
      manifest.version !== 1 ||
      !Array.isArray(manifest.cells) ||
      manifest.cells.length > 128 ||
      Buffer.byteLength(JSON.stringify(manifest)) > 262_144 ||
      !manifest.cells.every((cell) => validCell(cell, manifest.hudRevision)) ||
      Object.keys(manifest).sort().join(',') !== 'cells,hudRevision,version' ||
      placeholder(manifest.hudRevision ?? '') ||
      manifest.hudRevision !== expected.versions.hudRevision ||
      versionKeys.some((key) => typeof expected.versions[key] !== 'string' || placeholder(expected.versions[key]))
    )
      return false;
    const keys = manifest.cells.map((cell) => capabilityKey(cell.key));
    if (new Set(keys).size !== keys.length) return false;
    const matching = manifest.cells.filter((cell) => capabilityKey(cell.key) === capabilityKey(expected.key));
    if (matching.length !== 1) return false;
    const cell = matching[0];
    return (
      capabilitySupport(cell) === 'verified' &&
      cell.topology === expected.topology &&
      cell.sourceId === expected.sourceId &&
      cell.profileFingerprint === expected.profileFingerprint &&
      canonicalJson(cell.versions) === canonicalJson(expected.versions)
    );
  } catch {
    return false;
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
