/**
 * `$HUD_HOME/routing.toml` (schema 1).
 *
 * One user-level file: backend profiles, Jev decision profiles, presets, and
 * the default preset. There is no global active preset and no project overlay.
 * Capabilities are derived from `executor` and, for Jev, `target`. A web oracle
 * is a Jev profile whose target is `chatgpt-pro` or `aistudio`. `browser` is
 * direct Jev work, not an oracle.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import * as TOML from '@iarna/toml';
import { CAPABILITIES, SLOTS, slotContract, type Capability, type Slot } from './roles.js';

export const ROUTING_FILE = 'routing.toml';
export const ROUTING_SCHEMA = 1;
/** A larger file is refused instead of parsed. */
export const ROUTING_MAX_BYTES = 64 * 1024;

export const HERDR_HARNESSES = ['codex', 'claude', 'pi', 'grok'] as const;
export type HerdrHarness = (typeof HERDR_HARNESSES)[number];

export const JEV_TARGETS = ['chatgpt-pro', 'aistudio', 'browser'] as const;
export type JevTarget = (typeof JEV_TARGETS)[number];

export const DECISION_PROVIDERS = ['typesafe', 'openai'] as const;
export type DecisionProvider = (typeof DECISION_PROVIDERS)[number];

export type RoutingErrorCode =
  | 'invalid_toml'
  | 'file_too_large'
  | 'file_unreadable'
  | 'routing_missing'
  | 'unknown_key'
  | 'missing_field'
  | 'invalid_type'
  | 'invalid_value'
  | 'unbound_slot'
  | 'dangling_id'
  | 'incompatible_binding'
  | 'unknown_preset'
  | 'selection_invalid'
  | 'session_identity_missing';

export class RoutingError extends Error {
  readonly name = 'RoutingError';

  constructor(
    readonly code: RoutingErrorCode,
    readonly field: string
  ) {
    super(`${code}: ${field}`);
  }
}

export type StructuredArgs =
  readonly (string | number | boolean)[] | Readonly<Record<string, string | number | boolean>>;

export interface BackendProfile {
  readonly id: string;
  readonly executor: 'herdr' | 'jev';
  readonly harness: HerdrHarness | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly recipe: string | null;
  readonly envProfile: string | null;
  readonly target: JevTarget | null;
  readonly mode: string | null;
  readonly args: StructuredArgs | null;
  readonly capabilities: readonly Capability[];
}

export interface JevDecision {
  readonly id: string;
  readonly provider: DecisionProvider;
  readonly model: string | null;
}

export interface RoutingPreset {
  readonly name: string;
  readonly description: string;
  readonly jevDecisions: string;
  readonly roles: Readonly<Record<Slot, string>>;
}

export interface RoutingFile {
  readonly schema: 1;
  readonly defaultPreset: string;
  readonly backends: Readonly<Record<string, BackendProfile>>;
  readonly decisions: Readonly<Record<string, JevDecision>>;
  readonly presets: Readonly<Record<string, RoutingPreset>>;
}

const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FIELD_KEY = /^[A-Za-z0-9._-]{1,80}$/;
const ARG_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,32}$/;

const TOP_KEYS = ['schema', 'default_preset', 'backends', 'jev_decisions', 'presets'];
const HERDR_KEYS = ['executor', 'harness', 'model', 'effort', 'recipe', 'env_profile', 'args'];
const JEV_KEYS = ['executor', 'target', 'model', 'mode'];
const DECISION_KEYS = ['provider', 'model'];
const PRESET_KEYS = ['description', 'jev_decisions', 'roles'];

function fail(code: RoutingErrorCode, field: string): never {
  throw new RoutingError(code, field);
}

export function assertRoutingId(value: string, field: string): string {
  if (!ID.test(value) || value.length > 64) fail('invalid_value', field);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail('invalid_type', field);
  return value;
}

function own(source: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(source, key);
}

