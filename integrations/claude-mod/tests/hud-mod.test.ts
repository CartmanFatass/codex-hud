import { expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On } from 'claude-code';
import { bytes } from '../hooks/compact';
import { burst, ids, results } from './fixtures';

declare const console: { log: (text: string) => void }; // the test runner prints it; the figures go in the report
const text = (t: string) => ({ type: 'text' as const, text: t });
const share = (before: number, after: number) => `${before} -> ${after} bytes (-${Math.round((1 - after / before) * 100)}%)`;

/** The engine beneath the mod: every tool call answers `raw()`, as the MCP server's one text block. */
function engine(on: On, raw: () => string) {
  on('turn.start', (_, e) => ({ turnId: e.turnId }));
  on('tool.call', () => ({ result: raw(), text: raw(), ref: 1 }));
}
const hud = async ($: Engine, tool: `mcp__${string}__${string}` = 'mcp__hud__hud_read') => ((await $.tool.call({ tool, job: 'x' })) as { result: string }).result;
const row = async ($: Engine, t: string, origin = 'task-notification') => {
  const stored = await $.session.append({
    message: { type: 'user', role: 'user', isMeta: true, content: [text(t)] },
    door: 'delivery', origin: { kind: origin } as never, uuid: 'u',
  });
  return (stored.message?.content[0] as unknown as { text: string }).text;
};

// What the model must still be able to act on, per fixture: ids, states, hints, summaries, report text.
const keep: Record<string, string[]> = {
  hud_create: [ids.a1, 'role: imp', 'state: working', 'task_dir: ', 'watcher_alive: true', '`hud watch` is live under Monitor', '`hud_read`', 'Imp routing is off'],
  'hud_read digest': [ids.a2, 'state: closed', ids.summary, `hud_read job=${ids.a2} (mode: \\"full\\" for the whole report)`, '"verdict":"Accept"', 'changed_files: 16: src/billing/invoice-total.ts', 'report_exists: true'],
  'hud_read full': [ids.a2, 'state: closed', '**Verdict:** Accept', '## Evidence', 'report_path', 'wrote the report', 'base_head'],
  hud_land: ['f00000000000000b1', 'state: completed', 'landed_sha', 'timings', 'pass 411'],
};

test('each HUD result shrinks and keeps what the model acts on', async ($, on) => {
  let raw = '';
  engine(on, () => raw);
  const figures: string[] = [];
  for (const { name, value } of results) {
    raw = JSON.stringify(value);
    await $.turn.start({ text: '', turnId: name });
    const out = await hud($);
    figures.push(`${name}: ${share(bytes(raw), bytes(out))}`);
    for (const needle of keep[name] ?? []) expect(out).toContain(needle);
    expect(out).not.toMatch(/: null|blocked: false|open_questions: 0/);
    expect(bytes(out)).toBeLessThan(bytes(raw));
  }
  console.log(figures.join('\n'));
});

test('a long changed_files list collapses to a count and the first few; a short one stays', async ($, on) => {
  let raw = '';
  engine(on, () => raw);
  const many = Array.from({ length: 20 }, (_, i) => `src/m${i}.ts`);
  raw = JSON.stringify({ job: ids.a1, changed_files: [...many, '+3 more'] });
  expect(await hud($)).toContain('changed_files: 23: src/m0.ts, src/m1.ts, src/m2.ts, src/m3.ts, src/m4.ts +18 more');
  raw = JSON.stringify({ job: ids.a1, changed_files: ['a.ts', 'b.ts'] });
  expect(await hud($)).toContain('changed_files: ["a.ts","b.ts"]');
});

test('a burst of notices merges into what is new, and the next result drops lines already shown', async ($, on) => {
  let raw = '';
  engine(on, () => raw);
  await $.turn.start({ text: '', turnId: 'burst' });
  const stored: string[] = [];
  for (const r of burst.rows) stored.push(await row($, r));
  raw = JSON.stringify(burst.result.value);
  const result = await hud($);

  // Every id, state, the question with its reply method and each read hint is still said once.
  const all = stored.join('\n');
  for (const line of [ids.question, ...Object.values(ids.lines)]) expect(all.split(line).length - 1).toBe(1);
  expect(stored[0]).toBe(burst.rows[0]);
  expect(stored[2]).toContain('(HUD events already shown this turn)');
  expect(stored[3]).not.toMatch(/<summary>|<task-id>/);
  expect(stored[3]).toContain(`<event>${ids.lines.closed}</event>`);
  // The result's `changes` repeat two lines the rows showed, so it keeps none of them; the rest is kept.
  expect(result).toContain(`hud_read job=${ids.a2}`);
  expect(result).not.toContain('changes:');

  const rowsBefore = burst.rows.reduce((n, r) => n + bytes(r), 0), rowsAfter = stored.reduce((n, r) => n + bytes(r), 0);
  console.log(`notice rows: ${share(rowsBefore, rowsAfter)}\nburst result: ${share(bytes(raw), bytes(result))}`);
});

