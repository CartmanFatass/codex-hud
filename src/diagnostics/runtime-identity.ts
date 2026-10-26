/** A startup receipt for one entry file, not a whole-build or Git identity. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isoFact } from './provenance.js';

export interface RuntimeIdentity {
  scope: 'entry-file-at-start';
  appVersion: string | null;
  nodeVersion: string | null;
  platform: string | null;
  entrySha256: string | null;
  capturedAt: string | null;
}
export interface RuntimeIdentityCaptureOptions {
  /** The running entry's import.meta.url, or a filesystem path. Never exported. */
  entryFile: string | URL;
  packageFile?: string | URL;
  nowMs?: number;
}
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PLATFORMS = ['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'android', 'haiku', 'netbsd'];
function fileLocation(value: string | URL): string | URL {
  return typeof value === 'string' && value.startsWith('file:') ? new URL(value) : value;
}
function version(value: unknown): string | null { return typeof value === 'string' && value.length <= 80 && SEMVER.test(value) ? value : null; }

/** Reconstruct untrusted metadata. The explicit scope is never accepted from input. */
export function sanitizeRuntimeIdentity(value: unknown): RuntimeIdentity {
  const source = value as Partial<RuntimeIdentity> | null;
  const capturedAt = typeof source?.capturedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(source.capturedAt)
    ? isoFact(Date.parse(source.capturedAt)) : null;
  return { scope: 'entry-file-at-start', appVersion: version(source?.appVersion), nodeVersion: version(source?.nodeVersion),
    platform: typeof source?.platform === 'string' && PLATFORMS.includes(source.platform) ? source.platform : null,
    entrySha256: typeof source?.entrySha256 === 'string' && /^[0-9a-f]{64}$/.test(source.entrySha256) ? source.entrySha256 : null,
    capturedAt };
}

/**
 * Call once at process startup and retain the result. Export never re-reads it:
 * files replaced later must not be presented as this process's startup receipt.
 * This reads only the entry and package manifest; missing/invalid facts stay null.
 */
export function captureRuntimeIdentity(options: RuntimeIdentityCaptureOptions): RuntimeIdentity {
  let appVersion: unknown = null;
  let entrySha256: string | null = null;
  try {
    const file = fileLocation(options.packageFile ?? new URL('../../package.json', import.meta.url));
    if (fs.statSync(file).size <= 64 * 1024) appVersion = JSON.parse(fs.readFileSync(file, 'utf8')).version;
  } catch { /* Unknown package identity. */ }
  try {
    const file = fileLocation(options.entryFile);
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.size <= 8 * 1024 * 1024) entrySha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch { /* Unknown entry identity. */ }
  return Object.freeze(sanitizeRuntimeIdentity({ appVersion, nodeVersion: process.versions.node, platform: process.platform,
    entrySha256, capturedAt: isoFact(options.nowMs ?? Date.now()) }));
}
