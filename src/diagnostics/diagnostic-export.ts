/** Preview is pure; saving is an explicit action by the caller after showing it. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { diagnosticEvidence, numericFact, type DiagnosticEvidenceInput } from './provenance.js';
import { sanitizeRuntimeIdentity, type RuntimeIdentity } from './runtime-identity.js';
import { MODEL_FEATURES, TELEMETRY_RECORD_LIMIT, TELEMETRY_WINDOW_MS, type ModelTelemetrySummary } from '../collectors/model-telemetry.js';

export interface DiagnosticExportPreview { readonly json: string; readonly bytes: number }
export interface DiagnosticExportInput extends DiagnosticEvidenceInput { telemetry?: ModelTelemetrySummary; runtimeIdentity?: RuntimeIdentity }
const previews = new WeakMap<DiagnosticExportPreview, string>();
const PERSISTENCE = ['memory', 'shared', 'pending', 'unavailable'] as const;

/** Rebuild even typed telemetry; callers may pass untrusted/nested source data. */
function safeTelemetry(summary: ModelTelemetrySummary | undefined) {
  if (!summary) return null;
  return { observedAt: numericFact(summary.observedAt), windowStartedAt: numericFact(summary.windowStartedAt),
    windowMs: TELEMETRY_WINDOW_MS, recordLimit: TELEMETRY_RECORD_LIMIT,
    retained: numericFact(summary.retained), atCapacity: summary.atCapacity === true,
    persistence: PERSISTENCE.includes(summary.persistence) ? summary.persistence : 'unavailable',
    features: MODEL_FEATURES.flatMap(feature => {
      const row = summary.features?.find(item => item.feature === feature);
      if (!row) return [];
      return [{ feature, requests: numericFact(row.requests), pending: numericFact(row.pending),
        successes: numericFact(row.successes), failures: numericFact(row.failures), cacheHits: numericFact(row.cacheHits),
        cancelled: numericFact(row.cancelled), limited: numericFact(row.limited), refused: numericFact(row.refused),
        durationSamples: numericFact(row.durationSamples), meanDurationMs: numericFact(row.meanDurationMs), tokens: null, cost: null }];
    }) };
}

export function createDiagnosticExportPreview(input: DiagnosticExportInput): DiagnosticExportPreview {
  const json = `${JSON.stringify({ schemaVersion: 1,
    privacy: { content: 'excluded', paths: 'excluded', credentials: 'excluded', endpoints: 'excluded', identifiers: 'excluded' },
    runtimeIdentity: sanitizeRuntimeIdentity(input.runtimeIdentity),
    evidence: diagnosticEvidence(input), modelTelemetry: safeTelemetry(input.telemetry),
  }, null, 2)}\n`;
  const preview = Object.freeze({ json, bytes: Buffer.byteLength(json, 'utf8') });
  previews.set(preview, json);
  return preview;
}

export type DiagnosticExportResult = { ok: true; path: string } | { ok: false; reason: 'invalid-preview' | 'write-failed' };
/** Writes exactly the bytes previewed; arbitrary objects/JSON cannot be saved. */
export function saveDiagnosticExport(preview: DiagnosticExportPreview, codexHome: string): DiagnosticExportResult {
  const json = previews.get(preview);
  if (json === undefined) return { ok: false, reason: 'invalid-preview' };
  const dir = path.join(codexHome, 'hud', 'diagnostics');
  const file = path.join(dir, `diagnostic-${randomUUID()}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Unique exclusive files prevent overwrite/symlink substitution of an existing export.
    fs.writeFileSync(file, json, { flag: 'wx', mode: 0o600 });
    return { ok: true, path: file };
  } catch {
    // Do not expose filesystem errors: they may contain private paths.
    return { ok: false, reason: 'write-failed' };
  }
}