/** Own property only. Inherited names such as `constructor` are absent. */
export function idValue<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function blankMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function childField(parent: string, key: string): string {
  if (!FIELD_KEY.test(key)) return parent || 'routing.toml';
  return parent ? `${parent}.${key}` : key;
}

function assertKeys(source: Record<string, unknown>, allowed: readonly string[], parent: string): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) fail('unknown_key', childField(parent, key));
  }
}

function required(source: Record<string, unknown>, key: string, field: string): unknown {
  if (!own(source, key)) fail('missing_field', field);
  return source[key];
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string') fail('invalid_type', field);
  return assertRoutingId(value, field);
}

/** A profile label. Slashes and home prefixes are rejected: this is a name, not a path. */
function label(value: unknown, field: string): string {
  if (typeof value !== 'string') fail('invalid_type', field);
  if (
    !NAME.test(value) ||
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.startsWith('~')
  ) {
    fail('invalid_value', field);
  }
  return value;
}

function modelName(value: unknown, field: string): string {
  if (typeof value !== 'string') fail('invalid_type', field);
  if (
    value.length === 0 ||
    value.length > 128 ||
    /[\u0000\r\n]/.test(value) ||
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.includes('..')
  ) {
    fail('invalid_value', field);
  }
  return value;
}

function descriptionOf(value: unknown, field: string): string {
  if (typeof value !== 'string') fail('invalid_type', field);
  if (value.length === 0 || value.length > 200 || /[\u0000\r\n]/.test(value)) fail('invalid_value', field);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string') fail('invalid_type', field);
  if (!(allowed as readonly string[]).includes(value)) fail('invalid_value', field);
  return value as T;
}

function scalar(value: unknown, field: string): string | number | boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_value', field);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 200 || /[\u0000\r\n]/.test(value) || argHasPath(value)) fail('invalid_value', field);
    return value;
  }
  fail('invalid_type', field);
}

/** A leading path, or a path after `=`, is not an argument value (`--config=/…`, `--x=~/…`). */
function argHasPath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('~')) return true;
  return value
    .split('=')
    .slice(1)
    .some((part) => part.startsWith('/') || part.startsWith('~'));
}

function structuredArgs(value: unknown, field: string): StructuredArgs {
  if (Array.isArray(value)) {
    if (value.length > 32) fail('invalid_value', field);
    return value.map((item, index) => scalar(item, `${field}[${index}]`));
  }
  const table = record(value, field);
  const keys = Object.keys(table).sort();
  if (keys.length > 32) fail('invalid_value', field);
  const sorted: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    if (!ARG_KEY.test(key)) fail('invalid_value', `${field}.${key}`);
    sorted[key] = scalar(table[key], `${field}.${key}`);
  }
  return sorted;
}

function capabilitiesFor(executor: 'herdr' | 'jev', target: JevTarget | null): readonly Capability[] {
  if (executor === 'herdr') {
    return ['executor_herdr', 'workspace_read', 'workspace_write', 'interactive_or_continuable'];
  }
  if (target === 'browser') return ['executor_jev'];
  return ['executor_jev', 'web_oracle'];
}

export function bindingCompatible(slot: Slot, backend: BackendProfile): boolean {
  const contract = slotContract(slot);
  const has = new Set(backend.capabilities);
  if (contract.forbids.some((capability) => has.has(capability))) return false;
  if (contract.requires.some((capability) => !has.has(capability))) return false;
  if (contract.requiresAny.length > 0 && !contract.requiresAny.some((capability) => has.has(capability))) return false;
  return true;
}

function slotField(preset: string, slot: string): string {
  return FIELD_KEY.test(slot) ? `presets.${preset}.roles["${slot}"]` : `presets.${preset}.roles`;
}

