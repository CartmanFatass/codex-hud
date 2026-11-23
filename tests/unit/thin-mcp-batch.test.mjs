import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { taskDelivery } from '../../packages/hud-mcp/bin/hud-notify.mjs';
import {
  fixture,
  publishPiGrace,
  publishLegacyPiGrace,
  resultValue,
  taskCall,
  taskJob,
  taskRpc,
  until,
  waitFixtureJob,
  withoutHint,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

test('hud_create brief_file reads UTF-8 text inside cwd and rejects invalid paths or conflicts', async (t) => {
  const f = await fixture(t);
  const cwd = join(f.root, 'proj');
  fs.mkdirSync(join(cwd, 'briefs'), { recursive: true });
  const briefPath = join(cwd, 'briefs', 'slice.md');
  writeFixtureFile(briefPath, '# Synthetic brief\n\nImplement the synthetic batch feature.\n');
  const job = await f.call('hud_create', { role: 'imp', cwd, brief_file: 'briefs/slice.md', request_key: 'brief-ok' });
  assert.match(job.job, /^j[0-9a-f]{16}$/);
  assert.equal(
    fs.readFileSync(join(job.task_dir, 'brief.md'), 'utf8'),
    '# Synthetic brief\n\nImplement the synthetic batch feature.\n\n\nFinish with `hud_report`.\n'
  );

  // Conflict with task
  const conflict = await f.call('hud_create', { role: 'imp', cwd, task: 'Inline.', brief_file: 'briefs/slice.md' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'invalid_arguments');

  // Outside cwd (traversal and symlink)
  const outside = join(f.root, 'outside-brief.md');
  writeFixtureFile(outside, 'Outside text.');
  fs.symlinkSync(outside, join(cwd, 'escape.md'));
  for (const bad of ['../outside-brief.md', 'escape.md', 'missing.md']) {
    const res = await f.call('hud_create', { role: 'imp', cwd, brief_file: bad });
    assert.equal(res.ok, false, bad);
    assert.equal(res.code, 'invalid_arguments', bad);
  }

  // Empty, binary, and oversized
  writeFixtureFile(join(cwd, 'empty.md'), '   \n\t ');
  fs.writeFileSync(join(cwd, 'binary.md'), Buffer.from([0x61, 0x00, 0x62]));
  writeFixtureFile(join(cwd, 'huge.md'), 'x'.repeat(256 * 1024 + 1));
  assert.equal((await f.call('hud_create', { role: 'imp', cwd, brief_file: 'empty.md' })).code, 'invalid_arguments');
  assert.equal((await f.call('hud_create', { role: 'imp', cwd, brief_file: 'binary.md' })).code, 'invalid_arguments');
  assert.equal((await f.call('hud_create', { role: 'imp', cwd, brief_file: 'huge.md' })).code, 'context_too_large');
});

test('hud_create jobs creates multiple jobs in input order with per-item errors and keeps schema short', async (t) => {
  const f = await fixture(t);
  const { result: listed } = await f.rpc('tools/list');
  const createTool = listed.tools.find(({ name }) => name === 'hud_create');
  assert.deepEqual(createTool.inputSchema.properties.jobs.items, { type: 'object' });
  assert.ok(Buffer.byteLength(JSON.stringify(createTool), 'utf8') < 3300, 'hud_create schema stays compact');

  const rejected = (role, fields) => ({ ok: false, code: 'invalid_arguments',
    error: `Role "${role}" does not accept placement fields: ${fields}. It runs as configured in its role file and Control; use general for per-job placement.` });
  for (const [role, fields, refused] of [
    ['imp', { preset: 'astra' }, 'preset'],
    ['reviewer', { model: 'synthetic/one', pi_args: ['--thinking=low'], lens: false }, 'model, pi_args'],
  ]) {
    const result = await f.call('hud_create', { role, task: 'No launch.', ...fields });
    if (role === 'imp') assert.ok(result.hint, 'first create supplies the delivery hint once');
    assert.deepEqual(withoutHint(result), rejected(role, refused));
  }
  assert.ok(!fs.existsSync(join(f.env.HUD_HOME, 'jobs')));

  writeFixtureFile(join(f.root, 'b2.md'), 'Synthetic brief two from file.');
  const batch = await f.call('hud_create', {
    jobs: [
      { role: 'imp', task: 'Synthetic task one.', request_key: 'b-1' },
      { role: 'imp', brief_file: 'b2.md', request_key: 'b-2' },
      { role: 'no-such-role', task: 'Should fail only this entry.', request_key: 'b-bad' },
      { role: 'imp', task: 'Reject a caller harness.', on: 'pi' },
      { role: 'reviewer', task: 'Reject a caller effort.', thinking: 'low' },
      { role: 'imp', task: 'Synthetic task three.', request_key: 'b-3' },
    ],
  });
  assert.equal(batch.jobs.length, 6);
  const [j1, j2, bad, badOn, badThinking, j3] = batch.jobs;
  assert.deepEqual(badOn, rejected('imp', 'on'));
  assert.deepEqual(badThinking, rejected('reviewer', 'thinking'));
  assert.match(j1.job, /^j[0-9a-f]{16}$/);
  assert.match(j2.job, /^j[0-9a-f]{16}$/);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'role_unavailable');
  assert.match(j3.job, /^j[0-9a-f]{16}$/);
  assert.deepEqual(fs.readdirSync(join(f.env.HUD_HOME, 'jobs')).sort(), [j1.job, j2.job, j3.job].sort());
  assert.match(fs.readFileSync(join(j2.task_dir, 'brief.md'), 'utf8'), /^Synthetic brief two from file\./);
  assert.equal(j1.hint, undefined, 'items do not duplicate hint');

  // Nested jobs or non-object item fail only that item; mixed top-level args fail the call.
  const nested = await f.call('hud_create', {
    jobs: [
      { jobs: [{ role: 'imp', task: 'Nested.' }] },
      { role: 'imp', task: 'Synthetic task four.', request_key: 'b-4' },
    ],
  });
  assert.equal(nested.hint, undefined);
  assert.equal(nested.jobs[0].ok, false);
  assert.equal(nested.jobs[0].code, 'invalid_arguments');
  assert.match(nested.jobs[1].job, /^j[0-9a-f]{16}$/);

  const mixed = await f.rpc('tools/call', {
    name: 'hud_create',
    arguments: { role: 'imp', jobs: [{ role: 'imp', task: 'x' }] },
  });
  assert.equal(mixed.result.isError, true);
});

test('hud_tickets updates applies batch updates in input order with per-item errors and mirror guard', async (t) => {
  const f = await fixture(t);
  await f.call('hud_tickets', {
    op: 'add',
    feature: 'feat-a',
    tickets: [
      { title: 'Alpha one', blocked_by: [], what: 'First.', acceptance: ['Item A1', 'Item A2'] },
      { title: 'Alpha two', blocked_by: [1], what: 'Second.', acceptance: ['Item A3'] },
    ],
  });
  await f.call('hud_tickets', {
    op: 'add',
    feature: 'feat-b',
    tickets: [{ title: 'Beta one', blocked_by: [], what: 'Third.', acceptance: ['Item B1'] }],
  });

  const res = await f.call('hud_tickets', {
    op: 'update',
    feature: 'feat-a',
    updates: [
      { ticket: 1, status: 'claimed', tick: [1] },
      { ticket: 99, status: 'done' },
      { feature: 'feat-b', ticket: 1, status: 'ready-for-human', blocked_by: ['feat-a/01'], tick: [1] },
      { ticket: 1, tick: [2], status: 'ready-for-human' },
      { ticket: 2, tick: [9] },
    ],
  });
  assert.equal(res.updates.length, 5);
  assert.equal(res.updates[0].ok, true);
  assert.equal(res.updates[0].feature, 'feat-a');
  assert.equal(res.updates[0].number, 1);
  assert.equal(res.updates[1].ok, false);
  assert.match(res.updates[1].error, /unknown ticket: 99/);
  assert.equal(res.updates[2].ok, true);
  assert.equal(res.updates[2].feature, 'feat-b');
  assert.equal(res.updates[3].ok, true);
  assert.equal(res.updates[4].ok, false);
  assert.equal(res.updates[4].error, 'unknown acceptance item: 9 (valid range: 1-1)');

  const a1 = fs.readFileSync(res.updates[0].path, 'utf8');
  assert.match(a1, /\*\*Status:\*\* ready-for-human/);
  assert.match(a1, /- \[x\] Item A1/);
  assert.match(a1, /- \[x\] Item A2/);
  const b1 = fs.readFileSync(res.updates[2].path, 'utf8');
  assert.match(b1, /\*\*Status:\*\* ready-for-human/);
  assert.match(b1, /\*\*Blocked by:\*\* feat-a\/01/);
  assert.match(b1, /- \[x\] Item B1/);

  // Mixing single and batch update fields is rejected.
  const mixed = await f.rpc('tools/call', {
    name: 'hud_tickets',
    arguments: { op: 'update', feature: 'feat-a', ticket: 1, updates: [{ ticket: 1, status: 'done' }] },
  });
  assert.equal(mixed.result.isError, true);

  // GitHub mirror still refuses batch updates.
  const mirror = join(f.root, 'mirror'), mirroredIssues = join(mirror, '.scratch', 'feat-a', 'issues');
  fs.mkdirSync(mirroredIssues, { recursive: true });
  fs.writeFileSync(join(mirroredIssues, '01-mirrored.md'), '<!-- Generated by hud tickets sync from https://github.com/example/synthetic/issues/1 -->\n');
  const refused = await f.rpc('tools/call', {
    name: 'hud_tickets',
    arguments: { op: 'update', cwd: mirror, feature: 'feat-a', updates: [{ ticket: 1, status: 'done' }] },
  });
  assert.equal(refused.result.isError, true);
  assert.match(JSON.parse(refused.result.content[0].text).error, /GitHub mirror/);
});

test('hud_tickets add and update support optional owner_try boolean under Status', async (t) => {
  const f = await fixture(t);
  const added = await f.call('hud_tickets', {
    op: 'add',
    feature: 'try-flag',
    tickets: [
      { title: 'UI change', blocked_by: [], what: 'Visible panel change.', acceptance: ['Check panel'], owner_try: true },
      { title: 'Pure helper', blocked_by: [], what: 'Unit-tested helper.', acceptance: ['Tests pass'], owner_try: false },
      { title: 'Default ticket', blocked_by: [], what: 'No explicit flag.', acceptance: ['Works'] },
    ],
  });
  const [p1, p2, p3] = added.tickets.map((x) => x.path);
  assert.match(fs.readFileSync(p1, 'utf8'), /\*\*Status:\*\* ready-for-agent\n\*\*Owner try:\*\* yes\n\*\*Blocked by:\*\* none/);
  assert.match(fs.readFileSync(p2, 'utf8'), /\*\*Status:\*\* ready-for-agent\n\*\*Owner try:\*\* no\n\*\*Blocked by:\*\* none/);
  assert.doesNotMatch(fs.readFileSync(p3, 'utf8'), /\*\*Owner try:\*\*/);

  // Single update inserts Owner try under Status when absent, and replaces in place when present.
  await f.call('hud_tickets', { op: 'update', feature: 'try-flag', ticket: 3, owner_try: false });
  assert.match(fs.readFileSync(p3, 'utf8'), /\*\*Status:\*\* ready-for-agent\n\*\*Owner try:\*\* no\n\*\*Blocked by:\*\* none/);
  await f.call('hud_tickets', { op: 'update', feature: 'try-flag', ticket: 1, owner_try: false });
  assert.match(fs.readFileSync(p1, 'utf8'), /\*\*Status:\*\* ready-for-agent\n\*\*Owner try:\*\* no\n\*\*Blocked by:\*\* none/);

  // Batch update supports owner_try and rejects invalid type per item; mixing top-level owner_try with updates fails.
  const batch = await f.call('hud_tickets', {
    op: 'update',
    feature: 'try-flag',
    updates: [
      { ticket: 2, owner_try: true },
      { ticket: 3, owner_try: 'yes' },
    ],
  });
  assert.equal(batch.updates[0].ok, true);
  assert.equal(batch.updates[1].ok, false);
  assert.equal(batch.updates[1].code, 'invalid_arguments');
  assert.match(fs.readFileSync(p2, 'utf8'), /\*\*Status:\*\* ready-for-agent\n\*\*Owner try:\*\* yes\n\*\*Blocked by:\*\* none/);

  const mixed = await f.rpc('tools/call', {
    name: 'hud_tickets',
    arguments: { op: 'update', feature: 'try-flag', owner_try: false, updates: [{ ticket: 1, status: 'done' }] },
  });
  assert.equal(mixed.result.isError, true);
});

test('hud_respond answers writes multiple answers once in input order with per-item errors', async (t) => {
  const f = await fixture(t);
  const j1 = waitFixtureJob(f, 1, 'working');
  const j2 = waitFixtureJob(f, 2, 'working');
  writeFixtureFile(join(j1.dir, 'qa', 'q1.md'), 'Question one?');
  writeFixtureFile(join(j2.dir, 'qa', 'q2.md'), 'Question two?');
  const missing = 'j0000000000000099';

  const res = await f.call('hud_respond', {
    answers: [
      { job: j1.job, request_id: 'q1', answer: 'Answer one.' },
      { job: missing, request_id: 'q1', answer: 'Missing job.' },
      { job: j1.job, request_id: 'bad', answer: 'Bad id.' },
      { job: j2.job, request_id: 'q2', answer: 'Answer two.' },
    ],
  });
  assert.deepEqual(res.answers, [
    { job: j1.job, request_id: 'q1', ok: true, written: true },
    { job: missing, request_id: 'q1', ok: false, code: 'job_not_found' },
    { job: j1.job, request_id: 'bad', ok: false, code: 'invalid_arguments', error: 'invalid_arguments: request_id' },
    { job: j2.job, request_id: 'q2', ok: true, written: true },
  ]);
  assert.equal(fs.readFileSync(join(j1.dir, 'qa', 'q1.answer.md'), 'utf8'), 'Answer one.');
  assert.equal(fs.readFileSync(join(j2.dir, 'qa', 'q2.answer.md'), 'utf8'), 'Answer two.');

  // Repeating does not overwrite.
  const repeat = await f.call('hud_respond', {
    answers: [{ job: j1.job, request_id: 'q1', answer: 'Overwrite attempt.' }],
  });
  assert.deepEqual(repeat.answers, [{ job: j1.job, request_id: 'q1', ok: true, written: false }]);
  assert.equal(fs.readFileSync(join(j1.dir, 'qa', 'q1.answer.md'), 'utf8'), 'Answer one.');
});

test('hud_send messages sends distinct texts and repairs in input order while keeping jobs fan-out', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const [w1, w2, closed] = (await f.call('hud_create', {
    jobs: [
      { role: 'imp', task: 'Worker 1.', request_key: 's-1' },
      { role: 'imp', task: 'Worker 2.', request_key: 's-2' },
      { role: 'imp', task: 'Worker 3.', request_key: 's-3' },
    ],
  })).jobs;
  writeFixtureFile(join(closed.task_dir, 'report.md'), 'Original report.');
  writeFixtureFile(join(closed.task_dir, 'STATUS.json'), JSON.stringify({ state: 'closed', exit_reason: 'closed after report read' }));
  const missing = 'j0000000000000099';

  const res = await f.call('hud_send', {
    messages: [
      { job: w1.job, text: 'Message for w1.' },
      { job: missing, text: 'Nobody home.' },
      { job: closed.job, text: 'Repair closed job.' },
      { job: w2.job, text: 'Message for w2.', message_key: 'explicit-w2' },
    ],
  });
  assert.equal(res.messages.length, 4);
  assert.equal(res.messages[0].job, w1.job);
  assert.equal(res.messages[0].sent, true);
  assert.deepEqual(res.messages[1], { job: missing, ok: false, code: 'job_not_found' });
  assert.ok(res.messages[2].continued_as);
  assert.notEqual(res.messages[2].continued_as, closed.job);
  assert.equal(res.messages[3].job, w2.job);
  assert.equal(res.messages[3].sent, true);

  // Fan-out jobs form remains unchanged.
  const fanout = await f.call('hud_send', { jobs: [w1.job, w2.job, closed.job], text: 'Broadcast to working.' });
  assert.deepEqual(fanout.sent.sort(), [w1.job, w2.job].sort());
  assert.deepEqual(fanout.skipped, [{ job: closed.job, reason: 'not_continuable' }]);

  const mixed = await f.rpc('tools/call', {
    name: 'hud_send',
    arguments: { text: 'x', messages: [{ job: w1.job, text: 'y' }] },
  });
  assert.equal(mixed.result.isError, true);
});

