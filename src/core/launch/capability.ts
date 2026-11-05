import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capabilityKey, capabilitySupport } from '../capabilities.js';
import { canonicalJson } from '../canonical.js';
import type { CapabilityCell, CapabilityKey, CapabilityManifestV1, CapabilityVersions } from '../types/capabilities.js';
// Importing the data also makes tsc ship it next to the compiled loader.
import shippedCells from './managed-cells.json' with { type: 'json' };
import codexCells from './codex-cells.json' with { type: 'json' };

export interface ManagedCapabilityRequest {
  /** Partial discovery can never be promoted by a shipped production cell. */
  configurationCoverage?: 'partial' | 'complete';
  executableIdentity: { path: string | null; version: string | null };
  key: CapabilityKey;
  sourceId: string;
  profileFingerprint: string;
}
export type CapabilityVerdict = { ok: true; reason: null } | { ok: false; reason: string };
/** Trusted composition dependency, never a field of delegate.json or a model tool argument. */
export interface CapabilityVerifier {
  verify(request: ManagedCapabilityRequest): CapabilityVerdict;
}

export function verifyManagedCapability(
  request: ManagedCapabilityRequest,
  cell: CapabilityCell | null,
  versions: CapabilityVersions
): CapabilityVerdict {
  if (request.configurationCoverage === 'partial') return { ok: false, reason: 'capability_unverified' };
  if (request.key.mode === 'visible') return { ok: false, reason: 'visible_launch_not_in_this_build' };
  try {
    const support = capabilitySupport(cell);
    if (support === 'unsupported') return { ok: false, reason: 'unsupported' };
    if (
      support !== 'verified' ||
      Object.values(versions).some(
        (value) =>
          typeof value !== 'string' || !value || /(?:^|[-/: ])(?:unverified|unknown|pending)(?:$|[-/: ])/i.test(value)
      ) ||
      !cell ||
      !request.executableIdentity?.path ||
      request.executableIdentity.version !== versions.harness ||
      capabilityKey(cell.key) !== capabilityKey(request.key) ||
      !['claude', 'codex', 'pi'].includes(request.key.harness) ||
      cell.sourceId !== request.sourceId ||
      cell.profileFingerprint !== request.profileFingerprint ||
      canonicalJson(cell.versions) !== canonicalJson(versions)
    )
      return { ok: false, reason: 'capability_unverified' };
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: 'capability_unverified' };
  }
}

/**
 * Load a bounded, trusted shipped cell file once. Missing/malformed/revision-mismatched
 * evidence remains unverified. HUD_HOME and delegate.json cannot supply this path.
 * An explicit cellFile is for the trusted application's release/package layout only.
 */
export function createShippedManagedCapabilityVerifier(options: {
  hudRevision: string;
  versions: CapabilityVersions | ((request: ManagedCapabilityRequest) => CapabilityVersions | null);
  cellFile?: string;
}): CapabilityVerifier {
  void shippedCells;
  void codexCells;
  let cells: CapabilityCell[] = [];
  try {
    const fd = openSync(
      options.cellFile ?? fileURLToPath(new URL('./managed-cells.json', import.meta.url)),
      constants.O_RDONLY | constants.O_NONBLOCK
    );
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 262_144) throw new Error('invalid_capability_file');
      const buffer = Buffer.alloc(262_145);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, size);
        if (!count) break;
        size += count;
      }
      if (size > 262_144) throw new Error('capability_file_too_large');
      bytes = buffer.subarray(0, size);
    } finally {
      closeSync(fd);
    }
    // Consult 5 G04: share the manifest contract; runtime evidence checks remain below.
    const envelope: CapabilityManifestV1 = JSON.parse(bytes.toString('utf8'));
    if (
      envelope?.version === 1 &&
      typeof options.hudRevision === 'string' &&
      options.hudRevision.length > 0 &&
      envelope.hudRevision === options.hudRevision &&
      (typeof options.versions === 'function' || options.versions.hudRevision === options.hudRevision) &&
      Array.isArray(envelope.cells) &&
      envelope.cells.length <= 128
    )
      cells = structuredClone(envelope.cells);
  } catch {
    // Configuration parsing never stamps an unverified production cell.
  }
  const versionSource = typeof options.versions === 'function' ? options.versions : structuredClone(options.versions);
  return {
    verify(request) {
      if (request.key.mode === 'visible') return { ok: false, reason: 'visible_launch_not_in_this_build' };
      const matching = cells.filter((cell) => {
        try {
          return capabilityKey(cell.key) === capabilityKey(request.key);
        } catch {
          return false;
        }
      });
      // Ambiguous evidence cannot select a winner.
      const versions = typeof versionSource === 'function' ? versionSource(request) : versionSource;
      if (!versions || versions.hudRevision !== options.hudRevision)
        return { ok: false, reason: 'capability_unverified' };
      return verifyManagedCapability(request, matching.length === 1 ? matching[0] : null, versions);
    },
  };
}

/** Compatibility APIs retain their original Codex-only boundary. */
export type CodexCapabilityRequest = ManagedCapabilityRequest;
export function verifyCodexCapability(
  request: CodexCapabilityRequest,
  cell: CapabilityCell | null,
  versions: CapabilityVersions
): CapabilityVerdict {
  if (request.key.harness !== 'codex') return { ok: false, reason: 'capability_unverified' };
  return verifyManagedCapability(request, cell, versions);
}
export function createShippedCodexCapabilityVerifier(options: {
  hudRevision: string;
  versions: CapabilityVersions;
  cellFile?: string;
}): CapabilityVerifier {
  const verifier = createShippedManagedCapabilityVerifier({
    ...options,
    cellFile: options.cellFile ?? fileURLToPath(new URL('./codex-cells.json', import.meta.url)),
  });
  return {
    verify(request) {
      return request.key.harness === 'codex'
        ? verifier.verify(request)
        : { ok: false, reason: 'capability_unverified' };
    },
  };
}