function parseBackend(id: string, value: unknown): BackendProfile {
  const field = `backends.${id}`;
  const body = record(value, field);
  if (!own(body, 'executor')) fail('missing_field', `${field}.executor`);
  const executor = oneOf(body.executor, ['herdr', 'jev'] as const, `${field}.executor`);
  assertKeys(body, executor === 'herdr' ? HERDR_KEYS : JEV_KEYS, field);
  if (executor === 'herdr') {
    const harness = oneOf(required(body, 'harness', `${field}.harness`), HERDR_HARNESSES, `${field}.harness`);
    const model = modelName(required(body, 'model', `${field}.model`), `${field}.model`);
    const effort = own(body, 'effort') ? label(body.effort, `${field}.effort`) : null;
    const recipe = own(body, 'recipe') ? identifier(body.recipe, `${field}.recipe`) : null;
    const envProfile = own(body, 'env_profile') ? label(body.env_profile, `${field}.env_profile`) : null;
    const args = own(body, 'args') ? structuredArgs(body.args, `${field}.args`) : null;
    return {
      id,
      executor,
      harness,
      model,
      effort,
      recipe,
      envProfile,
      target: null,
      mode: null,
      args,
      capabilities: capabilitiesFor('herdr', null),
    };
  }
  const target = oneOf(required(body, 'target', `${field}.target`), JEV_TARGETS, `${field}.target`);
  const model = own(body, 'model') ? modelName(body.model, `${field}.model`) : null;
  const mode = own(body, 'mode') ? label(body.mode, `${field}.mode`) : null;
  return {
    id,
    executor,
    harness: null,
    model,
    effort: null,
    recipe: null,
    envProfile: null,
    target,
    mode,
    args: null,
    capabilities: capabilitiesFor('jev', target),
  };
}

function parseDecision(id: string, value: unknown): JevDecision {
  const field = `jev_decisions.${id}`;
  const body = record(value, field);
  assertKeys(body, DECISION_KEYS, field);
  const provider = oneOf(required(body, 'provider', `${field}.provider`), DECISION_PROVIDERS, `${field}.provider`);
  const model = own(body, 'model') ? modelName(body.model, `${field}.model`) : null;
  return { id, provider, model };
}

function parsePreset(
  name: string,
  value: unknown,
  routing: { backends: Record<string, BackendProfile>; decisions: Record<string, JevDecision> }
): RoutingPreset {
  const field = `presets.${name}`;
  const body = record(value, field);
  assertKeys(body, PRESET_KEYS, field);
  const description = descriptionOf(required(body, 'description', `${field}.description`), `${field}.description`);
  const jevDecisions = identifier(required(body, 'jev_decisions', `${field}.jev_decisions`), `${field}.jev_decisions`);
  if (!own(routing.decisions, jevDecisions)) fail('dangling_id', `${field}.jev_decisions`);
  const rolesBody = record(required(body, 'roles', `${field}.roles`), `${field}.roles`);
  for (const key of Object.keys(rolesBody)) {
    if (!(SLOTS as readonly string[]).includes(key)) fail('unknown_key', slotField(name, key));
  }
  for (const slot of SLOTS) {
    if (!own(rolesBody, slot)) fail('unbound_slot', slotField(name, slot));
  }
  const roles = blankMap<string>() as Record<Slot, string>;
  for (const slot of SLOTS) {
    const backendId = identifier(rolesBody[slot], slotField(name, slot));
    if (!own(routing.backends, backendId)) fail('dangling_id', slotField(name, slot));
    roles[slot] = backendId;
  }
  for (const slot of SLOTS) {
    const backend = idValue(routing.backends, roles[slot]);
    if (!backend || !bindingCompatible(slot, backend)) fail('incompatible_binding', slotField(name, slot));
  }
  return { name, description, jevDecisions, roles };
}

