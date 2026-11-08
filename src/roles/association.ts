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
}

export function associationPath(home: string, job: string): string {
  return join(home, ASSOCIATION_DIR, `${job}.json`);
}

export function writeAssociation(home: string, record: JobAssociation): void {
  writePrivate(associationPath(home, record.job), JSON.stringify(record) + '\n');
}
