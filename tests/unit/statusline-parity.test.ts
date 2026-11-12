import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderParity } from '../../src/statusline-parity/render.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { visualWidth } from '../../src/render/colors.js';
import { collectTranscript, TRANSCRIPT_CHUNK } from '../../src/statusline-parity/transcript.js';
import { collectParityGit } from '../../src/statusline-parity/git.js';
import { paritySettings } from '../../src/statusline-parity/settings.js';
import { NOW, OWNER_CONFIG, parityFixture } from '../fixtures/claude-hud-parity/fixture.js';
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
function fixture(t: test.TestContext, scenario: Parameters<typeof parityFixture>[1] = 'idle') {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-parity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return parityFixture(home, scenario);
}
const tool = (name: string, id: string, input: object, time = '2026-01-02T11:59:30Z') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: time,
    message: { content: [{ type: 'tool_use', name, id, input }] },
  }) + '\n';
const rows: { name: string; run: (t: test.TestContext) => void | Promise<void> }[] = [
  {
    name: 'Claude bar at 120 columns: one line, the Codex bar grammar in the shared order',
    run(t) {
      const previous = setDisplayConfig({ theme: 'none' });
      t.after(() => setDisplayConfig(previous));
      const transcript = {
        agents: [
          { id: 'a', type: 'Explore', description: 'Older', start: NOW - 90000, startPos: 1, background: false },
          {
            id: 'b',
            type: 'frontend-implementer',
            model: 'claude-sonnet-5-5',
            description: 'BAR-UNIFY one-line bars',
            start: NOW - 12 * 60000,
            startPos: 2,
            background: false,
          },
        ],
        todos: [
          { content: 'One', status: 'completed' },
          { content: 'Two', status: 'in_progress' },
        ],
        skills: ['hud-delegate'],
        sessionStart: NOW - 5 * 60000,
        ultracode: false,
        bytesRead: 0,
        pendingHistory: false,
      };
      const input = {
        model: { display_name: 'Opus 5.5' },
        effort: 'high',
        cwd: '/synthetic/project',
        context_window: { used_percentage: 4, context_window_size: 1000000 },
        rate_limits: { five_hour: { used_percentage: 8, resets_at: (NOW + 79 * 60000) / 1000 } },
      };
      const evidence = {
        transcript,
        counts: { claudeMdCount: 2, rulesCount: 0, mcpCount: 4, hooksCount: 0 },
        git: { branch: 'main', dirty: true, ahead: 0, behind: 0 },
      };
      const line = renderParity(
        input,
        120,
        paritySettings(OWNER_CONFIG),
        evidence,
        NOW,
        {},
        'Work: 1 needs you · 2 running'
      );
      assert.ok(!line.includes('\n') && visualWidth(line) <= 120, 'one row that fits the width');
      // Under pressure the effort, meter and reset time go, the description is cut at a word, the model drops.
      assert.match(
        strip(line),
        /^Opus 5\.5 │ 4%\/1M │ project main\* │ 5h 8% │ ◐ frontend-implementer: BAR-UNIFY… 12m \+1 │ Tasks 1\/2 │ Work: 1 needs you$/
      );
      // With room, the newest running agent is told in full, and the right cluster (what Claude loaded) follows.
      assert.match(
        strip(
          renderParity(input, 240, paritySettings(OWNER_CONFIG), evidence, NOW, {}, 'Work: 1 needs you · 2 running')
        ),
        /^Opus 5\.5 high │ [━╸]*─+ 4%\/1M │ project main\* │ 5h 8% reset 1h19m │ ◐ frontend-implementer \[sonnet-5\.5\]: BAR-UNIFY one-line bars 12m \+1 │ Tasks 1\/2 │ Work: 1 needs you · 2 running {3,}CLAUDE\.md 2 {2}MCP 4 {2}skills 1 {2}session 5m$/
      );
      // With none running, the counts.
      const idle = {
        ...evidence,
        transcript: { ...transcript, agents: transcript.agents.map((a) => ({ ...a, end: NOW - 5000 })) },
      };
      assert.match(strip(renderParity(input, 120, paritySettings(OWNER_CONFIG), idle, NOW)), /Agents 2✓/);
      // Narrower, whole segments go, lowest priority first; the line never wraps.
      for (const width of [100, 60, 30]) {
        const narrow = renderParity(input, width, paritySettings(OWNER_CONFIG), evidence, NOW, {}, '');
        assert.ok(!narrow.includes('\n') && visualWidth(narrow) <= width, strip(narrow));
      }
    },
  },
  {
    name: 'append growth reads only new bytes; malformed records and split UTF-8 are not fatal',
    run(t) {
      const f = fixture(t);
      collectTranscript(f.file, f.env);
      const appended = 'not-json\n' + tool('Agent', 'a', { subagent_type: 'Explore', description: 'Synthetic' });
      fs.appendFileSync(f.file, appended);
      let v = collectTranscript(f.file, f.env);
      assert.equal(v.bytesRead, Buffer.byteLength(appended));
      assert.equal(v.agents.length, 1);
      assert.equal(collectTranscript(f.file, f.env).bytesRead, 0);
      const bytes = Buffer.from(
        tool('TodoWrite', 'todos', { todos: [{ content: 'Synthetic 中文', status: 'in_progress' }] })
      );
      const split = bytes.indexOf(Buffer.from('中')) + 1;
      fs.appendFileSync(f.file, bytes.subarray(0, split));
      collectTranscript(f.file, f.env);
      fs.appendFileSync(f.file, bytes.subarray(split));
      v = collectTranscript(f.file, f.env);
      assert.equal(v.todos[0].content, 'Synthetic 中文');
      const final = tool('Agent', 'no-newline', { subagent_type: 'tail' }).trimEnd();
      fs.appendFileSync(f.file, final);
      assert.ok(collectTranscript(f.file, f.env).agents.some((a) => a.id === 'no-newline'));
      fs.appendFileSync(f.file, '\n');
      v = collectTranscript(f.file, f.env);
      assert.equal(v.bytesRead, 1);
      assert.equal(v.agents.filter((a) => a.id === 'no-newline').length, 1);
    },
  },
  {
    name: 'truncation and replacement reset cached activity',
    run(t) {
      const f = fixture(t, 'agents-todos');
      assert.equal(collectTranscript(f.file, f.env).agents.length, 1);
      fs.writeFileSync(f.file, '{}\n');
      assert.equal(collectTranscript(f.file, f.env).agents.length, 0);
      const next = f.file + '.next';
      fs.writeFileSync(next, tool('Agent', 'new', { subagent_type: 'new' }));
      fs.renameSync(next, f.file);
      assert.equal(collectTranscript(f.file, f.env).agents[0].type, 'new');
    },
  },
  {
    name: 'cold head and tail first; backward catch-up never revives completion or overwrites latest todo',
    run(t) {
      const f = fixture(t);
      const old =
        tool('Agent', 'old', { subagent_type: 'old' }) +
        tool('TodoWrite', 'old-todo', { todos: [{ content: 'old', status: 'in_progress' }] });
      const filler = '{}\n'.repeat(Math.ceil(TRANSCRIPT_CHUNK / 3) + 100);
      const latest =
        tool('TodoWrite', 'new-todo', { todos: [{ content: 'latest', status: 'pending' }] }) +
        tool('TaskUpdate', 'latest-update', { taskId: 'stable-id', status: 'completed' }) +
        JSON.stringify({
          type: 'queue-operation',
          timestamp: '2026-01-02T11:59:50Z',
          content: '<tool-use-id>old</tool-use-id>',
        }) +
        '\n';
      const middle = '{}\n'.repeat(6000) + tool('TaskCreate', 'created', { taskId: 'stable-id', subject: 'latest' });
      fs.writeFileSync(f.file, old + middle + filler + latest);
      let v = collectTranscript(f.file, f.env);
      assert.equal(v.todos[0].content, 'latest');
      assert.equal(v.pendingHistory, true);
      assert.ok(v.bytesRead <= TRANSCRIPT_CHUNK + 16384);
      for (let i = 0; i < 10 && v.pendingHistory; i++) v = collectTranscript(f.file, f.env);
      assert.equal(v.pendingHistory, false);
      assert.equal(v.todos[0].content, 'latest');
      assert.equal(v.todos[0].status, 'completed');
      assert.equal(v.agents.find((a) => a.id === 'old')?.end, Date.parse('2026-01-02T11:59:50Z'));
      assert.equal(collectTranscript(f.file, f.env).bytesRead, 0);
    },
  },
  {
    name: 'git safety: fsmonitor, filters and transport commands cannot run from repository config',
    run(t) {
      const f = fixture(t, 'dirty-git'),
        marker = join(f.home, 'must-not-exist'),
        script = join(f.home, 'hostile.sh');
      fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
      f.git(['config', 'core.fsmonitor', script]);
      f.git(['config', 'core.sshCommand', script]);
      f.git(['config', 'filter.hostile.clean', script]);
      f.git(['config', 'filter.hostile.process', script]);
      fs.writeFileSync(join(f.cwd, '.gitattributes'), 'base filter=hostile\n');
      const value = collectParityGit(f.cwd, f.env);
      assert.equal(value?.branch, 'main');
      assert.equal(value?.dirty, true);
      assert.equal(fs.existsSync(marker), false);
      f.git(['config', 'filter.unsafe=name.clean', script]);
      fs.rmSync(join(f.hud, 'display'), { recursive: true, force: true });
      assert.equal(collectParityGit(f.cwd, f.env), null);
      assert.equal(fs.existsSync(marker), false);
    },
  },
  {
    name: 'trusted global filter still normalizes the worktree, without enabling repository filters',
    run(t) {
      const f = fixture(t),
        script = join(f.home, 'trusted-filter.sh'),
        marker = join(f.home, 'trusted-ran');
      f.git(['init', '-b', 'main']);
      fs.writeFileSync(join(f.cwd, 'base'), 'base');
      fs.writeFileSync(join(f.cwd, '.gitattributes'), 'base filter=trusted\n');
      f.git(['add', '.']);
      f.git(['commit', '-m', 'base']);
      // Equal byte size forces Git's read-only status path to hash through the filter,
      // rather than its conservative size-only dirty shortcut (which skips hashing).
      fs.writeFileSync(join(f.cwd, 'base'), 'edit');
      fs.writeFileSync(script, `#!/bin/sh\nprintf base\nprintf yes > '${marker}'\n`, { mode: 0o700 });
      fs.writeFileSync(join(f.home, '.gitconfig'), `[filter "trusted"]\nclean = ${script}\n`);
      const v = collectParityGit(f.cwd, f.env);
      assert.equal(v?.branch, 'main');
      assert.equal(v?.dirty, false);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'yes');
    },
  },
  {
    name: 'task IDs, background completion, ultracode and bounded agent history survive incremental rendering',
    run(t) {
      const f = fixture(t);
      fs.appendFileSync(
        f.file,
        tool('TaskCreate', 'create-one', { taskId: 'one', subject: 'Duplicate' }) +
          tool('TaskCreate', 'create-two', { taskId: 'two', subject: 'Duplicate' }) +
          tool('TodoWrite', 'snapshot', {
            todos: [
              { content: 'Duplicate', status: 'pending' },
              { content: 'Duplicate', status: 'pending' },
            ],
          }) +
          tool('TaskUpdate', 'update', { taskId: 'two', status: 'in_progress' }) +
          tool('Agent', 'background', { run_in_background: true, subagent_type: 'Explore' })
      );
      let v = collectTranscript(f.file, f.env);
      assert.equal(v.todos[0].status, 'pending');
      assert.equal(v.todos[1].status, 'in_progress');
      fs.appendFileSync(
        f.file,
        JSON.stringify({
          type: 'user',
          timestamp: '2026-01-02T11:59:40Z',
          message: { content: [{ type: 'tool_result', tool_use_id: 'background' }] },
        }) +
          '\n' +
          JSON.stringify({ type: 'attachment', attachment: { type: 'ultra_effort_enter' } }) +
          '\n'
      );
      v = collectTranscript(f.file, f.env);
      assert.equal(v.agents[0].end, undefined);
      assert.equal(v.ultracode, true);
      fs.appendFileSync(
        f.file,
        JSON.stringify({
          type: 'queue-operation',
          timestamp: '2026-01-02T11:59:50Z',
          content: '<tool-use-id>background</tool-use-id>',
        }) + '\n'
      );
      assert.equal(collectTranscript(f.file, f.env).agents[0].end, Date.parse('2026-01-02T11:59:50Z'));
      // A request echo (no timestamp) of the same tool call changes neither its start nor its end.
      const started = collectTranscript(f.file, f.env).agents[0].start;
      fs.appendFileSync(
        f.file,
        JSON.stringify({
          type: 'api-request-blob',
          message: { content: [{ type: 'tool_use', name: 'Agent', id: 'background', input: {} }] },
        }) + '\n'
      );
      v = collectTranscript(f.file, f.env);
      assert.equal(v.agents[0].start, started);
      assert.equal(v.agents[0].end, Date.parse('2026-01-02T11:59:50Z'));
      // Many ordinary results must not consume the separate agent budget.
      fs.appendFileSync(
        f.file,
        Array.from(
          { length: 220 },
          (_, i) =>
            JSON.stringify({
              type: 'user',
              message: { content: [{ type: 'tool_result', tool_use_id: 'ordinary-' + i }] },
            }) + '\n'
        ).join('') + tool('Agent', 'latest', { subagent_type: 'latest' })
      );
      assert.ok(collectTranscript(f.file, f.env).agents.some((a) => a.id === 'latest'));
    },
  },
  {
    name: 'actual CLI enables parity and uses width margin; explicit details still wins',
    run(t) {
      const f = fixture(t, 'narrow'),
        clock = join(f.home, 'clock.mjs');
      fs.writeFileSync(
        clock,
        `const Original=Date;globalThis.Date=class extends Original{constructor(...a){super(...(a.length?a:[${NOW}]))}static now(){return ${NOW}}};`
      );
      const run = (args: string[]) =>
        spawnSync(process.execPath, ['--import', clock, resolve('bin/hud-statusline'), ...args], {
          env: { ...f.env, COLUMNS: '40' },
          input: JSON.stringify(f.input),
          encoding: 'utf8',
          timeout: 5000,
        });
      const r = run([]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(strip(r.stdout), /^[^\n]+\n$/, 'the line is one row');
      assert.ok(visualWidth(strip(r.stdout).trimEnd()) <= 36, 'and fits the width margin');
      const details = run(['--details']);
      assert.equal(details.status, 0, details.stderr);
      assert.doesNotMatch(details.stdout, /Explore/);
    },
  },
];
test('B16 statusline parity: one-line Codex-grammar render and bounded real collectors', async (t) => {
  for (const row of rows) await t.test(row.name, row.run);
});