function parseDocument(value: unknown): RoutingFile {
  const root = record(value, 'routing.toml');
  assertKeys(root, TOP_KEYS, '');
  const schema = required(root, 'schema', 'schema');
  if (typeof schema !== 'number' || !Number.isInteger(schema)) fail('invalid_type', 'schema');
  if (schema !== ROUTING_SCHEMA) fail('invalid_value', 'schema');
  const defaultPreset = identifier(required(root, 'default_preset', 'default_preset'), 'default_preset');

  const backendBody = record(required(root, 'backends', 'backends'), 'backends');
  const backendIds = Object.keys(backendBody);
  if (backendIds.length === 0 || backendIds.length > 32) fail('invalid_value', 'backends');
  const backends: Record<string, BackendProfile> = blankMap();
  for (const id of backendIds) {
    identifier(id, `backends.${FIELD_KEY.test(id) ? id : 'id'}`);
    backends[id] = parseBackend(id, backendBody[id]);
  }

  const decisionBody = record(required(root, 'jev_decisions', 'jev_decisions'), 'jev_decisions');
  const decisionIds = Object.keys(decisionBody);
  if (decisionIds.length === 0 || decisionIds.length > 16) fail('invalid_value', 'jev_decisions');
  const decisions: Record<string, JevDecision> = blankMap();
  for (const id of decisionIds) {
    identifier(id, `jev_decisions.${FIELD_KEY.test(id) ? id : 'id'}`);
    decisions[id] = parseDecision(id, decisionBody[id]);
  }

  const presetBody = record(required(root, 'presets', 'presets'), 'presets');
  const presetIds = Object.keys(presetBody);
  if (presetIds.length === 0 || presetIds.length > 32) fail('invalid_value', 'presets');
  const presets: Record<string, RoutingPreset> = blankMap();
  for (const name of presetIds) {
    identifier(name, `presets.${FIELD_KEY.test(name) ? name : 'name'}`);
    presets[name] = parsePreset(name, presetBody[name], { backends, decisions });
  }
  if (!own(presets, defaultPreset)) fail('dangling_id', 'default_preset');
  return { schema: 1, defaultPreset, backends, decisions, presets };
}

export function parseRouting(text: string): RoutingFile {
  let parsed: unknown;
  try {
    parsed = TOML.parse(text);
  } catch (error) {
    const line =
      error !== null && typeof error === 'object' && 'line' in error
        ? Number((error as { line: unknown }).line)
        : Number.NaN;
    fail('invalid_toml', Number.isInteger(line) && line > 0 ? `routing.toml:${line}` : 'routing.toml');
  }
  return parseDocument(parsed);
}

function refuseSymlink(path: string, field: string): fs.Stats {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('routing_missing', field);
    fail('file_unreadable', field);
  }
  if (info.isSymbolicLink()) fail('file_unreadable', field);
  return info;
}

/** Read and validate `$HUD_HOME/routing.toml`. Does not create the file. */
export function loadRouting(home: string): RoutingFile {
  const path = join(home, ROUTING_FILE);
  const info = refuseSymlink(path, ROUTING_FILE);
  if (!info.isFile()) fail('file_unreadable', ROUTING_FILE);
  if (info.size > ROUTING_MAX_BYTES) fail('file_too_large', ROUTING_FILE);
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    fail('file_unreadable', ROUTING_FILE);
  }
  return parseRouting(text);
}

/** JSON view of a backend. Keys are stable and match the file's vocabulary. */
export function backendJson(backend: BackendProfile): {
  id: string;
  executor: 'herdr' | 'jev';
  harness: HerdrHarness | null;
  model: string | null;
  effort: string | null;
  recipe: string | null;
  env_profile: string | null;
  target: JevTarget | null;
  mode: string | null;
  args: StructuredArgs | null;
  capabilities: Capability[];
} {
  return {
    id: backend.id,
    executor: backend.executor,
    harness: backend.harness,
    model: backend.model,
    effort: backend.effort,
    recipe: backend.recipe,
    env_profile: backend.envProfile,
    target: backend.target,
    mode: backend.mode,
    args: backend.args,
    capabilities: CAPABILITIES.filter((capability) => backend.capabilities.includes(capability)),
  };
}

export function knownPreset(routing: RoutingFile, name: string, field: string): RoutingPreset {
  const preset = idValue(routing.presets, name);
  if (!preset) fail('unknown_preset', field);
  return preset;
}
