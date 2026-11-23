import { expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On } from 'claude-code';
import { burst, ids } from './fixtures';

const text = (t: string) => ({ type: 'text' as const, text: t });

/** The engine beneath the mod: every tool call answers `raw()`, as the MCP server's one text block. */
function engine(on: On, raw: () => string) {
  mock.env(on, {});
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

test('a burst of notices merges into what is new, and the next result drops lines already shown', async ($, on) => {
  const body = `job: ${ids.a2}\nstate: closed\ndigest: ${JSON.stringify({ read_hint: ids.readHint(ids.a2) })}`;
  const raw = `${body}\nchanges:\n- ${ids.lines.closed}\n- ${ids.lines.land}`;
  engine(on, () => raw);
  await $.turn.start({ text: '', turnId: 'burst' });
  const stored: string[] = [];
  for (const r of burst.rows) stored.push(await row($, r));
  const result = await hud($);

  // Every id, state, the question with its reply method and each read hint is still said once.
  const all = stored.join('\n');
  for (const line of [ids.question, ...Object.values(ids.lines)]) expect(all.split(line).length - 1).toBe(1);
  expect(stored[0]).toBe(burst.rows[0]);
  expect(stored[2]).toContain('(HUD events already shown this turn)');
  expect(stored[3]).not.toMatch(/<summary>|<task-id>/);
  expect(stored[3]).toContain(`<event>${ids.lines.closed}</event>`);
  expect(result).toBe(body);
});

test('changes lines nobody showed this turn are kept, and a new turn shows them again', async ($, on) => {
  const body = `job: ${ids.a1}\nstate: working`;
  let raw = `${body}\nchanges:\n- ${ids.lines.working}`;
  engine(on, () => raw);
  await $.turn.start({ text: '', turnId: 't1' });
  expect(await hud($)).toBe(raw);
  expect(await row($, burst.rows[0])).toContain('(HUD events already shown this turn)');
  const mixed = `${body}\nchanges:\n- ${ids.lines.working}\n- ${ids.lines.waiting}`;
  raw = mixed;
  expect(await hud($)).toBe(`${body}\nchanges:\n- ${ids.lines.waiting}`);
  expect(await hud($)).toBe(body);
  raw = `changes:\n- ${ids.lines.waiting}`;
  expect(await hud($)).toBe('(HUD events already shown this turn)');
  await $.turn.start({ text: '', turnId: 't2' });
  raw = mixed;
  expect(await hud($)).toBe(mixed);
});

test('other tools, other rows and failures are untouched', async ($, on) => {
  let raw = '{"a":null,"b":[]}';
  engine(on, () => raw);
  await $.turn.start({ text: '', turnId: 'other' });
  expect(await hud($, 'mcp__other__thing')).toBe(raw);
  expect(await hud($)).toBe(raw); // HUD_MCP_JSON=1 and legacy JSON aren't reserialized by the mod.
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
    { tool: 'Bash' as const, command: 'cat /work/project/README.md' },
  ]) expect((await $.tool.call(ok)).deny).toBeUndefined();
});

test('a worker session may read a job report: it has no hud_read', async ($, on) => {
  mock.env(on, { HUD_JOB_DIR: '/hud-home/jobs/j00000000000000a9' });
  on('tool.call', () => ({ result: {} }));
  const read = await $.tool.call({ tool: 'Read', file_path: '/hud-home/jobs/j00000000000000a2/report.md' });
  expect(read.deny).toBeUndefined();
});
