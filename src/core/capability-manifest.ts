import { capabilityKey, capabilitySupport } from './capabilities.js';
import { canonicalJson } from './canonical.js';
import type { CapabilityKey, CapabilityManifestV1, CapabilityVersions } from './types/capabilities.js';

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
    !hash(key.profileDigest) ||
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

/** Reject duplicate JSON member names before JSON.parse can discard contradictory evidence.
 * The scanner is bounded by the caller's byte limit and a fixed nesting limit.
 */
export function parseStrictJson(bytes: Buffer, limit: number): unknown {
  if (bytes.length > limit) throw new Error('json_size_limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let at = 0;
  const white = () => {
    while (/^[ \t\r\n]$/.test(text[at] ?? '')) at++;
  };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '\\') {
        at++;
        continue;
      }
      if (char === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new Error('json_string');
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error('json_depth');
    white();
    if (text[at] === '{') {
      at++;
      white();
      const keys = new Set<string>();
      if (text[at] === '}') {
        at++;
        return;
      }
      for (;;) {
        white();
        if (text[at] !== '"') throw new Error('json_key');
        const key = string();
        if (keys.has(key)) throw new Error('duplicate_json_key');
        keys.add(key);
        white();
        if (text[at++] !== ':') throw new Error('json_colon');
        value(depth + 1);
        white();
        const next = text[at++];
        if (next === '}') return;
        if (next !== ',') throw new Error('json_object');
      }
    }
    if (text[at] === '[') {
      at++;
      white();
      if (text[at] === ']') {
        at++;
        return;
      }
      for (;;) {
        value(depth + 1);
        white();
        const next = text[at++];
        if (next === ']') return;
        if (next !== ',') throw new Error('json_array');
      }
    }
    if (text[at] === '"') {
      string();
      return;
    }
    const literal = text.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/);
    if (!literal) throw new Error('json_value');
    at += literal[0].length;
  };
  value(0);
  white();
  if (at !== text.length) throw new Error('json_trailing');
  return JSON.parse(text);
}

/** One bad sibling or duplicate capability key invalidates the entire envelope. */
export function validCapabilityManifest(value: unknown): value is CapabilityManifestV1 {
  try {
    const manifest = value as CapabilityManifestV1;
    if (
      !record(manifest) ||
      !fields(manifest, ['version', 'hudRevision', 'cells']) ||
      manifest.version !== 1 ||
      !Array.isArray(manifest.cells) ||
      manifest.cells.length > 128 ||
      Buffer.byteLength(JSON.stringify(manifest)) > 262_144 ||
      !(manifest.hudRevision === null ? manifest.cells.length === 0 : typeof manifest.hudRevision === 'string') ||
      !manifest.cells.every((cell) => validCell(cell, manifest.hudRevision))
    )
      return false;
    const keys = manifest.cells.map((cell) => capabilityKey(cell.key));
    return new Set(keys).size === keys.length;
  } catch {
    return false;
  }
}
export function parseCapabilityManifest(bytes: Buffer): CapabilityManifestV1 | null {
  try {
    const value = parseStrictJson(bytes, 262_144);
    return validCapabilityManifest(value) ? value : null;
  } catch {
    return null;
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
      !validCapabilityManifest(manifest) ||
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
