/**
 * Session-scoped preset selection.
 *
 * The key is the source/home namespace plus the session id. A `SessionRef`
 * contributes its `sourceId` (that namespace) and `sessionId`; the thread id is
 * not part of the key. The file is `$HUD_HOME/roster-selection/<sha256>.json`,
 * written with a private temp file and `rename`. There is no global active preset.
 * A missing file means "no selection". A corrupt file is an error.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { validateSessionRef } from '../core/identity.js';
import type { SessionRef } from '../core/types/identity.js';
import { SLOTS, slotContract, type Slot } from './roles.js';
import {
  assertRoutingId,
  backendJson,
  bindingCompatible,
  idValue,
  RoutingError,
  type BackendProfile,
  type RoutingFile,
} from './routing.js';

export const SELECTION_DIR = 'roster-selection';
export const SELECTION_MAX_BYTES = 4096;

const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const SELECTION_KEYS = ['namespace', 'preset', 'schema', 'sessionId'];

export interface RosterRoot {
  readonly namespace: string;
  readonly sessionId: string;
}

export interface RosterSelection {
  readonly schema: 1;
  readonly namespace: string;
  readonly sessionId: string;
  readonly preset: string;
}

export interface ResolvedSlot {
  readonly slot: Slot;
  readonly role: string;
  readonly phase: 'propose' | 'converge' | null;
  readonly override: boolean;
  readonly backend: ReturnType<typeof backendJson>;
}

export interface ResolvedRoster {
  readonly schema: 1;
  readonly preset: string;
  readonly source: 'default' | 'session' | 'explicit';
  readonly root: string | null;
  readonly jev_decisions: {
    readonly id: string;
    readonly provider: 'gemini' | 'typesafe' | 'openai';
    readonly model: string | null;
  };
  readonly roles: readonly ResolvedSlot[];
}

export interface ResolveOptions {
  readonly root?: RosterRoot | null;
  /** Already loaded for `root`. Omitted when that session has no selection. */
  readonly selection?: RosterSelection | null;
  /** Display this preset instead of the session selection. Does not write. */
  readonly preset?: string | null;
  /** Authorized one-off backend for a single slot. Not a CLI flag. */
  readonly override?: { readonly slot: Slot; readonly backend: string } | null;
}

export interface SaveOptions {
  /** Test seam. Thrown before `rename`, the previous file is left in place. */
  readonly beforeRename?: () => void;
}

export function formatRosterRoot(root: RosterRoot): string {
  return `${root.namespace}/${root.sessionId}`;
}

export function parseRosterRoot(value: string): RosterRoot {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash !== value.lastIndexOf('/')) throw new RoutingError('invalid_value', 'root');
  const namespace = value.slice(0, slash);
  const sessionId = value.slice(slash + 1);
  if (!NAMESPACE.test(namespace) || !SESSION.test(sessionId) || namespace.includes('..') || sessionId.includes('..')) {
    throw new RoutingError('invalid_value', 'root');
  }
  return { namespace, sessionId };
}

/** `sourceId` is the home namespace. Thread id stays out of the roster key. */
export function rosterRootFromSessionRef(ref: SessionRef): RosterRoot {
  validateSessionRef(ref);
  return parseRosterRoot(`${ref.sourceId}/${ref.sessionId}`);
}

export function rosterSelectionKey(root: RosterRoot): string {
  return createHash('sha256')
    .update(JSON.stringify([root.namespace, root.sessionId]), 'utf8')
    .digest('hex');
}

export function rosterSelectionPath(home: string, root: RosterRoot): string {
  return join(home, SELECTION_DIR, `${rosterSelectionKey(root)}.json`);
}

function selectionDocument(root: RosterRoot, preset: string): string {
  return JSON.stringify({ schema: 1, namespace: root.namespace, sessionId: root.sessionId, preset }) + '\n';
}

function refuseSymlink(path: string, field: string): void {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new RoutingError('file_unreadable', field);
  }
  if (info.isSymbolicLink()) throw new RoutingError('file_unreadable', field);
}

function writePrivateJson(file: string, content: string, beforeRename?: () => void): void {
  const dir = join(file, '..');
  refuseSymlink(dir, SELECTION_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    beforeRename?.();
    refuseSymlink(file, SELECTION_DIR);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* Renamed, or the write itself failed. */
    }
  }
}

