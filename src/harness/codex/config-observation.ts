import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

/** Schema selection, not an attestation of the executable on this connection. */
export const CODEX_CONFIG_PROTOCOL_COMMIT = 'd786ff91fad8e7ddab8653ee07bc6313a6fcb03d';
export interface ConfigReadOptions {
  cwd: string;
  includeLayers?: boolean;
}
export type ConfigReason =
  | 'not_requested'
  | 'pending'
  | 'invalid_request'
  | 'request_failed'
  | 'request_timeout'
  | 'connection_closed'
  | 'protocol_gap'
  | 'unsupported_server_request'
  | 'malformed_response'
  | 'projection_limit'
  | 'missing'
  | 'null_value'
  | 'invalid_value'
  | 'origins_unavailable'
  | 'invalid_origin'
  | 'unsupported_source'
  | 'layers_unavailable'
  | 'observation_unavailable';
export type ConfigSourceType =
  | 'packagedDefaults'
  | 'mdm'
  | 'system'
  | 'enterpriseManaged'
  | 'user'
  | 'project'
  | 'sessionFlags'
  | 'legacyManagedConfigTomlFromFile'
  | 'legacyManagedConfigTomlFromMdm';
export type ConfigOrigin =
  | { state: 'known'; type: ConfigSourceType; version: string }
  | { state: 'unknown'; reason: ConfigReason };
export type ConfigField =
  | { state: 'known'; value: string; origin: ConfigOrigin }
  | { state: 'unknown' | 'invalid'; value: null; reason: ConfigReason; origin: ConfigOrigin };
export interface ConfigObservation {
  schema: 1;
  protocolCommit: typeof CODEX_CONFIG_PROTOCOL_COMMIT;
  qualification: 'not_qualified';
  scope: 'explicit_app_server_connection_only';
  requestedCwd: { kind: 'sha256_exact_utf8'; fingerprint: string; binding: 'not_verified' } | null;
  sequence: number;
  status: 'available' | 'partial' | 'unavailable';
  reasons: ConfigReason[];
  fields: Record<'model' | 'model_provider' | 'model_reasoning_effort' | 'sandbox_mode', ConfigField>;
  layers: {
    coverage: 'included' | 'omitted' | 'unavailable';
    inventory: { index: number; source: ConfigOrigin; disabled: boolean }[];
  };
}
export const CONFIG_PROJECTION_LIMITS = { fieldBytes: 256, versionBytes: 128, origins: 64, layers: 32, cwdBytes: 4096 };
const fields = ['model', 'model_provider', 'model_reasoning_effort', 'sandbox_mode'] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, name: string) => Object.prototype.hasOwnProperty.call(value, name);
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= limit &&
  !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const unknownOrigin = (reason: ConfigReason): ConfigOrigin => ({ state: 'unknown', reason });

/** Only these two supported wire fields are copied. Never inherit extra caller properties. */
export function configReadParams(options: ConfigReadOptions): { cwd: string; includeLayers: boolean } {
  if (
    !object(options) ||
    !text(options.cwd, CONFIG_PROJECTION_LIMITS.cwdBytes) ||
    !isAbsolute(options.cwd) ||
    (options.includeLayers !== undefined && typeof options.includeLayers !== 'boolean')
  )
    throw new Error('app_server_invalid_config_request');
  return { cwd: options.cwd, includeLayers: options.includeLayers ?? true };
}

export function unavailableConfig(
  sequence: number,
  requestedCwd: ConfigObservation['requestedCwd'],
  reason: ConfigReason
): ConfigObservation {
  const field: ConfigField = {
    state: 'unknown',
    value: null,
    reason: 'observation_unavailable',
    origin: unknownOrigin('observation_unavailable'),
  };
  return {
    schema: 1,
    protocolCommit: CODEX_CONFIG_PROTOCOL_COMMIT,
    qualification: 'not_qualified',
    scope: 'explicit_app_server_connection_only',
    requestedCwd,
    sequence,
    status: 'unavailable',
    reasons: [reason],
    fields: {
      model: structuredClone(field),
      model_provider: structuredClone(field),
      model_reasoning_effort: structuredClone(field),
      sandbox_mode: structuredClone(field),
    },
    layers: { coverage: 'unavailable', inventory: [] },
  };
}

export function requestedCwdIdentity(cwd: string): NonNullable<ConfigObservation['requestedCwd']> {
  // Hash only the explicitly requested path bytes, never the secret-bearing configuration.
  return {
    kind: 'sha256_exact_utf8',
    fingerprint: createHash('sha256').update(cwd, 'utf8').digest('hex'),
    binding: 'not_verified',
  };
}