test('MCP tasks: batch create is rejected before launch; parallel single creates return separate tasks', async (t) => {
  const f = await fixture(t);
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const jobs = [
    { role: 'imp', task: 'Synthetic task one.', request_key: 'tc-1' },
    { role: 'imp', task: 'Synthetic task two.', request_key: 'tc-2' },
  ];
  const batch = await taskCall(rpc, 'hud_create', { jobs });
  assert.equal(batch.resultType, 'complete');
  assert.equal(batch.isError, true);
  assert.equal(JSON.parse(batch.content[0].text).error,
    'In a task session, send one hud_create per job as parallel calls; each gets its own MCP task.');
  assert.equal(fs.existsSync(join(f.env.HUD_HOME, 'jobs')), false, 'rejected batch leaves no job receipts');

  const tasks = await Promise.all(jobs.map((args) => taskCall(rpc, 'hud_create', args)));
  const created = tasks.map((task) => taskJob(f, task));
  assert.notEqual(tasks[0].taskId, tasks[1].taskId);
  assert.notEqual(created[0].job, created[1].job);
  for (const job of created) assert.equal(taskDelivery(job.task_dir, f.env.HERDR_PANE_ID), true);
});

async function answerInitialQuestions(rpc, jobs) {
  const answers = jobs.map(({ job, task_dir }) => {
    writeFixtureFile(join(task_dir, 'qa', 'q1.md'), 'Synthetic initial question?');
    return { job, request_id: 'q1', answer: 'Proceed.' };
  });
  const response = await taskCall(rpc, 'hud_respond', { answers });
  assert.equal(response.resultType, 'complete');
  assert.deepEqual(resultValue(response).answers, answers.map(({ job, request_id }) => ({ job, request_id, ok: true, written: true })));
}

