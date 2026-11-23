import { basename } from 'node:path';
import { collectJobStats, DEFAULT_STATS_DAYS, groupings, groupJobStats, localDayStart, MAX_STATS_DAYS, summarizeJobs,
  type GroupBy, type JobStats } from '../collectors/job-stats.js';
import { publicJobLine } from '../roles/job-archive.js';
import { sharedRoot } from '../roles/projects.js';
import type { HudIO } from './hud.js';
import { CliError, privateHome } from './private-home.js';

const STATS = 'Usage: hud stats [--days N] [--by role|model|route|feature]';
const DAY = 'Usage: hud day [--project]';
const money = (n: number) => '$' + (n > 0 && n < 0.01 ? n.toPrecision(2) : n.toFixed(2));
const label = (value?: string) => value ? publicJobLine(value).replaceAll('|', '¦') || 'unknown' : 'unknown';
const number = (n: number) => n.toLocaleString('en-US');
function measured({ total, known }: { total: number; known: number }, jobs: number, format = number) {
  return `${known ? format(total) : 'unknown'} (${known}/${jobs})`;
}
function coverage({ coverage: c, cohort, children }: JobStats) {
  const total = summarizeJobs(cohort, children), u = total.usage;
  return `Coverage: ${c.live} retained + ${c.archive} archived jobs; ${c.flows} flow receipts in range; ${c.skipped} unreadable/invalid${c.limited ? '; scan limits reached' : ''}.\n` +
    `Known jobs (of ${cohort.length}): time ${total.time.known}, questions ${total.questions.known}, input ${u.input.known}, cache read ${u.cache_read.known}, cache write ${u.cache_write.known}, output ${u.output.known}, cost ${u.cost_usd.known}.\n`;
}
const groups = (s: JobStats, by: GroupBy) => groupJobStats(s, by).map(g => ({ ...g, name: g.label.map(label).join(' / ') }));
export function formatStats(s: JobStats, by: GroupBy, days: number) {
  const header = by === 'place' ? 'role / place / mode' : by === 'route' ? 'route tier / mode' : by;
  const lines = groups(s, by).map(g => {
    const { input, cache_read, cache_write, output, cost_usd } = g.usage;
    const med = g.median === undefined ? 'unknown' : g.median.toFixed(1);
    const q = g.questions.known ? (g.questions.total / g.questions.known).toFixed(2) : 'unknown';
    const lands = g.land.observed ? `${g.land.repaired}/${g.land.landed} (${g.land.observed} jobs with flow outcome)` : 'unknown';
    return `${g.name} | ${g.jobs} | ${med} (${g.time.known}/${g.jobs}) | ${q} (${g.questions.known}/${g.jobs}) | ${(g.sonic / g.jobs).toFixed(2)} | ${lands}\n` +
      `  Tokens: input ${measured(input, g.jobs)}, cache read ${measured(cache_read, g.jobs)}, cache write ${measured(cache_write, g.jobs)}, output ${measured(output, g.jobs)}; cost ${measured(cost_usd, g.jobs, money)}.`;
  });
  return `Job stats · ${days} local day${days === 1 ? '' : 's'} including today\n${coverage(s)}` +
    'Per-job totals, where reported; counts in parentheses show known/observed jobs. Sonic counts are observed only.\n' +
    `${header} | jobs | median min | questions/job | sonic/job | landed with repair / landed\n` +
    (lines.length ? lines.join('\n') : 'No jobs observed.') + '\n';
}
export function formatDay(s: JobStats, now: number, project?: string) {
  const date = new Date(now).toLocaleDateString('en-CA');
  const ref = (j: { ticket?: string; job: string }) => label(j.ticket ?? j.job);
  const section = (title: string, lines: string[]) => `\n${title}\n${lines.length ? lines.map(line => `  ${line}`).join('\n') : '  None observed'}\n`;
  return `HUD day · ${date} · ${project ? label(basename(project)) : 'all projects'}\n${coverage(s)}` +
    section('Landed', s.landed.map(({ job, sha }) => `${ref(job)}${sha ? ` · ${label(sha.slice(0, 8))}` : ''} · ${job.summary ? label(job.summary) : 'summary unknown'}`)) +
    section('Failures and stops', [
      ...s.failures.map(j => `${ref(j)} · ${label(j.role)} · ${j.state === 'failed' || j.state === 'stopped' ? j.state : 'dispatch failed'}`),
      ...s.landFailures.map(f => `${ref(f.job)} · land attempt ${f.attempt} ${f.state}`),
    ]) +
    section('Flaky gate tests (passed on immediate rerun)', s.flaky.map(([name, n]) => `${n}× ${label(name)}`)) +
    section('Worker time and reported cost by role (jobs started today)', groups(s, 'role').map(g =>
      `${g.name} · ${g.jobs} jobs · ${measured(g.time, g.jobs, n => `${n.toFixed(1)} min`)} · cost ${measured(g.usage.cost_usd, g.jobs, money)}`));
}
export async function jobStatsCommand(command: 'stats' | 'day', args: readonly string[], io: HudIO): Promise<number> {
  const usage = command === 'day' ? DAY : STATS;
  if (args.length === 1 && args[0] === '--help') { await io.stdout(usage + '\n'); return 0; }
  let days = command === 'day' ? 1 : DEFAULT_STATS_DAYS, by: GroupBy = 'place', project: string | undefined;
  if (command === 'day') {
    if (args.length === 1 && args[0] === '--project') project = sharedRoot(process.cwd());
    else if (args.length) throw new CliError(usage);
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i += 2) {
      const [flag, value] = [args[i]!, args[i + 1]];
      if (!value || seen.has(flag)) throw new CliError(usage);
      seen.add(flag);
      if (flag === '--days' && /^\d+$/.test(value) && +value >= 1 && +value <= MAX_STATS_DAYS) days = +value;
      else if (flag === '--by' && (groupings as readonly string[]).includes(value)) by = value as GroupBy;
      else throw new CliError(usage);
    }
  }
  const now = Date.now(), stats = collectJobStats(privateHome(io.env), localDayStart(now, days), now, project);
  await io.stdout(command === 'day' ? formatDay(stats, now, project) : formatStats(stats, by, days));
  return 0;
}
