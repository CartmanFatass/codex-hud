import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectAndRenderParity } from '../../src/statusline-parity/collect.js';
import { collectTranscript, TRANSCRIPT_CHUNK } from '../../src/statusline-parity/transcript.js';
import { collectParityGit } from '../../src/statusline-parity/git.js';
import { paritySettings } from '../../src/statusline-parity/settings.js';
import { NOW, OWNER_CONFIG, SCENARIOS, parityFixture } from '../fixtures/claude-hud-parity/fixture.js';
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
  ...SCENARIOS.map((scenario) => ({
    name: 'installed 0.8.0 golden: ' + scenario,
    run: (t: test.TestContext) => {
      const f = fixture(t, scenario);
      const output = collectAndRenderParity(f.input, f.width, paritySettings(OWNER_CONFIG), f.env, NOW);
      assert.equal(
        strip(output) + '\n',
        fs.readFileSync(resolve('tests/fixtures/claude-hud-parity', scenario + '.txt'), 'utf8')
      );
      if (scenario === 'quota-critical') assert.match(output, /\x1b\[31m/);
      if (scenario !== 'sparse') assert.equal(collectTranscript(f.file, f.env).bytesRead, 0);
    },
  })),
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
      assert.equal(strip(r.stdout), fs.readFileSync(resolve('tests/fixtures/claude-hud-parity/narrow.txt'), 'utf8'));
      const details = run(['--details']);
      assert.equal(details.status, 0, details.stderr);
      assert.doesNotMatch(details.stdout, /Explore/);
    },
  },
];
test('B16 statusline parity: installed goldens and bounded real collectors', async (t) => {
  for (const row of rows) await t.test(row.name, row.run);
});
