import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { archiveJob } from '../../dist/roles/job-archive.js';
import { prewalkScoutTask, truncateScoutAsk } from '../../dist/mcp/prewalk.js';
import {
  cliState, configureFakeDecision, fakeDecisionServer, fixture, publishSonic,
  sonicTask, taskCall, taskJob, taskRpc, until,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';

const read = (file) => fs.readFileSync(file, 'utf8');
const receipt = (dir) => JSON.parse(read(join(dir, 'job.json')));
const brief = (dir) => read(join(dir, 'brief.md'));
const jobsDir = (f) => join(f.env.HUD_HOME, 'jobs');
const waitLaunch = (job) => until(() => receipt(job.task_dir).dispatch_exit_code !== null, 25000);

function poolReply(body, names) {
  return {
    answers: body.questions.map(({ name, choices }, i) => {
      const choice = names[i] ?? 'NONE';
      return {
        name, type: 'choice', choice, confidence: 1,
        probabilities: choices.map(({ value }) => ({ value, probability: value === choice ? 1 : 0 })),
      };
    }),
  };
}

async function waitScouts(f, parent, count) {
  let found = [];
  await until(() => {
    if (!fs.existsSync(jobsDir(f))) return false;
    found = fs.readdirSync(jobsDir(f))
      .map(id => join(jobsDir(f), id))
      .filter(dir => fs.existsSync(join(dir, 'job.json')) && receipt(dir).parent_job === parent && receipt(dir).dispatch_exit_code !== null);
    return found.length >= count;
  }, 25000);
  return found;
}

test('prewalk role requires scouts; empty list starts directly; code+web run in parallel with no Decision call', async (t) => {
  const f = await fixture(t, { autoPrewalk: true });
  sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const extDir = join(f.env.PI_CODING_AGENT_DIR, 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  const webExtPath = join(extDir, 'deepseek-search.ts');
  write(webExtPath, '// synthetic deepseek-search extension\n');

  const api = await fakeDecisionServer(t, () => ({ status: 500 }));
  configureFakeDecision(f, api.baseUrl);
  write(join(f.root, 'local-ctx.md'), 'Synthetic local context.');

  // 1. Omitting scouts on a prewalk-enabled role fails immediately before anything starts and makes no Decision call.
  const missing = await f.call('hud_create', { role: 'imp', task: 'Missing scouts synthetic task.' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'invalid_arguments');
  assert.match(missing.error, /scouts.*\[\].*prewalk: false/i);
  assert.equal(api.requests.length, 0);
  assert.ok(!fs.existsSync(jobsDir(f)));

  // 2. Legacy singular `scout` parameter and invalid `scouts` values are rejected.
  assert.equal((await f.call('hud_create', { role: 'imp', task: 'Legacy.', scout: 'Where?' })).code, 'invalid_arguments');
  assert.equal((await f.call('hud_create', { role: 'imp', task: 'Too many.', scouts: [
    { kind: 'code', ask: '1' }, { kind: 'code', ask: '2' }, { kind: 'docs', ask: '3' }, { kind: 'web', ask: '4' },
  ] })).code, 'invalid_arguments');
  assert.equal((await f.call('hud_create', { role: 'imp', task: 'Bad kind.', scouts: [{ kind: 'other', ask: 'x' }] })).code, 'invalid_arguments');
  assert.equal((await f.call('hud_create', { role: 'imp', task: 'Empty ask.', scouts: [{ kind: 'code', ask: '   ' }] })).code, 'invalid_arguments');
  assert.equal((await f.call('hud_create', { role: 'imp', task: 'Conflict.', prewalk: false, scouts: [{ kind: 'code', ask: 'Where?' }] })).code, 'invalid_arguments');
  assert.equal(api.requests.length, 0);

  // 3. Empty list starts target directly with prewalk: [] and no Decision API call.
  const direct = await f.call('hud_create', { role: 'imp', task: 'Tiny synthetic typo fix.', scouts: [] });
  assert.equal(api.requests.length, 0);
  assert.equal(receipt(direct.task_dir).dispatch_exit_code, 0);
  assert.deepEqual(direct.prewalk, []);
  assert.deepEqual(receipt(direct.task_dir).prewalk, []);

  // 4. code+web scouts run in parallel, carry ask + kind rules, record source: 'caller' + truncated ask, no Decision call.
  const task = 'Implement synthetic OAuth client against RFC 6749 with private internal path /secret/app.';
  const longAsk = 'Locate OAuth token handlers and test entry points. ' + 'x'.repeat(220);
  const webAsk = 'Check RFC 6749 token endpoint error codes.';
  const target = await f.call('hud_create', {
    role: 'imp', task, context_files: ['local-ctx.md'],
    scouts: [{ kind: 'code', ask: longAsk }, { kind: 'web', ask: webAsk }],
  });
  assert.equal(api.requests.length, 0);
  assert.deepEqual(target.prewalk.map(({ kind, source, ask, result }) => ({ kind, source, ask, result })), [
    { kind: 'code', source: 'caller', ask: truncateScoutAsk(longAsk), result: 'running' },
    { kind: 'web', source: 'caller', ask: webAsk, result: 'running' },
  ]);
  assert.equal(target.prewalk[0].ask.length, 200);

  const scouts = await waitScouts(f, target.job, 2);
  const byKind = Object.fromEntries(scouts.map(dir => [receipt(dir).prewalk_kind, dir]));
  assert.deepEqual(Object.keys(byKind).sort(), ['code', 'web']);
  assert.ok(!fs.existsSync(join(target.task_dir, 'SESSION.txt')), 'target waits while both scouts run in parallel');

  const codeBrief = brief(byKind.code);
  assert.match(codeBrief, /Search only inside this checkout/i);
  assert.match(codeBrief, /not found in checkout/i);
  assert.ok(codeBrief.includes(`## Question\n\n${longAsk}\n\n## Target Brief\n\n${task}`));
  const webBrief = brief(byKind.web);
  assert.match(webBrief, /primary external sources/i);
  assert.match(webBrief, /NEVER include local file paths.*private content/i);
  assert.match(webBrief, /Facts only/i);
  assert.ok(webBrief.includes(`## Question\n\n${webAsk}\n\n## Target Brief\n\n${task}`));
  assert.equal(receipt(byKind.web).context_files, undefined);
  assert.deepEqual(receipt(byKind.code).context_files, [join(f.root, 'local-ctx.md')]);

  // Web tools extension passed ONLY for web kind.
  const piRoleCalls = f.commands().filter(c => c.command === 'pi-role' && c.args[1] === 'sonic');
  const webCall = piRoleCalls.find(c => c.args.includes(join(byKind.web, 'report.md')));
  const codeCall = piRoleCalls.find(c => c.args.includes(join(byKind.code, 'report.md')));
  assert.ok(webCall && codeCall);
  const extFlagIdx = webCall.args.lastIndexOf(webExtPath);
  assert.ok(extFlagIdx > 0 && webCall.args[extFlagIdx - 1] === '-e', 'web sonic loads deepseek-search extension');
  assert.ok(!codeCall.args.includes(webExtPath), 'code sonic does not load web extension');

  write(join(byKind.code, 'report.md'), 'Synthetic code facts.\n');
  write(join(byKind.web, 'report.md'), 'Synthetic web facts with https://example.invalid/rfc6749.\n');
  write(join(byKind.code, 'release-sonic'), '');
  write(join(byKind.web, 'release-sonic'), '');
  await waitLaunch(target);

  const launched = receipt(target.task_dir);
  assert.deepEqual(launched.from_jobs, [receipt(byKind.code).job, receipt(byKind.web).job]);
  assert.equal(launched.prewalk.length, 2);
  assert.equal(launched.prewalk[0].kind, 'code');
  assert.equal(launched.prewalk[0].source, 'caller');
  assert.equal(launched.prewalk[0].ask, truncateScoutAsk(longAsk));
  assert.equal(launched.prewalk[0].job, receipt(byKind.code).job);
  assert.equal(launched.prewalk[0].result, 'attached');
  assert.ok(Number.isInteger(launched.prewalk[0].ms) && launched.prewalk[0].ms >= 0);
  assert.equal(launched.prewalk[1].kind, 'web');
  assert.equal(launched.prewalk[1].source, 'caller');
  assert.equal(launched.prewalk[1].ask, webAsk);
  assert.equal(launched.prewalk[1].job, receipt(byKind.web).job);
  assert.equal(launched.prewalk[1].result, 'attached');

  const ended_at = '2026-11-25T00:00:00.000Z';
  archiveJob(f.env.HUD_HOME, target.task_dir, target.job, launched, { state: 'closed', ended_at }, Date.parse(ended_at), assert.fail);
  const archivedLines = read(join(f.env.HUD_HOME, 'archive', '2026-11.jsonl')).trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(archivedLines[0].prewalk, launched.prewalk);

  // Old records without `ask` and with `decision`/`default` source remain readable by archiveJob.
  const legacyDir = join(jobsDir(f), 'j0000000000000001');
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyReceipt = {
    job: 'j0000000000000001', role: 'imp', request_key: 'legacy', cwd: f.root, created_at: ended_at,
    dispatch_exit_code: 0, stderr_tail: '',
    prewalk: [{ kind: 'code', source: 'decision', job: 'j0000000000000002', result: 'attached', ms: 42 }],
  };
  archiveJob(f.env.HUD_HOME, legacyDir, legacyReceipt.job, legacyReceipt, { state: 'closed', ended_at }, Date.parse(ended_at), assert.fail);
  const archivedAll = read(join(f.env.HUD_HOME, 'archive', '2026-11.jsonl')).trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(archivedAll[1].prewalk, legacyReceipt.prewalk);

  // Role prewalk: "off" does not require scouts, and global autoPrewalk off does not require scouts.
  const rolesDir = join(f.env.HUD_HOME, 'roles');
  const shippedImp = JSON.parse(read(join(process.cwd(), 'packages/hud-mcp/roles/imp.json')));
  write(join(rolesDir, 'imp.json'), JSON.stringify({ ...shippedImp, prewalk: 'off' }));
  const roleOff = await f.call('hud_create', { role: 'imp', task: 'Role off synthetic task.' });
  assert.equal(roleOff.prewalk, undefined);
  assert.equal(receipt(roleOff.task_dir).prewalk, undefined);

  fs.unlinkSync(join(rolesDir, 'imp.json'));
  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false }));
  const switchOff = await f.call('hud_create', { role: 'imp', task: 'Switch off synthetic task.' });
  assert.equal(switchOff.prewalk, undefined);
  assert.equal(receipt(switchOff.task_dir).prewalk, undefined);
  assert.equal(api.requests.length, 0);
});

