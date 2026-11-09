/**
 * Tree association for one role job. R5 renders these files. Collectors do not
 * read them yet.
 *
 * Directory: `$HUD_HOME/assoc/<job>.json`
 * One file per job, mode 0600, replaced by rename. `<job>` matches `^j[a-f0-9]{16}$`.
 *
 * ```json
 * {
 *   "schema": 1,
 *   "job": "j0123456789abcdef",
 *   "root": "<source-namespace>/<session-id>",
 *   "role": "imp",
 *   "phase": null,
 *   "preset": "daily",
 *   "task_label": "short label",
 *   "cwd": "/absolute/work",
 *   "backend": {
 *     "id": "pi-fast",
 *     "executor": "herdr",
 *     "harness": "pi",
 *     "model": "synthetic-flash",
 *     "effort": "max",
 *     "env_profile": null,
 *     "recipe": "pi-role"
 *   },
 *   "herdr": { "tab_id": null, "pane_id": null, "agent": null, "workspace_id": null },
 *   "report_path": "/hud-home/jobs/<job>/report.md",
 *   "closed": false
 * }
 * ```
 *
 * `root` is the main-session roster identity. `preset` and `backend` are the
 * values at launch and do not follow a later preset switch. `herdr` ids stay
 * null until herdr acknowledges the tab. `closed` does not delete the file.
 * `phase` is `propose`, `converge`, or null.
 */

import { join } from 'node:path';
import { validateSessionRef } from '../core/identity.js';
import type { SessionRef } from '../core/types/identity.js';
import { parseRosterRoot } from './selection.js';
import { dispatchText } from './pi-dispatch.js';
import type { OraclePhase, RoleName } from './roles.js';
import { writePrivate } from './job-store.js';

export const ASSOCIATION_DIR = 'assoc';

export interface JobAssociation {
  readonly schema: 1;
  readonly job: string;
  readonly root: string;
  readonly role: RoleName;
  readonly phase: OraclePhase | null;
  readonly preset: string;
  readonly task_label: string;
  readonly cwd: string;
  readonly backend: {
    readonly id: string;
    readonly executor: 'herdr' | 'jev';
    readonly harness: string | null;
    readonly model: string | null;
    readonly effort: string | null;
    readonly env_profile: string | null;
    readonly recipe: string | null;
  };
  readonly herdr: {
    readonly tab_id: string | null;
    readonly pane_id: string | null;
    readonly agent: string | null;
    readonly workspace_id: string | null;
  };
  readonly report_path: string;
  readonly closed: boolean;
  /** Observation only. The current facade has no complete native-ref evidence;
   * it preserves these fixture/future-writer fields, but never guesses a source. */
  readonly native?: SessionRef;
  readonly helpers?: Readonly<Record<string, SessionRef>>;
  readonly created_at?: string;
  readonly closed_at?: string;
}

export function associationPath(home: string, job: string): string {
  return join(home, ASSOCIATION_DIR, `${job}.json`);
}

export function completeNativeRef(value: unknown): value is SessionRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    validateSessionRef(value as SessionRef);
    return true;
  } catch {
    return false;
  }
}

function reducedRef(ref: SessionRef): SessionRef {
  return { harness: ref.harness, sourceId: ref.sourceId, sessionId: ref.sessionId, threadId: ref.threadId };
}

export const DISPATCH_SLOT = /^(sonic|review|architect)-([1-9][0-9]{0,5})$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0');
const nullable = (value: unknown) => value === null || text(value);
const stamp = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));

/** Optional metadata is independently validated: a bad optional ref grants nothing. */
export function associationMetadata(
  value: unknown
): Pick<JobAssociation, 'native' | 'helpers' | 'created_at' | 'closed_at'> {
  if (!object(value)) return {};
  const helpers: Record<string, SessionRef> = {};
  if (object(value.helpers)) {
    for (const [slot, ref] of Object.entries(value.helpers).slice(0, 64))
      if (DISPATCH_SLOT.test(slot) && completeNativeRef(ref)) helpers[slot] = reducedRef(ref);
  }
  return {
    ...(completeNativeRef(value.native) ? { native: reducedRef(value.native) } : {}),
    ...(Object.keys(helpers).length ? { helpers } : {}),
    ...(stamp(value.created_at) ? { created_at: value.created_at } : {}),
    ...(stamp(value.closed_at) ? { closed_at: value.closed_at } : {}),
  };
}

export function parseAssociation(value: unknown, job: string): JobAssociation | null {
  if (!object(value) || value.schema !== 1 || value.job !== job || !/^j[a-f0-9]{16}$/.test(job)) return null;
  try {
    parseRosterRoot(String(value.root));
  } catch {
    return null;
  }
  if (
    !['oracle', 'imp', 'reviewer', 'sonic', 'jev'].includes(String(value.role)) ||
    !(value.role === 'oracle' ? ['propose', 'converge'].includes(String(value.phase)) : value.phase === null) ||
    !['preset', 'task_label', 'cwd', 'report_path'].every((key) => text(value[key])) ||
    typeof value.closed !== 'boolean' ||
    !object(value.backend) ||
    !object(value.herdr)
  )
    return null;
  const b = value.backend;
  if (
    !text(b.id) ||
    !['herdr', 'jev'].includes(String(b.executor)) ||
    !['harness', 'model', 'effort', 'env_profile', 'recipe'].every((key) => nullable(b[key])) ||
    !['tab_id', 'pane_id', 'agent', 'workspace_id'].every((key) =>
      nullable((value.herdr as Record<string, unknown>)[key])
    )
  )
    return null;
  // SAFETY: required schema-1 fields are checked above. Copy only the public allowlist,
  // including nested objects; a future/unknown secret field must not enter display DTOs.
  return {
    schema: 1,
    job,
    root: value.root,
    role: value.role,
    phase: value.phase,
    preset: value.preset,
    task_label: value.task_label,
    cwd: value.cwd,
    report_path: value.report_path,
    closed: value.closed,
    backend: {
      id: b.id,
      executor: b.executor,
      harness: b.harness,
      model: b.model,
      effort: b.effort,
      env_profile: b.env_profile,
      recipe: b.recipe,
    },
    herdr: {
      tab_id: value.herdr.tab_id,
      pane_id: value.herdr.pane_id,
      agent: value.herdr.agent,
      workspace_id: value.herdr.workspace_id,
    },
    ...associationMetadata(value),
  } as JobAssociation;
}

export function writeAssociation(home: string, record: JobAssociation): void {
  if (!/^j[a-f0-9]{16}$/.test(record.job)) throw new Error('invalid_job');
  const file = associationPath(home, record.job);
  const previous = dispatchText(file, 16 * 1024);
  let metadata = {};
  try {
    metadata = associationMetadata(previous ? JSON.parse(previous) : null);
  } catch {
    /* Never preserve malformed data. */
  }
  const { native: _native, helpers: _helpers, created_at: _created, closed_at: _closed, ...base } = record;
  const next = { ...base, ...metadata, ...associationMetadata(record) };
  writePrivate(file, JSON.stringify(next) + '\n');
}
