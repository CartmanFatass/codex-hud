import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  cliState,
  fixture,
  publishPiGrace,
  resultValue,
  taskCall,
  taskJob,
  taskRpc,
  until,
  workerFor,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { defaultSettings, loadSettings, saveSettings } from '../../dist/settings.js';
import {
  SETTING_ROWS,
  handleSettingsInput,
  renderSettingsPage,
  resetSettingsGroup,
  settingsDirty,
} from '../../dist/render/settings-page.js';
import { readThinJobRows, readThinJobs, formatJobChange } from '../../dist/collectors/thin-jobs.js';
import { projectWorkCard } from '../../dist/collectors/work-card.js';
import { renderWorkCard } from '../../dist/render/work-card.js';
import { renderMonitor, initialMonitorState } from '../../dist/render/monitor.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stopJob } from '../../dist/cli/panel-pane.js';

function writeHudSettings(f, patch) {
  const file = f.env.HUD_SETTINGS_PATH;
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  writeFixtureFile(file, JSON.stringify({ ...current, ...patch }, null, 2) + '\n');
}

function writeStatus(dir, status) {
  writeFixtureFile(join(dir, 'STATUS.json'), JSON.stringify(status, null, 2) + '\n');
}

test('settings defaults, validation, Settings UI rows, dirty tracking and group reset for roleCaps and impOverflow', (t) => {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(join(process.env.HOME || '/tmp', 'hud-cap-settings-'));
  process.env.HUD_SETTINGS_PATH = join(dir, 'hud-settings.json');
  t.after(() => {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const defaults = defaultSettings();
  assert.deepEqual(defaults.roleCaps, { imp: 3, general: 3 });
  assert.equal(defaults.impOverflow, true);
  assert.deepEqual(loadSettings().roleCaps, { imp: 3, general: 3 });
  assert.equal(loadSettings().impOverflow, true);

  // Partial roleCaps keeps other defaults; invalid entries are ignored.
  fs.writeFileSync(process.env.HUD_SETTINGS_PATH, JSON.stringify({ roleCaps: { imp: 5, reviewer: 2 }, impOverflow: false }));
  assert.deepEqual(loadSettings().roleCaps, { imp: 5, general: 3, reviewer: 2 });
  assert.equal(loadSettings().impOverflow, false);

  fs.writeFileSync(process.env.HUD_SETTINGS_PATH, JSON.stringify({ roleCaps: { imp: -1 }, impOverflow: 'yes' }));
  assert.deepEqual(loadSettings().roleCaps, { imp: 3, general: 3 });
  assert.equal(loadSettings().impOverflow, true);

  // Settings UI shows Workers group with imp cap, general cap, imp→general overflow.
  const impIdx = SETTING_ROWS.findIndex((r) => r.group === 'Workers' && r.role === 'imp');
  const genIdx = SETTING_ROWS.findIndex((r) => r.group === 'Workers' && r.role === 'general');
  const ovfIdx = SETTING_ROWS.findIndex((r) => r.group === 'Workers' && r.key === 'impOverflow');
  assert.ok(impIdx >= 0 && genIdx >= 0 && ovfIdx >= 0);

  const original = loadSettings();
  let state = { draft: { ...original, roleCaps: { ...original.roleCaps } }, original, selected: impIdx, offset: 0, message: '' };
  assert.equal(settingsDirty(state), false);

  const frame1 = renderSettingsPage(state, 80, 48);
  const text1 = frame1.lines.map(stripAnsi).join('\n');
  assert.match(text1, /Workers/);
  assert.match(text1, /imp cap\s+‹ 3 ›/);
  assert.match(text1, /general cap\s+3/);
  assert.match(text1, /imp→general overflow\s+on/);

  state = handleSettingsInput(state, { type: 'key', key: 'right' }, frame1).state;
  assert.equal(state.draft.roleCaps.imp, 4);
  assert.equal(settingsDirty(state), true);

  // Cycling back to original clears dirty state.
  state = handleSettingsInput(state, { type: 'key', key: 'left' }, renderSettingsPage(state, 80, 48)).state;
  assert.equal(state.draft.roleCaps.imp, 3);
  assert.equal(settingsDirty(state), false);

  // Toggle overflow off and save.
  state = { ...state, selected: ovfIdx };
  state = handleSettingsInput(state, { type: 'key', key: 'right' }, renderSettingsPage(state, 80, 48)).state;
  assert.equal(state.draft.impOverflow, false);
  saveSettings(state.draft);
  assert.equal(loadSettings().impOverflow, false);

  // Reset Workers group restores defaults.
  const reset = resetSettingsGroup({ ...state.draft, roleCaps: { imp: 8, general: 1 } }, 'Workers');
  assert.deepEqual(reset.roleCaps, { imp: 3, general: 3 });
  assert.equal(reset.impOverflow, true);
});

test('three working imps overflow fourth imp to general and queue once both caps are full', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const imps = [];
  for (let i = 1; i <= 3; i++) {
    const job = await f.call('hud_create', { role: 'imp', task: `Synthetic imp ${i}.`, request_key: `imp-${i}` });
    assert.equal(job.role, 'imp');
    assert.equal(job.state, 'working');
    assert.equal(job.overflowed, undefined);
    imps.push(job);
  }

  // With 3 working imps and <3 generals, imp create overflows to general and says so.
  const overflow1 = await f.call('hud_create', { role: 'imp', task: 'Synthetic overflow 1.', request_key: 'ovf-1' });
  assert.equal(overflow1.role, 'general');
  assert.equal(overflow1.overflowed, true);
  assert.equal(overflow1.overflow_from, 'imp');
  assert.equal(overflow1.state, 'working');

  const overflow2 = await f.call('hud_create', { role: 'imp', task: 'Synthetic overflow 2.', request_key: 'ovf-2' });
  const overflow3 = await f.call('hud_create', { role: 'imp', task: 'Synthetic overflow 3.', request_key: 'ovf-3' });
  assert.equal(overflow2.role, 'general');
  assert.equal(overflow2.overflowed, true);
  assert.equal(overflow3.role, 'general');
  assert.equal(overflow3.overflowed, true);

  // Now 3 imps and 3 generals are working (6 implementers): next imp queues!
  const q1 = await f.call('hud_create', { role: 'imp', task: '# Queued task one\n\nWait for a slot.', request_key: 'q-1', package: 'cap-pkg' });
  assert.equal(q1.role, 'imp');
  assert.equal(q1.state, 'queued');
  assert.equal(q1.display_state, 'queued');
  assert.equal(q1.queued, true);
  assert.equal(q1.queue_position, 1);
  assert.equal(q1.agent, null);
  assert.match(fs.readFileSync(join(q1.task_dir, 'brief.md'), 'utf8'), /# Queued task one/);

  const q2 = await f.call('hud_create', { role: 'imp', task: '# Queued task two\n\nSecond in line.', request_key: 'q-2' });
  assert.equal(q2.state, 'queued');
  assert.equal(q2.queued, true);
  assert.equal(q2.queue_position, 2);

  // Notice formatting includes queued and position.
  const rows = readThinJobRows(f.env.HUD_HOME, { pane: 'w4E:p1' });
  const r1 = rows.find((r) => r.job === q1.job);
  const r2 = rows.find((r) => r.job === q2.job);
  assert.equal(r1.queue_position, 1);
  assert.equal(r2.queue_position, 2);
  assert.match(formatJobChange(r1), /queued \(#1\)/);
  assert.match(formatJobChange(r2), /queued \(#2\)/);

  // Other roles (e.g. reviewer, sonic) remain uncapped.
  const rev = await f.call('hud_create', { role: 'reviewer', task: 'Synthetic review.', request_key: 'rev-1' });
  assert.equal(rev.role, 'reviewer');
  assert.equal(rev.state, 'working');

  // hud_read lists queued jobs and returns queue_position.
  const listed = await f.call('hud_read');
  assert.equal(listed.jobs.find((j) => j.job === q1.job)?.state, 'queued');
  assert.equal(listed.jobs.find((j) => j.job === q1.job)?.queue_position, 1);
  const readQ1 = await f.call('hud_read', { job: q1.job });
  assert.equal(readQ1.state, 'queued');
  assert.equal(readQ1.queue_position, 1);

  // hud_close removes a queued job and shifts remaining positions.
  const closed = await f.call('hud_close', { job: q1.job });
  assert.equal(closed.exit_code, 0);
  assert.equal(closed.removed, true);
  assert.equal(fs.existsSync(q1.task_dir), false);
  assert.equal((await f.call('hud_read', { job: q1.job })).code, 'job_not_found');
  assert.equal((await f.call('hud_read', { job: q2.job })).queue_position, 1);
});

test('a headless sonic starts even when a legacy sonic fills the role cap', async (t) => {
  const f = await fixture(t);
  writeHudSettings(f, { roleCaps: { sonic: 1 } });
  const id = 'j00000000000000a1';
  const dir = join(f.env.HUD_HOME, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  writeFixtureFile(join(dir, 'job.json'), JSON.stringify({ job: id, role: 'sonic', cwd: f.root,
    herdr_pane: 'w4E:p1', created_at: new Date().toISOString() }));
  writeStatus(dir, { state: 'working' });

  const job = await f.call('hud_create', { role: 'sonic', task: 'Synthetic query at cap.' });
  assert.notEqual(job.state, 'queued');
  await until(() => cliState(job.task_dir)?.state === 'closed');
  const receipt = JSON.parse(fs.readFileSync(join(job.task_dir, 'job.json')));
  assert.equal(receipt.headless, true);
  assert.equal(receipt.resume_s, undefined, 'headless sonic has no native resume window');
  assert.equal(fs.existsSync(join(job.task_dir, 'SESSION.txt')), false);
});

test('queued imp starts automatically when a working imp settles, picking the first available place at start time', { timeout: 45000 }, async (t) => {
  const f = await fixture(t);
  writeHudSettings(f, { roleCaps: { imp: 3, general: 3 }, impOverflow: false });

  // Give imp two pi places so we can exhaust place 0 while queued and verify start-time selection.
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(
    join(f.env.HUD_HOME, 'roles', 'imp.json'),
    JSON.stringify({
      role: 'imp',
      instructions: 'implementer',
      can_continue: true,
      resume_s: 900,
      run: [
        { harness: 'pi', pi_role: 'implementer', model: 'synthetic/first', thinking: 'low' },
        { harness: 'pi', pi_role: 'implementer', model: 'synthetic/second', thinking: 'low' },
      ],
    })
  );

  const working = [];
  for (let i = 1; i <= 3; i++) {
    const j = await f.call('hud_create', { role: 'imp', task: `Working imp ${i}.`, request_key: `w-${i}` });
    assert.equal(j.state, 'working');
    working.push(j);
  }

  // Fourth and fifth imp queue (overflow is off).
  const q1 = await f.call('hud_create', { role: 'imp', task: 'Oldest queued imp.', request_key: 'q-oldest' });
  const q2 = await f.call('hud_create', { role: 'imp', task: 'Second queued imp.', request_key: 'q-second' });
  assert.equal(q1.state, 'queued');
  assert.equal(q1.queue_position, 1);
  assert.equal(q2.state, 'queued');
  assert.equal(q2.queue_position, 2);

  // Mark place 0 exhausted while q1 is queued.
  const firstReceipt = JSON.parse(fs.readFileSync(join(working[0].task_dir, 'job.json'), 'utf8'));
  writeFixtureFile(
    join(f.env.HUD_HOME, 'exhausted.json'),
    JSON.stringify({
      version: 1,
      places: {
        [firstReceipt.place_key]: {
          until: new Date(Date.now() + 3600_000).toISOString(),
          reason: 'quota',
          marked_at: new Date().toISOString(),
        },
      },
    })
  );

  // Settle working[0] to idle_grace (not a working state). Watcher must start q1 automatically on place 1!
  await publishPiGrace(working[0], null);
  const readQ1Receipt = () => JSON.parse(fs.readFileSync(join(q1.task_dir, 'job.json'), 'utf8'));
  await until(() => cliState(q1.task_dir)?.state === 'working' && readQ1Receipt().dispatch_exit_code === 0, 30000);

  const startedReceipt = readQ1Receipt();
  assert.equal(startedReceipt.model, 'synthetic/second', 'started on first available place at start time');
  assert.equal(startedReceipt.resume_s, 900, 'queued workers inherit the selected role’s resume window');
  assert.equal((await f.call('hud_read', { job: q2.job })).state, 'queued');
  assert.equal((await f.call('hud_read', { job: q2.job })).queue_position, 1);
});

test('raising a cap or enabling overflow in Settings starts queued jobs at once', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  writeHudSettings(f, { roleCaps: { imp: 1, general: 2 }, impOverflow: false });

  const w1 = await f.call('hud_create', { role: 'imp', task: 'First imp.', request_key: 'cap-w1' });
  assert.equal(w1.state, 'working');

  const q1 = await f.call('hud_create', { role: 'imp', task: 'Queued 1.', request_key: 'cap-q1' });
  const q2 = await f.call('hud_create', { role: 'imp', task: 'Queued 2.', request_key: 'cap-q2' });
  const q3 = await f.call('hud_create', { role: 'imp', task: 'Queued 3.', request_key: 'cap-q3' });
  assert.equal(q1.queue_position, 1);
  assert.equal(q2.queue_position, 2);
  assert.equal(q3.queue_position, 3);

  // Raise imp cap from 1 to 2: q1 starts at once, q2 and q3 stay queued.
  writeHudSettings(f, { roleCaps: { imp: 2, general: 2 }, impOverflow: false });
  await until(() => cliState(q1.task_dir)?.state === 'working', 10000);
  assert.equal(cliState(q2.task_dir)?.state, 'queued');
  assert.equal(cliState(q3.task_dir)?.state, 'queued');

  // Enable imp→general overflow: q2 and q3 overflow into the 2 free general slots at once!
  writeHudSettings(f, { roleCaps: { imp: 2, general: 2 }, impOverflow: true });
  await until(() => cliState(q2.task_dir)?.state === 'working' && cliState(q3.task_dir)?.state === 'working', 10000);
  const r2 = JSON.parse(fs.readFileSync(join(q2.task_dir, 'job.json'), 'utf8'));
  const r3 = JSON.parse(fs.readFileSync(join(q3.task_dir, 'job.json'), 'utf8'));
  assert.equal(r2.role, 'general');
  assert.equal(r2.overflow_from, 'imp');
  assert.equal(r3.role, 'general');
  assert.equal(r3.overflow_from, 'imp');
});

test('batch hud_create overflows and queues items past the cap in input order', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  writeHudSettings(f, { roleCaps: { imp: 2, general: 1 }, impOverflow: true });

  const res = await f.call('hud_create', {
    jobs: [
      { role: 'imp', task: 'Batch 1.', request_key: 'batch-1' },
      { role: 'imp', task: 'Batch 2.', request_key: 'batch-2' },
      { role: 'imp', task: 'Batch 3.', request_key: 'batch-3' },
      { role: 'imp', task: 'Batch 4.', request_key: 'batch-4' },
      { role: 'imp', task: 'Batch 5.', request_key: 'batch-5' },
    ],
  });

  assert.equal(res.jobs.length, 5);
  assert.equal(res.jobs[0].role, 'imp');
  assert.equal(res.jobs[0].state, 'working');
  assert.equal(res.jobs[1].role, 'imp');
  assert.equal(res.jobs[1].state, 'working');
  assert.equal(res.jobs[2].role, 'general');
  assert.equal(res.jobs[2].overflowed, true);
  assert.equal(res.jobs[2].overflow_from, 'imp');
  assert.equal(res.jobs[2].state, 'working');
  assert.equal(res.jobs[3].role, 'imp');
  assert.equal(res.jobs[3].state, 'queued');
  assert.equal(res.jobs[3].queue_position, 1);
  assert.equal(res.jobs[4].role, 'imp');
  assert.equal(res.jobs[4].state, 'queued');
  assert.equal(res.jobs[4].queue_position, 2);
});

test('sonic children and non-working jobs are excluded from caps; panel shows queued jobs with position in EN and ZH', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  writeHudSettings(f, { roleCaps: { imp: 1, general: 1 }, impOverflow: false });

  // Pre-seed a done imp, a closed imp, and a sonic child with parent_job — none count toward the cap.
  for (const [id, role, state, extra] of [
    ['j00000000000000a1', 'imp', 'done', {}],
    ['j00000000000000a2', 'imp', 'closed', {}],
    ['j00000000000000a3', 'imp', 'working', { parent_job: 'j00000000000000a1' }],
  ]) {
    const dir = join(f.env.HUD_HOME, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    writeFixtureFile(join(dir, 'job.json'), JSON.stringify({
      job: id, role, herdr_pane: 'w4E:p1', cwd: f.root, created_at: '2026-11-22T10:00:00.000Z', ...extra,
    }));
    writeStatus(dir, { state });
  }

  const w1 = await f.call('hud_create', { role: 'imp', task: '# Active work\n\nRunning now.', request_key: 'p-w1', package: 'pkg-active' });
  assert.equal(w1.state, 'working', 'settled and child jobs do not block the first working imp');

  const q1 = await f.call('hud_create', { role: 'imp', task: '# Queued work\n\nWaiting for slot.', request_key: 'p-q1', package: 'pkg-queued' });
  assert.equal(q1.state, 'queued');
  assert.equal(q1.queue_position, 1);

  const worker = workerFor(f, q1.job);
  assert.ok(worker);
  assert.equal(worker.state, 'queued');
  assert.equal(worker.queuePosition, 1);
  assert.equal(worker.settledAt, null);

  // Even 60 minutes later, a queued card is still queued, never stalled.
  const later = Date.now() + 60 * 60_000;
  const card = projectWorkCard(worker, later, 10);
  assert.equal(card.state, 'queued');

  const lanes = readThinJobs(f.env.HUD_HOME, { project: null, pane: 'w4E:p1' });
  const board = {
    revision: '1',
    lanes,
    workers: lanes.flatMap((l) => l.workers),
    decisions: [],
    coverage: { incomplete: false, diagnostics: [], workspace: f.root },
  };

  for (const [lang, expectedText] of [['en', 'queued #1'], ['zh', '排队 #1']]) {
    const prev = setLanguage(lang);
    try {
      for (const panelLayout of ['classic', 'split']) {
        for (const width of [40, 80]) {
          const state = { ...initialMonitorState(), activeTab: 'home', prefs: { ...initialMonitorState().prefs, panelLayout } };
          const frame = renderMonitor({ workboard: board, state, width, height: 30, nowMs: Date.now() });
          for (const line of frame.lines) assert.equal(visualLength(line), width);
          const plain = frame.lines.map(stripAnsi).join('\n');
          assert.ok(plain.includes(expectedText), `${lang}/${panelLayout}/${width}: expected ${expectedText} in:\n${plain}`);
        }
      }
      const cardPlain = renderWorkCard(card, { ...initialMonitorState(), activeTab: 'home' }, 56).map(stripAnsi).join('\n');
      assert.ok(cardPlain.includes(expectedText));
    } finally {
      setLanguage(prev);
    }
  }

  // Panel stopJob removes a queued job cleanly.
  const stopped = await stopJob(q1.task_dir, f.env);
  assert.equal(stopped.ok, true);
  assert.equal(fs.existsSync(q1.task_dir), false);
});

test('MCP task client tracks a queued job from queued (#1) through watcher start to completion', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  writeHudSettings(f, { roleCaps: { imp: 1, general: 1 }, impOverflow: false });
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');

  const t1 = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'First task job.', request_key: 'task-1' });
  const j1 = taskJob(f, t1);

  const t2 = await taskCall(rpc, 'hud_create', { role: 'imp', task: 'Second task job.', request_key: 'task-2' });
  const j2 = taskJob(f, t2);
  assert.match(t2.statusMessage, /queued \(#1\)/);

  // Settle j1 so watcher starts j2.
  await publishPiGrace(j1, null);
  await until(() => cliState(j2.task_dir)?.state === 'working', 10000);

  // Settle j2 with report -> MCP task completes cleanly.
  await publishPiGrace(j2, null);
  const done = await rpc('tasks/get', { taskId: t2.taskId });
  assert.equal(done.status, 'completed');
  assert.match(done.result.content[0].text, /Synthetic settled pi report/);
});
