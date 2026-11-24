// The Home portfolio fixture plus a day of synthetic work and a synthetic schedule store, written under the same temp home.
// Prototype only: nothing here is product code, and every name, title and date is invented.
import fs from 'node:fs';
import { join } from 'node:path';
import { buildFixture, NOW } from '../../home-portfolio/gen/fixture.mjs';
export { NOW };

const D = 864e5, H = 3600e3, M = 60e3;
const iso = (ms) => new Date(ms).toISOString();
const put = (file, text, at = NOW) => {
  fs.mkdirSync(join(file, '..'), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
  fs.utimesSync(file, new Date(at), new Date(at));
};

/** Schedule items per language: the owner's text is shown as recorded, so each panel language has its own wording. */
const ITEMS = {
  zh: [
    { key: 'cert', date: '2026-11-22', text: '续订开发机 SSH 证书' },
    { key: 'review', date: '2026-11-24', text: '与团队过限流方案', project: 'harbor', objective: 'rate-limits' },
    { key: 'sdk', date: '2026-11-27', text: '发布 SDK 说明' , project: 'harbor' },
    { key: 'sonic', date: '2026-12', text: 'sonic 模型到期 → 换 openai gpt-6-luna (pi)' },
    { key: 'cache', date: '2026-12-01', text: '删除 tokenizer 旧缓存备份', project: 'lab' },
    { key: 'resume', date: '2026-12-15', text: '恢复文档站重做', project: 'quill', objective: 'docs-site' },
  ],
  en: [
    { key: 'cert', date: '2026-11-22', text: 'Renew the dev machine SSH certificate' },
    { key: 'review', date: '2026-11-24', text: 'Go over the rate-limit plan with the team', project: 'harbor', objective: 'rate-limits' },
    { key: 'sdk', date: '2026-11-27', text: 'Publish the SDK notes', project: 'harbor' },
    { key: 'sonic', date: '2026-12', text: 'sonic model expires → switch to openai gpt-6-luna (pi)' },
    { key: 'cache', date: '2026-12-01', text: 'Delete the old tokenizer cache backup', project: 'lab' },
    { key: 'resume', date: '2026-12-15', text: 'Resume the docs-site rebuild', project: 'quill', objective: 'docs-site' },
  ],
};
/** Which items each day shows: `busy` has an overdue and a due-today item, `quiet` only far ones. */
const DAYS = { busy: ['cert', 'review', 'sdk', 'sonic', 'cache', 'resume'], quiet: ['sonic', 'cache', 'resume'], empty: [] };

let seq = 0;
const id = (prefix) => prefix + (0x10000000 + 0x9e3779b1 * ++seq).toString(16).padStart(16, '0').slice(-16);

/**
 * day: 'busy' | 'quiet' | 'empty'. Returns the base fixture's handle plus `schedulePath`.
 * `now` is the base fixture's NOW (2026-11-24 12:00 UTC); callers run with TZ=UTC so today starts at 00:00.
 */
export async function buildCardsFixture(base, { day = 'busy', lang = 'zh', now = NOW, quietProject = true } = {}) {
  seq = 0;
  const fx = await buildFixture(base);
  const { home, roots } = fx;
  const feature = (root, slug, n, title, at, extra = '') =>
    put(join(root, '.scratch', slug, 'issues', `${n}-t.md`), `# ${n}: ${title}\n\n**Status:** done\n**Blocked by:** none\n\n## Comments\n- Landed ${extra || 'a1b2c3d'}\n`, at);
  // Tickets the day lands. harbor-api's rate-limit-core 01-03, quota-headers 01 and ci-cache 01-04 already exist as done tickets.
  feature(roots.lab, 'tokenizer-bench', '01', 'multilingual sample set', now - 9 * H - 5 * M);
  feature(roots.lab, 'tokenizer-bench', '02', 'sample set loader', now - 2 * H - 5 * M);
  // The quiet project: nothing has happened in sketchbook for 24 days.
  if (quietProject) put(join(roots.sketch, 'STATE.md'), '# State\n\n## Waiting for the owner\n\n## Now\n- Prototype the capture overlay\n\n## Next\n- Pick the colour palette\n', now - 24 * D);

  // One job record per finished job; a land receipt per landing (flows/<flow>.json), as hud_land writes them.
  const job = ({ role, root, ticket, endedAgo, state = 'closed' }) => {
    const j = id('j'), end = now - endedAgo, start = end - 25 * M;
    put(join(home, 'jobs', j, 'job.json'), { job: j, role, cwd: root, project_root: root, ...(ticket && { ticket }), herdr_pane: 'w1:p1', created_at: iso(start), started_at: iso(start) }, start);
    put(join(home, 'jobs', j, 'STATUS.json'), { state, started_at: iso(start), settled_at: iso(end), ended_at: iso(end), ...(state === 'failed' && { exit_reason: 'gate failed twice' }) }, end);
    return j;
  };
  const land = (j, root, agoMs, { reruns = [], repairs = [], sha }) => {
    const f = 'f' + j.slice(1), at = now - agoMs;
    put(join(home, 'flows', f + '.json'), {
      flow: f, job: j, pane: 'w1:p1', task: true, wt: { main_root: root, root: root + '-wt', branch: 'hud/' + j, base_head: 'b'.repeat(40) },
      config: { base: 'main', gate: ['npm test'], after: [], push: false }, state: 'completed', step: 'done', pid: 1, start: 's',
      created_at: iso(at - 4 * M), updated_at: iso(at), source_sha: 's'.repeat(40), landed_sha: sha, landed_at: iso(at), repairs, reruns,
    }, at);
  };
  if (day === 'busy') {
    const landings = [ // [project, ticket, landed this long ago, retried?]
      ['harbor', 'rate-limit-core/03', 40 * M, 0], ['lab', 'tokenizer-bench/02', 2 * H, 0], ['harbor', 'quota-headers/01', 3 * H, 0],
      ['harbor', 'ci-cache/04', 5 * H, 'rerun'], ['harbor', 'ci-cache/03', 6 * H, 0], ['lab', 'tokenizer-bench/01', 9 * H, 'repair'], ['harbor', 'rate-limit-core/02', 10 * H, 0],
    ];
    landings.forEach(([p, ticket, ago, retried], i) => {
      const j = job({ role: 'imp', root: roots[p], ticket, endedAgo: ago - 4 * M });
      land(j, roots[p], ago, { sha: (0xa10000 + i).toString(16) + 'c', ...(retried === 'rerun' && { reruns: [{ step: 'npm test', tests: ['limiter.spec'], rerun_ok: true }] }),
        ...(retried === 'repair' && { repairs: [{ step: 'npm test', job: 'jrepair', outcome: 'fixed' }] }) });
    });
    [['reviewer', 'harbor', 1 * H], ['reviewer', 'harbor', 4 * H], ['reviewer', 'lab', 7 * H], ['sonic', 'harbor', 20 * M], ['sonic', 'harbor', 2 * H], ['sonic', 'lab', 5 * H], ['sonic', 'lab', 8 * H], ['oracle', 'harbor', 3 * H]]
      .forEach(([role, p, ago]) => job({ role, root: roots[p], endedAgo: ago }));
    job({ role: 'imp', root: roots.harbor, ticket: 'ci-cache/05', endedAgo: 4 * H, state: 'failed' });
  } else if (day === 'quiet') {
    // Yesterday's landings are outside today's window; this morning only two small jobs finished.
    [['harbor', 'rate-limit-core/03', 20 * H], ['lab', 'tokenizer-bench/01', 30 * H]].forEach(([p, ticket, ago], i) => {
      const j = job({ role: 'imp', root: roots[p], ticket, endedAgo: ago - 4 * M });
      land(j, roots[p], ago, { sha: (0xb20000 + i).toString(16) + 'd' });
    });
    job({ role: 'sonic', root: roots.harbor, endedAgo: 90 * M }); job({ role: 'sonic', root: roots.lab, endedAgo: 3 * H }); job({ role: 'oracle', root: roots.lab, endedAgo: 5 * H });
  }
  // The proposed store: $HUD_HOME/schedule.json (private, atomic, written only by the MCP op).
  const items = (DAYS[day] ?? []).map((key, i) => {
    const it = ITEMS[lang].find((x) => x.key === key);
    return { id: 's' + (i + 1), date: it.date, text: it.text, ...(it.project && { project: roots[it.project] }), ...(it.objective && { objective: it.objective }), created_at: iso(now - (30 - i) * D) };
  });
  const schedulePath = join(home, 'schedule.json');
  put(schedulePath, { version: 1, seq: items.length, items }, now - 2 * D);
  fs.chmodSync(schedulePath, 0o600);
  return { ...fx, schedulePath, day, now };
}