test('two scouts of the same kind both run with their own ask; partial failure, prewalk: false, off-role scouts and pool pick work', async (t) => {
  for (const kind of ['code', 'docs']) {
    const prompt = prewalkScoutTask(kind, 'Check module exports.', 'Check claude-code.d.ts.');
    assert.match(prompt, /Search only inside this checkout/i);
    assert.match(prompt, /never `\/`, `\$HOME` or other drives/i);
    assert.match(prompt, /"not found in checkout"/);
    assert.match(prompt, /## Question\n\nCheck module exports\./);
  }
  assert.doesNotMatch(prewalkScoutTask('web', 'Check RFC 6749 errors.', 'Implement OAuth.'), /Search only inside this checkout/i);

  const f = await fixture(t, { autoPrewalk: true });
  sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');

  // 1. Two scouts of the same kind ('code') both launch in parallel with distinct asks and both attach.
  const askA = 'Find auth module entry points.';
  const askB = 'Find billing module entry points.';
  const sameKind = await f.call('hud_create', {
    role: 'imp', task: 'Update auth and billing synthetic modules.',
    scouts: [{ kind: 'code', ask: askA }, { kind: 'code', ask: askB }],
  });
  const pair = await waitScouts(f, sameKind.job, 2);
  assert.equal(pair.length, 2);
  const ids = pair.map(dir => receipt(dir).job);
  assert.notEqual(ids[0], ids[1], 'same-kind scouts must spawn distinct sonic jobs');
  const briefs = pair.map(dir => brief(dir));
  assert.ok(briefs.some(b => b.includes(`## Question\n\n${askA}\n`)), 'first ask in sonic brief');
  assert.ok(briefs.some(b => b.includes(`## Question\n\n${askB}\n`)), 'second ask in sonic brief');
  for (const dir of pair) {
    write(join(dir, 'report.md'), `Facts for ${receipt(dir).job}.\n`);
    write(join(dir, 'release-sonic'), '');
  }
  await waitLaunch(sameKind);
  const sameRec = receipt(sameKind.task_dir);
  assert.equal(sameRec.from_jobs.length, 2);
  assert.deepEqual(sameRec.prewalk.map(({ kind, source, ask, result }) => ({ kind, source, ask, result })), [
    { kind: 'code', source: 'caller', ask: askA, result: 'attached' },
    { kind: 'code', source: 'caller', ask: askB, result: 'attached' },
  ]);

  // 2. Caller skip (prewalk: false) skips scouts without error and starts imp directly.
  const skipped = await f.call('hud_create', { role: 'imp', task: 'Skipped prewalk synthetic task.', prewalk: false });
  assert.equal(skipped.prewalk, undefined);
  assert.equal(receipt(skipped.task_dir).dispatch_exit_code, 0);

  // 3. Role with prewalk off ('reviewer') still accepts explicit scouts.
  const revAsk = 'Check diff callers in checkout.';
  const revScouted = await f.call('hud_create', {
    role: 'reviewer', task: 'Review synthetic patch.',
    scouts: [{ kind: 'code', ask: revAsk }],
  });
  const [revScout] = await waitScouts(f, revScouted.job, 1);
  assert.ok(brief(revScout).includes(`## Question\n\n${revAsk}\n`));
  write(join(revScout, 'report.md'), 'Caller facts for reviewer.\n');
  write(join(revScout, 'release-sonic'), '');
  await waitLaunch(revScouted);
  assert.equal(receipt(revScouted.task_dir).prewalk[0].source, 'caller');
  assert.equal(receipt(revScouted.task_dir).prewalk[0].ask, revAsk);
  assert.equal(receipt(revScouted.task_dir).prewalk[0].result, 'attached');

  // 4. Partial scout failure: code arrives, docs fails -> target still starts with code attached + note for docs.
  const partial = await f.call('hud_create', {
    role: 'imp', task: 'Partial failure synthetic task.',
    scouts: [{ kind: 'code', ask: 'List symbols.' }, { kind: 'docs', ask: 'List spec clauses.' }],
  });
  const pair2 = await waitScouts(f, partial.job, 2);
  const byKind = Object.fromEntries(pair2.map(dir => [receipt(dir).prewalk_kind, dir]));
  assert.deepEqual(Object.keys(byKind).sort(), ['code', 'docs']);
  assert.match(brief(byKind.docs), /Search only inside this checkout/i);
  assert.match(brief(byKind.docs), /"not found in checkout"/);
  write(join(byKind.code, 'report.md'), 'Arrived code facts.\n');
  write(join(byKind.code, 'release-sonic'), '');
  write(join(byKind.docs, 'fail-sonic'), '');
  write(join(byKind.docs, 'release-sonic'), '');
  await waitLaunch(partial);
  const partialRec = receipt(partial.task_dir);
  assert.deepEqual(partialRec.from_jobs, [receipt(byKind.code).job]);
  assert.equal(partialRec.prewalk.find(e => e.kind === 'code').result, 'attached');
  assert.equal(partialRec.prewalk.find(e => e.kind === 'docs').result, 'failed');
  assert.equal(partialRec.prewalk.find(e => e.kind === 'docs').ask, 'List spec clauses.');
  assert.match(brief(partial.task_dir), /^Scout failed \(docs\): pi exited: 4$/m);
  await until(() => cliState(byKind.docs).state === 'failed', 10000);

  // 5. Pool pick still runs via Decision API while scouts make NO Decision API call.
  const poolDir = join(f.env.HOME, 'style-pool');
  fs.mkdirSync(poolDir);
  write(join(poolDir, 'theme-grey.md'), '# Grey\nKind: personal tool\nFits: working tools\n');
  const rolesDir = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(rolesDir, { recursive: true });
  write(join(rolesDir, 'frontend-imp.json'), JSON.stringify({
    role: 'frontend-imp', instructions: 'implementer', can_continue: true,
    pool: { dir: poolDir, max: 2 },
    run: [{ harness: 'pi', pi_role: 'implementer', model: 'synthetic/fe' }],
  }));
  const api = await fakeDecisionServer(t, body => poolReply(body, ['new', 'personal', 'theme-grey.md']));
  configureFakeDecision(f, api.baseUrl);
  const fe = await f.call('hud_create', {
    role: 'frontend-imp', task: 'Build a synthetic tool dashboard.',
    scouts: [{ kind: 'code', ask: 'Find dashboard components.' }],
  });
  assert.deepEqual(api.requests.map(r => r.prompt_cache_key), ['pool-pick']);
  const [feScout] = await waitScouts(f, fe.job, 1);
  write(join(feScout, 'report.md'), 'Dashboard component paths.\n');
  write(join(feScout, 'release-sonic'), '');
  await waitLaunch(fe);
  const feRec = receipt(fe.task_dir);
  assert.equal(feRec.prewalk.find(e => e.kind === 'pool').result, 'attached');
  assert.equal(feRec.prewalk.find(e => e.kind === 'code').source, 'caller');
  assert.equal(feRec.prewalk.find(e => e.kind === 'code').ask, 'Find dashboard components.');
  assert.equal(feRec.prewalk.find(e => e.kind === 'code').result, 'attached');
});

test('prewalk waits past 5 minutes for a slow scout and attaches its report when it settles', async (t) => {
  const probe = `import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const marker = join(process.env.HOME, 'fast-forward-prewalk');
const ticks = join(process.env.HOME, 'prewalk-ticks');
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(
  ms === 500 ? (...cbArgs) => { if (existsSync(marker)) appendFileSync(ticks, '1\\n'); return fn(...cbArgs); } : fn,
  typeof ms === 'number' && (ms === 500 || ms >= 60000) ? 40 : ms,
  ...args
);
const realPerfNow = performance.now.bind(performance);
const realDateNow = Date.now;
const jump = () => existsSync(marker) ? 6 * 60_000 : 0;
performance.now = () => realPerfNow() + jump();
Date.now = () => realDateNow() + jump();
`;
  const f = await fixture(t, { autoPrewalk: true, probe });
  sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');

  const target = await f.call('hud_create', {
    role: 'imp', task: 'Slow scout synthetic task.',
    scouts: [{ kind: 'code', ask: 'Inspect slow synthetic tree.' }],
  });
  const [slowScout] = await waitScouts(f, target.job, 1);
  write(join(f.env.HOME, 'fast-forward-prewalk'), '');
  const ticksFile = join(f.env.HOME, 'prewalk-ticks');
  await until(() => fs.existsSync(ticksFile) && fs.readFileSync(ticksFile, 'utf8').length >= 2, t.signal);
  assert.equal(cliState(slowScout).state, 'working', 'slow scout is still running past 5 minutes');
  assert.ok(!fs.existsSync(join(target.task_dir, 'SESSION.txt')), 'target still waits for the slow scout');

  write(join(slowScout, 'report.md'), 'Slow scout facts after 6 minutes.\n');
  write(join(slowScout, 'release-sonic'), '');
  await waitLaunch(target);
  const launched = receipt(target.task_dir);
  assert.deepEqual(launched.from_jobs, [receipt(slowScout).job]);
  assert.equal(launched.prewalk[0].result, 'attached');
  assert.ok(launched.prewalk[0].ms >= 6 * 60_000, `expected elapsed >= 360000 ms, got ${launched.prewalk[0].ms}`);
});

test('shipped defaults: reviewer and sonic never require scouts; oracle and frontend-imp require scouts; project prewalk rejected', async (t) => {
  const f = await fixture(t, { autoPrewalk: true });
  sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');

  // reviewer and sonic succeed without scouts.
  const rev = await f.call('hud_create', { role: 'reviewer', task: 'Review synthetic diff.' });
  const son = await f.call('hud_create', { role: 'sonic', task: 'List synthetic files.' });
  assert.equal(rev.prewalk, undefined);
  assert.equal(son.prewalk, undefined);

  // oracle requires scouts by default.
  assert.equal((await f.call('hud_create', { role: 'oracle', task: 'Design synthetic architecture.' })).code, 'invalid_arguments');
  const ora = await f.call('hud_create', { role: 'oracle', task: 'Design synthetic architecture.', scouts: [] });
  assert.deepEqual(ora.prewalk, []);

  // frontend-imp (owner role without explicit prewalk) defaults to on, requires scouts, and MCP task receipt includes prewalk.
  const rolesDir = join(f.env.HUD_HOME, 'roles');
  write(join(rolesDir, 'frontend-imp.json'), JSON.stringify({
    role: 'frontend-imp', instructions: 'implementer', can_continue: true,
    run: [{ harness: 'pi', pi_role: 'implementer', model: 'synthetic/fe' }],
  }));
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const missingFe = await taskCall(rpc, 'hud_create', { role: 'frontend-imp', task: 'Build synthetic UI.' });
  assert.equal(missingFe.resultType, 'complete');
  assert.match(missingFe.content[0].text, /invalid_arguments/);
  const task = await taskCall(rpc, 'hud_create', { role: 'frontend-imp', task: 'Build synthetic UI.', scouts: [] });
  assert.deepEqual(task.prewalk, []);
  assert.deepEqual(receipt(taskJob(f, task).task_dir).prewalk, []);

  // Project role file declaring prewalk is rejected.
  write(join(f.env.HUD_HOME, 'projects.json'), JSON.stringify({
    version: 1, projects: [{ root: f.root, registered_at: new Date().toISOString() }],
  }));
  fs.mkdirSync(join(f.root, '.hud', 'roles'), { recursive: true });
  write(join(f.root, '.hud', 'roles', 'bad-prewalk.json'), JSON.stringify({
    role: 'bad-prewalk', instructions: 'implementer', can_continue: true, prewalk: 'on',
    run: [{ harness: 'pi', pi_role: 'implementer' }],
  }));
  const roster = await f.call('hud_roster', { detail: true });
  assert.ok(roster.invalid.some(item => item.reason === 'prewalk is only allowed in owner role files'));

  write(join(son.task_dir, 'release-sonic'), '');
  publishSonic(ora.task_dir, { state: 'done' });
});
