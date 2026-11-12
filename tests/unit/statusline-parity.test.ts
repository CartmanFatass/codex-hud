import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { visualWidth } from '../../src/render/colors.js';
import { collectTranscript, TRANSCRIPT_CHUNK } from '../../src/statusline-parity/transcript.js';
import { collectParityGit } from '../../src/statusline-parity/git.js';
import { paritySettings } from '../../src/statusline-parity/settings.js';
import { NOW, parityFixture } from '../fixtures/claude-hud-parity/fixture.js';
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
      // A skill load is dated by its call, the latest call counts, and the echo (no timestamp) is no load.
      fs.appendFileSync(f.file, tool('Skill', 'skill-1', { skill: 'hud-delegate' }, '2026-01-02T11:59:31Z'));
      fs.appendFileSync(f.file, tool('Skill', 'skill-2', { skill: 'hud-delegate' }, '2026-01-02T11:59:35Z'));
      fs.appendFileSync(
        f.file,
        JSON.stringify({
          type: 'api-request-blob',
          message: { content: [{ type: 'tool_use', name: 'Skill', id: 'echo', input: { skill: 'other' } }] },
        }) + '\n'
      );
      v = collectTranscript(f.file, f.env);
      assert.deepEqual(v.skillLoads, [{ name: 'hud-delegate', at: Date.parse('2026-01-02T11:59:35Z') }]);
      assert.deepEqual(v.skills, ['hud-delegate']);
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
      const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
        spawnSync(process.execPath, ['--import', clock, resolve('bin/hud-statusline'), ...args], {
          env: { ...f.env, COLUMNS: '40', ...extraEnv },
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
      fs.appendFileSync(clock, `
        const {default:fs}=await import('node:fs'); const {syncBuiltinESMExports}=await import('node:module');
        let credentials=0,jobs=0; for(const key of ['existsSync','openSync','statSync','lstatSync','readFileSync']) {
          const original=fs[key]; fs[key]=function(file,...args){if(String(file).endsWith('/credentials.env')) credentials++;
            if(key==='openSync' && String(file).endsWith('/job.json')) jobs++; return original.call(this,file,...args)};
        } syncBuiltinESMExports(); process.on('exit',()=>console.error(JSON.stringify({credentials,jobs})));
      `);
      const settings = join(f.env.HUD_HOME!, 'hud-settings.json');
      const plain = run([], { NO_COLOR: '1' }).stdout;
      for (const value of ['{}', '{"barStyle":"bad","barFields":["bad"]}', '{']) {
        fs.writeFileSync(settings, value);
        const result = run([], { NO_COLOR: '1' });
        assert.equal(result.stdout, plain); assert.equal(result.stderr.trim(), '{"credentials":0,"jobs":0}');
      }
      fs.writeFileSync(settings, '{"barStyle":"p10k","barFields":["model"]}');
      const modelOnly = run([], { NO_COLOR: '1' }).stdout;
      assert.notEqual(modelOnly, plain); assert.doesNotMatch(modelOnly.replace(/\x1b\[0m/g, ''), /\x1b\[/);
      fs.unlinkSync(settings);
      assert.equal(run([], { NO_COLOR: '1', HUD_BAR_FIELDS: 'model', HUD_BAR_STYLE: 'p10k' }).stdout, modelOnly);
      for (let n = 0; n < 300; n++) {
        const job = `j${n.toString(16).padStart(16, '0')}`, dir = join(f.env.HUD_HOME!, 'jobs', job);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job, role: 'imp', herdr_pane: 'synthetic', created_at: new Date(0).toISOString() }));
        fs.writeFileSync(join(dir, 'STATUS.json'), '{"state":"closed","settled_at":"2000-01-01T00:00:00Z"}');
      }
      const cold = run([], { NO_COLOR: '1', HERDR_PANE_ID: 'synthetic' });
      assert.equal(cold.status, 0); assert.equal(cold.stdout, plain);
      assert.equal(cold.stderr.trim(), '{"credentials":0,"jobs":0}', 'cold process opens no old receipts or credentials');
    },
  },
];
test('B16 statusline parity: one-line Codex-grammar render and bounded real collectors', async (t) => {
  for (const row of rows) await t.test(row.name, row.run);
});