function origin(value: unknown): ConfigOrigin {
  if (!object(value) || !object(value.name) || !text(value.version, CONFIG_PROJECTION_LIMITS.versionBytes))
    return unknownOrigin('invalid_origin');
  const source = value.name;
  const small = (v: unknown) => text(v, CONFIG_PROJECTION_LIMITS.cwdBytes);
  const path = (v: unknown) => small(v) && isAbsolute(v as string);
  let valid: boolean;
  switch (source.type) {
    case 'packagedDefaults':
    case 'system':
    case 'legacyManagedConfigTomlFromFile':
      valid = path(source.file);
      break;
    case 'user':
      valid = path(source.file) && (source.profile === null || small(source.profile));
      break;
    case 'project':
      valid = path(source.dotCodexFolder);
      break;
    case 'mdm':
      valid = small(source.domain) && small(source.key);
      break;
    case 'enterpriseManaged':
      valid = small(source.id) && small(source.name);
      break;
    case 'sessionFlags':
    case 'legacyManagedConfigTomlFromMdm':
      valid = true;
      break;
    default:
      return unknownOrigin('unsupported_source');
  }
  if (!valid) return unknownOrigin('invalid_origin');
  // Do not copy source paths, profile names, domain/key, enterprise IDs or descriptions.
  return { state: 'known', type: source.type, version: value.version };
}

/** Called only on a correlated JSON response already bounded by the observer's 64 KiB frame limit.
 * The raw config and layer.config are neither cloned, hashed, retained nor exposed.
 */
export function projectConfig(
  value: unknown,
  request: { sequence: number; requestedCwd: ConfigObservation['requestedCwd']; includeLayers: boolean }
): ConfigObservation {
  const fail = (reason: ConfigReason) => unavailableConfig(request.sequence, request.requestedCwd, reason);
  if (!object(value) || !object(value.config)) return fail('malformed_response');
  if (own(value, 'origins') && !object(value.origins)) return fail('malformed_response');
  if (own(value, 'layers') && value.layers !== null && !Array.isArray(value.layers)) return fail('malformed_response');
  const origins = object(value.origins) ? value.origins : null;
  const layers = Array.isArray(value.layers) ? value.layers : null;
  if (
    (origins && Object.keys(origins).length > CONFIG_PROJECTION_LIMITS.origins) ||
    (layers && layers.length > CONFIG_PROJECTION_LIMITS.layers)
  )
    return fail('projection_limit');
  const result = fail('observation_unavailable');
  result.status = 'available';
  result.reasons = [];
  const partial = (reason: ConfigReason) => {
    result.status = 'partial';
    if (!result.reasons.includes(reason)) result.reasons.push(reason);
  };
  for (const name of fields) {
    const provenance = origins
      ? own(origins, name)
        ? origin(origins[name])
        : unknownOrigin('missing')
      : unknownOrigin('origins_unavailable');
    if (provenance.state === 'unknown') partial(provenance.reason);
    const entry = value.config[name];
    let reason: ConfigReason | null = null;
    if (!own(value.config, name)) reason = 'missing';
    else if (entry === null) reason = 'null_value';
    else if (
      !text(entry, CONFIG_PROJECTION_LIMITS.fieldBytes) ||
      (name === 'sandbox_mode' && !['read-only', 'workspace-write', 'danger-full-access'].includes(entry))
    )
      reason = 'invalid_value';
    if (reason) {
      result.fields[name] = {
        state: reason === 'invalid_value' ? 'invalid' : 'unknown',
        value: null,
        reason,
        origin: provenance,
      };
      partial(reason);
    } else result.fields[name] = { state: 'known', value: entry as string, origin: provenance };
  }
  // Validate the envelope even if the caller explicitly omitted inventory.
  if (layers) {
    for (let index = 0; index < layers.length; index++) {
      const layer: unknown = layers[index];
      if (
        !object(layer) ||
        !own(layer, 'config') ||
        (layer.disabledReason !== null && typeof layer.disabledReason !== 'string')
      )
        return fail('malformed_response');
      const source = origin(layer);
      if (source.state === 'unknown') partial(source.reason);
      if (request.includeLayers)
        result.layers.inventory.push({ index, source, disabled: layer.disabledReason !== null });
    }
  }
  if (!request.includeLayers) result.layers.coverage = 'omitted';
  else if (layers) result.layers.coverage = 'included';
  else {
    result.layers.coverage = 'unavailable';
    partial('layers_unavailable');
  }
  return result;
}