/** Replace one session's selection. Other sessions' files are not touched. */
export function saveRosterSelection(
  home: string,
  root: RosterRoot,
  preset: string,
  options?: SaveOptions
): RosterSelection {
  const name = assertRoutingId(preset, 'preset');
  const selection: RosterSelection = { schema: 1, namespace: root.namespace, sessionId: root.sessionId, preset: name };
  writePrivateJson(rosterSelectionPath(home, root), selectionDocument(root, name), options?.beforeRename);
  return selection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `null` when this session has no selection yet. */
export function loadRosterSelection(home: string, root: RosterRoot): RosterSelection | null {
  const path = rosterSelectionPath(home, root);
  const field = `${SELECTION_DIR}/${rosterSelectionKey(root)}.json`;
  let info: fs.Stats;
  try {
    info = fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RoutingError('file_unreadable', field);
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new RoutingError('file_unreadable', field);
  if (info.size > SELECTION_MAX_BYTES) throw new RoutingError('file_too_large', field);
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    throw new RoutingError('file_unreadable', field);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RoutingError('selection_invalid', field);
  }
  if (!isRecord(parsed)) throw new RoutingError('selection_invalid', field);
  const keys = Object.keys(parsed).sort();
  const extra = keys.find((key) => !SELECTION_KEYS.includes(key));
  if (extra) throw new RoutingError('unknown_key', `${field}.${extra}`);
  if (keys.join() !== [...SELECTION_KEYS].sort().join()) throw new RoutingError('missing_field', field);
  if (parsed.schema !== 1) throw new RoutingError('invalid_value', `${field}.schema`);
  if (parsed.namespace !== root.namespace || parsed.sessionId !== root.sessionId) {
    throw new RoutingError('selection_invalid', field);
  }
  if (typeof parsed.preset !== 'string') throw new RoutingError('invalid_type', `${field}.preset`);
  return { schema: 1, namespace: root.namespace, sessionId: root.sessionId, preset: parsed.preset };
}

function slotBinding(
  routing: RoutingFile,
  presetName: string,
  slot: Slot,
  override: ResolveOptions['override']
): { backend: BackendProfile; override: boolean } {
  if (override && override.slot === slot) {
    const backend = idValue(routing.backends, override.backend);
    if (!backend) throw new RoutingError('dangling_id', `override["${slot}"]`);
    if (!bindingCompatible(slot, backend)) throw new RoutingError('incompatible_binding', `override["${slot}"]`);
    return { backend, override: true };
  }
  const preset = idValue(routing.presets, presetName);
  const backendId = preset ? preset.roles[slot] : undefined;
  const backend = backendId === undefined ? undefined : idValue(routing.backends, backendId);
  if (!backend) throw new RoutingError('dangling_id', `presets.${presetName}.roles["${slot}"]`);
  return { backend, override: false };
}

/**
 * Resolve one view of the roster.
 * Order for each slot's backend: one-off override, then the explicit preset,
 * then the session selection, then `default_preset`. The returned object is a
 * snapshot. A later selection change does not alter it.
 * The preset's Jev decision profile stays in force when a slot backend is overridden.
 */
export function resolveRoster(routing: RoutingFile, options: ResolveOptions = {}): ResolvedRoster {
  const root = options.root ?? null;
  const selection = options.selection ?? null;
  if (selection) {
    if (!root || selection.namespace !== root.namespace || selection.sessionId !== root.sessionId) {
      throw new RoutingError('selection_invalid', 'selection');
    }
  }
  let presetName: string;
  let source: ResolvedRoster['source'];
  if (options.preset) {
    presetName = options.preset;
    source = 'explicit';
  } else if (selection) {
    presetName = selection.preset;
    source = 'session';
  } else {
    presetName = routing.defaultPreset;
    source = 'default';
  }
  const preset = idValue(routing.presets, presetName);
  if (!preset) {
    if (source === 'explicit') throw new RoutingError('unknown_preset', 'preset');
    throw new RoutingError('dangling_id', source === 'session' ? 'selection.preset' : 'default_preset');
  }
  const decision = idValue(routing.decisions, preset.jevDecisions);
  if (!decision) throw new RoutingError('dangling_id', `presets.${preset.name}.jev_decisions`);
  const override = options.override ?? null;
  const roles: ResolvedSlot[] = [];
  for (const slot of SLOTS) {
    const bound = slotBinding(routing, preset.name, slot, override);
    const contract = slotContract(slot);
    roles.push({
      slot,
      role: contract.role,
      phase: contract.phase,
      override: bound.override,
      backend: backendJson(bound.backend),
    });
  }
  return {
    schema: 1,
    preset: preset.name,
    source,
    root: root ? formatRosterRoot(root) : null,
    jev_decisions: { id: decision.id, provider: decision.provider, model: decision.model },
    roles,
  };
}
