// Synthetic portfolio on disk: 5 live projects + 1 unavailable root, read by the real collectors in dist/.
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const NOW = Date.parse('2026-11-24T12:00:00Z');
const D = 864e5;
const iso = (ms) => new Date(ms).toISOString();

export async function buildFixture(base) {
  const dir = fs.mkdtempSync(join(base ?? tmpdir(), 'home-portfolio-'));
  const home = join(dir, 'hud');
  const put = (file, text, at = NOW) => {
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
    fs.utimesSync(file, new Date(at), new Date(at));
  };
  const roots = {
    harbor: join(dir, 'harbor-api'), lab: join(dir, 'tide-lab'), quill: join(dir, 'quill'),
    lantern: join(dir, 'lantern-relay-service'), sketch: join(dir, 'sketchbook'), mill: join(dir, 'old-mill'),
  };
  const issue = (root, feature, n, title, status, blocked = 'none', at = NOW - 3 * 3600e3, extra = '') =>
    put(join(root, '.scratch', feature, 'issues', `${n}-t.md`), `# ${n}: ${title}\n\n**Status:** ${status}\n**Blocked by:** ${blocked}\n${extra}`, at);

  // 1. harbor-api: active, two linked Objectives mid-way, two jobs running, one request work waits on.
  put(join(roots.harbor, '.hud/objectives.md'), [
    '**Stance:** active · **Priority:** high', '',
    '## rate-limits: Per-key rate limits for the public API, with a quota header on every response',
    '**State:** active', '**Features:** rate-limit-core, quota-headers',
    '**Next:** Wire the quota header into the SDK docs, then ask the owner to try a throttled key.',
    '**Result:** Token-bucket core shipped; 429 responses now carry a retry-after hint.',
    '**Evidence:** docs/notes/rate-limits.md, 9f3a1c2', '',
    '## ci-speed: Cut the CI wall time below ten minutes',
    '**State:** active', '**Features:** ci-cache',
    '**Next:** Split the integration suite across two runners.', '',
    '## sdk-v1: Retire the v1 SDK',
    '**State:** done', '**Result:** v1 removed from the docs and the package index.', '',
  ].join('\n'), NOW - 5 * 3600e3);
  const w = 'rate-limit-core';
  [['01', 'bucket data structure'], ['02', 'per-key limiter'], ['03', 'retry-after hint']].forEach(([n, t]) => issue(roots.harbor, w, n, t, 'done', 'none', NOW - 26 * 3600e3, '\n## Comments\n- Landed 1a2b3c4\n'));
  issue(roots.harbor, w, '04', 'limiter config file', 'ready-for-agent', 'none', NOW - 2 * 60e3);
  issue(roots.harbor, w, '05', 'burst-size default', 'ready-for-agent', '04');
  const q = 'quota-headers';
  issue(roots.harbor, q, '01', 'header writer', 'done', 'none', NOW - 30 * 3600e3, '\n## Comments\n- Landed 2b3c4d5\n');
  issue(roots.harbor, q, '02', 'SDK docs for headers', 'ready-for-agent', '01');
  issue(roots.harbor, q, '03', 'throttled-key walkthrough', 'ready-for-human', '02');
  const c = 'ci-cache';
  ['01', '02', '03', '04'].forEach((n) => issue(roots.harbor, c, n, 'cache step ' + n, 'done', 'none', NOW - 50 * 3600e3, '\n## Comments\n- Landed 3c4d5e6\n'));
  issue(roots.harbor, c, '05', 'split the integration suite', 'ready-for-agent', 'none', NOW - 10 * 60e3);
  issue(roots.harbor, c, '06', 'runner matrix docs', 'ready-for-agent', '05');
  put(join(roots.harbor, 'docs/handoff/STATE.md'), [
    '# State', '', 'Milestone: M2', '',
    '## Waiting for the owner', '',
    '- 2026-11-23 [r1] Pick the default burst size: 20 or 60 requests per second? Main cannot ship the quota headers until it is chosen. (objective rate-limits) (work waits)', '',
    '## Now', '- Quota headers and the CI cache are in flight', '', '## Next', '- Split the integration suite', '',
  ].join('\n'), NOW - 20 * 60e3);
  put(join(roots.harbor, 'docs/spec.md'), '# Spec\n\n## 5. Milestones\n\n- **M1, usable**\n- **M2, quota**\n\n## 6. Other\n');
  put(join(roots.harbor, 'docs/reviews/2026-11-22-review.md'), 'Verdict: accept', NOW - 2 * D);
  // Two running jobs in harbor-api.
  const job = (id, role, ticket, minutes, cwd = roots.harbor) => {
    const j = join(home, 'jobs', id);
    put(join(j, 'job.json'), { job: id, role, cwd, ticket, herdr_pane: 'w1:p1', created_at: iso(NOW - minutes * 60e3) }, NOW - minutes * 60e3);
    put(join(j, 'STATUS.json'), { state: 'working', started_at: iso(NOW - minutes * 60e3) }, NOW - 60e3);
    put(join(j, 'brief.md'), `# ${ticket}`, NOW - minutes * 60e3);
  };
  job('j0000000000000001', 'imp', 'rate-limit-core/04', 14);
  job('j0000000000000002', 'reviewer', 'ci-cache/05', 6);

  // 2. tide-lab: one ticketless study.
  put(join(roots.lab, '.hud/objectives.md'), [
    '**Stance:** active', '',
    '## tokenizers: Compare three tokenizers on the multilingual sample before choosing one',
    '**State:** active', '**Next:** Run the third sample set, then write the comparison table.',
    '**Result:** Two of three tokenizers measured; the third needs a larger sample.', '',
  ].join('\n'), NOW - 2 * D);
  put(join(roots.lab, 'STATE.md'), '# State\n\n## Waiting for the owner\n\n## Now\n- Measuring tokenizers\n', NOW - 2 * 3600e3);
  // 3. quill: paused, one paused Objective with tickets.
  put(join(roots.quill, '.hud/objectives.md'), [
    '**Stance:** paused · **Priority:** low', '',
    '## docs-site: Rebuild the docs site on the new theme', '**State:** paused', '**Features:** docs-theme',
    '**Next:** Resume after the theme is released.', '',
  ].join('\n'), NOW - 9 * D);
  ['01', '02'].forEach((n) => issue(roots.quill, 'docs-theme', n, 'theme step ' + n, 'done', 'none', NOW - 9 * D, '\n## Comments\n- Landed 4d5e6f7\n'));
  issue(roots.quill, 'docs-theme', '03', 'port the search page', 'ready-for-agent', 'none', NOW - 9 * D);
  put(join(roots.quill, 'STATE.md'), '# State\n\n## Waiting for the owner\n\n## Now\n- Paused until the theme ships\n', NOW - 9 * D);
  // 4. lantern-relay-service: maintenance, nothing active, idle for weeks.
  put(join(roots.lantern, '.hud/objectives.md'), [
    '**Stance:** maintenance', '',
    '## v2-migration: Move every client to the v2 relay protocol', '**State:** done', '**Result:** All clients on v2; v1 listeners removed.', '',
  ].join('\n'), NOW - 41 * D);
  put(join(roots.lantern, 'STATE.md'), '# State\n\n## Waiting for the owner\n\n## Now\n- Patch releases only\n', NOW - 41 * D);
  // 5. sketchbook: no objectives.md, STATE only.
  put(join(roots.sketch, 'STATE.md'), '# State\n\n## Waiting for the owner\n\n## Now\n- Prototype the capture overlay\n\n## Next\n- Pick the colour palette\n', NOW - 2 * D);
  // 6. old-mill: registered but the directory is gone (not created).

  // Result receipts: harbor `rate-limits` four hours ago, lab `tokenizers` six days ago, lantern long ago.
  const receipt = (project, id, at, result) => ({ v: 1, kind: 'objective', project, id, change: 'result', at: iso(at), result });
  put(join(home, 'events/2026-11.jsonl'), [
    receipt(roots.harbor, 'rate-limits', NOW - 4 * 3600e3, 'Token-bucket core shipped; 429 responses now carry a retry-after hint.'),
    receipt(roots.lab, 'tokenizers', NOW - 6 * D, 'Two of three tokenizers measured; the third needs a larger sample.'),
    receipt(roots.lantern, 'v2-migration', NOW - 41 * D, 'All clients on v2; v1 listeners removed.'),
    receipt(roots.harbor, 'sdk-v1', NOW - 12 * D, 'v1 removed from the docs and the package index.'),
  ].map(JSON.stringify).join('\n') + '\n', NOW - 3600e3);
  put(join(home, 'projects.json'), { version: 1, projects: Object.values(roots).map((root) => ({ root })) });
  return { dir, home, roots, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