test('changes lines nobody showed this turn are kept, and a new turn shows them again', async ($, on) => {
  const raw = JSON.stringify({ job: ids.a1, state: 'working', changes: [ids.lines.working] });
  engine(on, () => raw);
  await $.turn.start({ text: '', turnId: 't1' });
  expect(await hud($)).toContain(`changes:\n- ${ids.lines.working}`);
  expect(await hud($)).not.toContain('changes:');
  await $.turn.start({ text: '', turnId: 't2' });
  expect(await hud($)).toContain(`- ${ids.lines.working}`);
});

test('the fixture set as a whole', async ($, on) => {
  let raw = '';
  engine(on, () => raw);
  let before = 0, after = 0;
  for (const { name, value } of results) {
    raw = JSON.stringify(value);
    await $.turn.start({ text: '', turnId: name });
    before += bytes(raw); after += bytes(await hud($));
  }
  await $.turn.start({ text: '', turnId: 'burst' });
  for (const r of burst.rows) { before += bytes(r); after += bytes(await row($, r)); }
  raw = JSON.stringify(burst.result.value);
  before += bytes(raw); after += bytes(await hud($));
  // The report text is the worker's own words, not HUD overhead: figure the set without it too.
  const body = bytes(JSON.stringify((results[2]?.value as { report: string }).report));
  console.log(`fixture set: ${share(before, after)}\nwithout the report body (${body} bytes): ${share(before - body, after - body)}`);
  expect(after).toBeLessThan(before);
});

test('other tools, other rows and failures are untouched', async ($, on) => {
  let raw = '{"a":null,"b":[]}';
  engine(on, () => raw);
  await $.turn.start({ text: '', turnId: 'other' });
  expect(await hud($, 'mcp__other__thing')).toBe(raw);
  raw = '# The ticket guide\n\nPlain text, not JSON.';
  expect(await hud($)).toBe(raw);
  raw = JSON.stringify({ ok: false, code: 'job_not_found' });
  expect(await hud($)).toBe(raw);

  const agent = '<task-notification>\n<task-id>b2</task-id>\n<summary>Agent finished</summary>\n</task-notification>';
  const tests = '<task-notification>\n<task-id>b3</task-id>\n<summary>Monitor event: "tests"</summary>\n<event>PASS a\nPASS a</event>\n</task-notification>';
  expect(await row($, agent)).toBe(agent);
  expect(await row($, tests)).toBe(tests);
  expect(await row($, ids.lines.working, 'composer')).toBe(ids.lines.working);
});

test('a Read or Bash read of a job report is refused with the hud_read hint; other reads are not', async ($, on) => {
  mock.env(on, {});
  on('tool.call', () => ({ result: {} }));
  const report = '/hud-home/jobs/j00000000000000a2/report.md';
  const read = await $.tool.call({ tool: 'Read', file_path: report });
  expect(read.deny).toBe('Read HUD job reports with hud_read job=j00000000000000a2 (mode: "full" for the whole report), not from the file.');
  expect((await $.tool.call({ tool: 'Bash', command: `cat ${report}` })).deny).toContain('hud_read job=j00000000000000a2');
  expect((await $.tool.call({ tool: 'Bash', command: 'tail -n 5 "$HUD_HOME/jobs/$JOB/report.md"' })).deny).toContain('hud_read job=<job>');

  for (const ok of [
    { tool: 'Read' as const, file_path: '/hud-home/jobs/j00000000000000a2/job.json' },
    { tool: 'Read' as const, file_path: '/work/project/report.md' },
    { tool: 'Bash' as const, command: `ls ${report}` },
    { tool: 'Read' as const, file_path: '/work/project/jobs/nightly/report.md' },
    { tool: 'Bash' as const, command: 'cat /work/project/README.md' },
  ]) expect((await $.tool.call(ok)).deny).toBeUndefined();
});

test('a worker session may read a job report: it has no hud_read', async ($, on) => {
  mock.env(on, { HUD_JOB_DIR: '/hud-home/jobs/j00000000000000a9' });
  on('tool.call', () => ({ result: {} }));
  const read = await $.tool.call({ tool: 'Read', file_path: '/hud-home/jobs/j00000000000000a2/report.md' });
  expect(read.deny).toBeUndefined();
});