test('MCP tasks: batch responses deliver per-job compact notices with check-wait, changes fallback and disconnect fallback', { timeout: 25000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');

  const checkCmd = 'for ((i=0; i<120; i++)); do [[ -f release-batch-check ]] && break; sleep .05; done; test -f release-batch-check';
  const { jobs: [plain, checked, disc] } = await f.call('hud_create', {
    jobs: [
      { role: 'imp', task: 'Batch plain job.', request_key: 'tc-plain' },
      { role: 'imp', task: 'Batch checked job.', checks: [checkCmd], request_key: 'tc-check' },
      { role: 'imp', task: 'Batch disconnect job.', request_key: 'tc-disc' },
    ],
  });
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  await answerInitialQuestions(rpc, [plain, checked, disc]);
  assert.equal(taskDelivery(plain.task_dir, f.env.HERDR_PANE_ID), true);
  assert.equal(taskDelivery(checked.task_dir, f.env.HERDR_PANE_ID), true);
  assert.equal(taskDelivery(disc.task_dir, f.env.HERDR_PANE_ID), true);

  const panePrompts = () => f.commands()
    .filter((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args[2] === f.env.HERDR_PANE_ID)
    .map((c) => c.args[3]);

  // 1. A pre-upgrade job stays in grace so it can ask the follow-up below.
  await publishLegacyPiGrace(t, plain);
  await until(() => fs.existsSync(join(plain.task_dir, 'batch-notice.json')), t.signal);
  const plainNotice = panePrompts().find((m) => m.includes(plain.job));
  assert.match(plainNotice, new RegExp(`^${plain.job} \\(imp\\) — idle_grace\\nReport: hud_read job=${plain.job}`));
  const plainRec = JSON.parse(fs.readFileSync(join(plain.task_dir, 'batch-notice.json'), 'utf8'));
  assert.equal(plainRec.via, 'push');
  assert.equal(resultValue(await taskCall(rpc, 'hud_roster')).changes, undefined, 'pushed notice is not repeated in changes');

  // 2. Checked job settles -> waits for checks before pushing notice with Checks: 1/1 passed.
  await publishPiGrace(t, checked);
  await until(() => fs.existsSync(join(checked.task_dir, 'checks.json')), t.signal);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(panePrompts().some((m) => m.includes(checked.job)), false, 'notice waits while check runs');
  writeFixtureFile(join(f.root, 'release-batch-check'), '');
  await until(() => fs.existsSync(join(checked.task_dir, 'batch-notice.json')), t.signal);
  const checkedNotice = panePrompts().find((m) => m.includes(checked.job));
  assert.match(checkedNotice, /Checks: 1\/1 passed/);
  const checkedRec = JSON.parse(fs.readFileSync(join(checked.task_dir, 'batch-notice.json'), 'utf8'));
  assert.equal(checkedRec.via, 'push');
  assert.equal(panePrompts().filter((m) => m.includes(checked.job)).length, 1);

  // 3. Batch hud_respond resumes turn; when push fails, notice falls back to changes once and is recorded.
  writeFixtureFile(join(plain.task_dir, 'qa', 'q2.md'), 'Synthetic follow-up question?');
  const failPrompt = join(f.env.HOME, 'fail-prompt');
  fs.writeFileSync(failPrompt, '');
  const respRes = await taskCall(rpc, 'hud_respond', {
    answers: [{ job: plain.job, request_id: 'q2', answer: 'Proceed.' }],
  });
  assert.equal(respRes.resultType, 'complete');
  assert.deepEqual(resultValue(respRes).answers, [{ job: plain.job, request_id: 'q2', ok: true, written: true }]);
  writeFixtureFile(join(plain.task_dir, 'qa', 'q3.md'), 'Another question?');
  const withFallback = resultValue(await taskCall(rpc, 'hud_roster'));
  assert.ok(withFallback.changes?.some((line) => line.includes(plain.job) && line.includes('Question q3: Another question?')));
  assert.equal(resultValue(await taskCall(rpc, 'hud_roster')).changes, undefined, 'changes fallback delivered once');
  assert.equal(JSON.parse(fs.readFileSync(join(plain.task_dir, 'batch-notice.json'), 'utf8')).via, 'changes');
  fs.unlinkSync(failPrompt);

  // 4. Connection ends task mode before `disc` settles -> mcp-task.json released, normal non-task changes delivers settlement.
  await rpc('initialize');
  assert.equal(taskDelivery(disc.task_dir, f.env.HERDR_PANE_ID), false, 'disconnect releases mcp-task.json for hud-notify fallback');
  await publishPiGrace(t, disc);
  const nonTaskRoster = await f.call('hud_roster');
  assert.ok(nonTaskRoster.changes?.some((line) => line.includes(disc.job) && /idle_grace|closed/.test(line)));
});

test('MCP tasks: batch follow-up sends and answers carry on live batch tasks with one terminal notice', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, true, '', 200);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const { jobs: [chain, asking] } = await f.call('hud_create', {
    jobs: [
      { role: 'imp', task: 'Batch chain worker.', request_key: 'bc-1' },
      { role: 'imp', task: 'Batch asking worker.', request_key: 'bc-2' },
    ],
  });
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  await answerInitialQuestions(rpc, [chain, asking]);
  const panePrompts = () => f.commands()
    .filter((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && c.args[2] === f.env.HERDR_PANE_ID)
    .map((c) => c.args[3]);

  // Single send, batch messages, and fan-out all carry on the live batch task without opening a polled task.
  const single = await taskCall(rpc, 'hud_send', { job: chain.job, text: 'Synthetic single addendum.' });
  assert.equal(single.resultType, 'complete');
  assert.equal(resultValue(single).sent, true);
  const batchSend = await taskCall(rpc, 'hud_send', { messages: [{ job: chain.job, text: 'Synthetic batch addendum.' }] });
  assert.equal(batchSend.resultType, 'complete');
  assert.equal(resultValue(batchSend).messages[0].sent, true);
  const fanOut = await taskCall(rpc, 'hud_send', { jobs: [chain.job], text: 'Synthetic fan-out addendum.' });
  assert.equal(fanOut.resultType, 'complete');
  assert.deepEqual(resultValue(fanOut).sent, [chain.job]);

  // Live batch answer continues the asking worker's batch task without pushing a stale question notice.
  writeFixtureFile(join(asking.task_dir, 'qa', 'q2.md'), 'Synthetic batch live question?');
  writeFixtureFile(join(asking.task_dir, 'STATUS.json'), JSON.stringify({ state: 'waiting_orchestrator', reason: 'asking' }));
  const ans = await taskCall(rpc, 'hud_respond', { answers: [{ job: asking.job, request_id: 'q2', answer: 'Continue.' }] });
  assert.equal(ans.resultType, 'complete');
  assert.deepEqual(resultValue(ans).answers, [{ job: asking.job, request_id: 'q2', ok: true, written: true }]);

  writeFixtureFile(join(chain.task_dir, 'report.md'), 'Latest batch chain report.\n');
  await publishPiGrace(t, chain, undefined, false);
  writeFixtureFile(join(asking.task_dir, 'report.md'), 'Batch answered report.\n');
  await publishPiGrace(t, asking, undefined, false);

  await until(() => fs.existsSync(join(chain.task_dir, 'batch-notice.json')) && fs.existsSync(join(asking.task_dir, 'batch-notice.json')), t.signal);
  const chainNotices = panePrompts().filter((m) => m.includes(chain.job));
  const askingNotices = panePrompts().filter((m) => m.includes(asking.job));
  assert.equal(chainNotices.length, 1);
  assert.match(chainNotices[0], /Latest batch chain report\./);
  assert.equal(askingNotices.length, 1);
  assert.match(askingNotices[0], /Batch answered report\./);
});
