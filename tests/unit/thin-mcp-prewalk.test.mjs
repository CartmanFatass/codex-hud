import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { archiveJob } from '../../dist/roles/job-archive.js';
import {
  configureFakeDecision, fakeDecisionServer, fixture, publishSonic,
  sonicTask, taskCall, taskJob, taskRpc, until,
} from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as write } from '../helpers/thin-mcp-files.mjs';

const read = (file) => fs.readFileSync(file, 'utf8');
const receipt = (dir) => JSON.parse(read(join(dir, 'job.json')));
const brief = (dir) => read(join(dir, 'brief.md'));
const jobsDir = (f) => join(f.env.HUD_HOME, 'jobs');
const waitLaunch = (job) => until(() => receipt(job.task_dir).dispatch_exit_code !== null, 25000);

function decisionReply(body, answers) {
  return {
    answers: body.questions.map(({ name, choices }) => {
      const choice = answers[name] ?? 'no';
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

test('prewalk on: code+web starts two parallel sonics then imp with both attached; none starts directly; off makes no call', async (t) => {
  const f = await fixture(t, { autoPrewalk: true });
  sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  // Place a personal deepseek-search extension so web kind loads it when pi-role lacks bundled search.
  const extDir = join(f.env.PI_CODING_AGENT_DIR, 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  const webExtPath = join(extDir, 'deepseek-search.ts');
  write(webExtPath, '// synthetic deepseek-search extension\n');

  let mode = 'code+web';
  const api = await fakeDecisionServer(t, (body) => {
    if (mode === 'code+web') return decisionReply(body, { code: 'yes', docs: 'no', web: 'yes' });
    return decisionReply(body, { code: 'no', docs: 'no', web: 'no' });
  });
  configureFakeDecision(f, api.baseUrl);
  write(join(f.root, 'local-ctx.md'), 'Synthetic local context.');

  const task = 'Implement synthetic OAuth client against RFC 6749 with private internal path /secret/app.';
  const target = await f.call('hud_create', { role: 'imp', task, context_files: ['local-ctx.md'] });
  assert.equal(api.requests.length, 1);
  const req = api.requests[0];
  assert.equal(req.prompt_cache_key, 'prewalk');
  assert.deepEqual(req.questions.map(q => q.name), ['code', 'docs', 'web']);
  assert.ok(req.questions.every(q => q.type === 'choice' && /untrusted data/.test(q.instructions)));
  assert.deepEqual(target.prewalk.map(({ kind, source, result }) => ({ kind, source, result })), [
    { kind: 'code', source: 'decision', result: 'running' },
    { kind: 'web', source: 'decision', result: 'running' },
  ]);

  const scouts = await waitScouts(f, target.job, 2);
  const byKind = Object.fromEntries(scouts.map(dir => [receipt(dir).prewalk_kind, dir]));
  assert.deepEqual(Object.keys(byKind).sort(), ['code', 'web']);
  assert.ok(!fs.existsSync(join(target.task_dir, 'SESSION.txt')), 'target waits while both scouts run in parallel');

  // Verify web scout brief forbids private content in queries and gets no local context_files.
  const webBrief = brief(byKind.web);
  assert.match(webBrief, /primary external sources/i);
  assert.match(webBrief, /NEVER include local file paths.*private content/i);
  assert.match(webBrief, /Facts only/i);
  assert.equal(receipt(byKind.web).context_files, undefined);
  assert.deepEqual(receipt(byKind.code).context_files, [join(f.root, 'local-ctx.md')]);

  // Verify web tools extension is passed to pi-role for web kind ONLY (when pi-role doesn't bundle it).
  const piRoleCalls = f.commands().filter(c => c.command === 'pi-role' && c.args[1] === 'sonic');
  const webCall = piRoleCalls.find(c => c.args.includes(join(byKind.web, 'report.md')));
  const codeCall = piRoleCalls.find(c => c.args.includes(join(byKind.code, 'report.md')));
  assert.ok(webCall, 'web sonic invoked pi-role');
  assert.ok(codeCall, 'code sonic invoked pi-role');
  const extFlagIdx = webCall.args.lastIndexOf(webExtPath);
  assert.ok(extFlagIdx > 0 && webCall.args[extFlagIdx - 1] === '-e', 'web sonic loads deepseek-search extension');
  assert.ok(!codeCall.args.includes(webExtPath), 'code sonic does not load web extension');
  assert.ok(!webCall.args.join(' ').includes('deepseek_search'), 'web tools are not excluded');

  // Release both scouts and verify target starts with both reports attached + job.json + archive prewalk entries.
  write(join(byKind.code, 'report.md'), 'Synthetic code facts.\n');
  write(join(byKind.web, 'report.md'), 'Synthetic web facts with https://example.invalid/rfc6749.\n');
  write(join(byKind.code, 'release-sonic'), '');
  write(join(byKind.web, 'release-sonic'), '');
  await waitLaunch(target);

  const launched = receipt(target.task_dir);
  assert.deepEqual(launched.from_jobs, [receipt(byKind.code).job, receipt(byKind.web).job]);
  assert.equal(launched.prewalk.length, 2);
  assert.equal(launched.prewalk[0].kind, 'code');
  assert.equal(launched.prewalk[0].source, 'decision');
  assert.equal(launched.prewalk[0].job, receipt(byKind.code).job);
  assert.equal(launched.prewalk[0].result, 'attached');
  assert.ok(Number.isInteger(launched.prewalk[0].ms) && launched.prewalk[0].ms >= 0);
  assert.equal(launched.prewalk[1].kind, 'web');
  assert.equal(launched.prewalk[1].source, 'decision');
  assert.equal(launched.prewalk[1].job, receipt(byKind.web).job);
  assert.equal(launched.prewalk[1].result, 'attached');

  const ended_at = '2026-11-25T00:00:00.000Z';
  archiveJob(f.env.HUD_HOME, target.task_dir, target.job, launched, { state: 'closed', ended_at }, Date.parse(ended_at), assert.fail);
  const archived = JSON.parse(read(join(f.env.HUD_HOME, 'archive', '2026-11.jsonl')));
  assert.deepEqual(archived.prewalk, launched.prewalk);

  // Answering none starts imp directly with no scouts and prewalk: [].
  mode = 'none';
  const direct = await f.call('hud_create', { role: 'imp', task: 'Tiny synthetic typo fix.' });
  assert.equal(api.requests.length, 2);
  assert.equal(receipt(direct.task_dir).dispatch_exit_code, 0);
  assert.deepEqual(direct.prewalk, []);
  assert.deepEqual(receipt(direct.task_dir).prewalk, []);

  // Role prewalk: "off" makes no Decision API call.
  const rolesDir = join(f.env.HUD_HOME, 'roles');
  const shippedImp = JSON.parse(read(join(process.cwd(), 'packages/hud-mcp/roles/imp.json')));
  write(join(rolesDir, 'imp.json'), JSON.stringify({ ...shippedImp, prewalk: 'off' }));
  const roleOff = await f.call('hud_create', { role: 'imp', task: 'Role off synthetic task.' });
  assert.equal(api.requests.length, 2);
  assert.equal(roleOff.prewalk, undefined);
  assert.equal(receipt(roleOff.task_dir).prewalk, undefined);

  // Restore imp role and turn off global autoPrewalk switch -> no Decision API call.
  fs.unlinkSync(join(rolesDir, 'imp.json'));
  write(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false }));
  const switchOff = await f.call('hud_create', { role: 'imp', task: 'Switch off synthetic task.' });
  assert.equal(api.requests.length, 2);
  assert.equal(switchOff.prewalk, undefined);
  assert.equal(receipt(switchOff.task_dir).prewalk, undefined);
});

test('Decision API failure falls back to code scout; caller scout, caller skip and prewalk timeout behave as specified', async (t) => {
  const prevTimeout = process.env.HUD_PREWALK_TIMEOUT_MS;
  process.env.HUD_PREWALK_TIMEOUT_MS = '2500';
  t.after(() => {
    if (prevTimeout === undefined) delete process.env.HUD_PREWALK_TIMEOUT_MS;
    else process.env.HUD_PREWALK_TIMEOUT_MS = prevTimeout;
  });

  const f = await fixture(t, { autoPrewalk: true });
  sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');

  let failApi = true;
  const api = await fakeDecisionServer(t, (body) => failApi
    ? { status: 503 }
    : decisionReply(body, { code: 'yes', docs: 'yes', web: 'no' }));
  configureFakeDecision(f, api.baseUrl);

  // 1. Decision API failure -> falls back to single code scout with source: 'default'.
  const fallback = await f.call('hud_create', { role: 'imp', task: 'Fallback synthetic task.' });
  assert.equal(api.requests.length, 1);
  assert.deepEqual(fallback.prewalk.map(({ kind, source }) => ({ kind, source })), [{ kind: 'code', source: 'default' }]);
  const [fbScout] = await waitScouts(f, fallback.job, 1);
  assert.equal(receipt(fbScout).prewalk_kind, 'code');
  write(join(fbScout, 'report.md'), 'Synthetic fallback code facts.\n');
  write(join(fbScout, 'release-sonic'), '');
  await waitLaunch(fallback);
  assert.equal(receipt(fallback.task_dir).prewalk[0].source, 'default');
  assert.equal(receipt(fallback.task_dir).prewalk[0].result, 'attached');
  assert.deepEqual(receipt(fallback.task_dir).from_jobs, [receipt(fbScout).job]);

  // 2. Caller skip (prewalk: false) makes no Decision API call and starts imp directly.
  const skipped = await f.call('hud_create', { role: 'imp', task: 'Skipped prewalk synthetic task.', prewalk: false });
  assert.equal(api.requests.length, 1);
  assert.equal(skipped.prewalk, undefined);
  assert.equal(receipt(skipped.task_dir).dispatch_exit_code, 0);

  // Invalid combination: prewalk: false + scout.
  const conflict = await f.call('hud_create', { role: 'imp', task: 'Conflict.', prewalk: false, scout: 'Where?' });
  assert.equal(conflict.code, 'invalid_arguments');

  // 3. Caller scout makes no Decision API call and records source: 'caller'.
  const custom = await f.call('hud_create', { role: 'imp', task: 'Custom scout synthetic task.', scout: 'Where is foo?' });
  assert.equal(api.requests.length, 1);
  assert.equal(custom.prewalk[0].source, 'caller');
  const [customScout] = await waitScouts(f, custom.job, 1);
  assert.ok(brief(customScout).startsWith('Where is foo?\n'));
  write(join(customScout, 'report.md'), 'Synthetic custom dossier.\n');
  write(join(customScout, 'release-sonic'), '');
  await waitLaunch(custom);
  assert.equal(receipt(custom.task_dir).prewalk[0].source, 'caller');
  assert.equal(receipt(custom.task_dir).prewalk[0].result, 'attached');

  // 4. Prewalk timeout: code arrives, docs exceeds timeout -> target starts with code attached + note for docs.
  failApi = false;
  const timed = await f.call('hud_create', { role: 'imp', task: 'Partial timeout synthetic task.' });
  const pair = await waitScouts(f, timed.job, 2);
  const byKind = Object.fromEntries(pair.map(dir => [receipt(dir).prewalk_kind, dir]));
  assert.deepEqual(Object.keys(byKind).sort(), ['code', 'docs']);
  write(join(byKind.code, 'report.md'), 'Arrived code facts.\n');
  write(join(byKind.code, 'release-sonic'), '');
  // Do NOT release docs: it hits HUD_PREWALK_TIMEOUT_MS and gets stopped.
  await waitLaunch(timed);
  const timedRec = receipt(timed.task_dir);
  assert.deepEqual(timedRec.from_jobs, [receipt(byKind.code).job]);
  assert.equal(timedRec.prewalk.find(e => e.kind === 'code').result, 'attached');
  assert.equal(timedRec.prewalk.find(e => e.kind === 'docs').result, 'timeout');
  assert.match(brief(timed.task_dir), /^Scout failed \(docs\): timeout$/m);
  await until(() => JSON.parse(read(join(byKind.docs, 'STATUS.json'))).state === 'stopped', 10000);
});

test('shipped defaults: reviewer and sonic never prewalk by default; oracle and frontend-imp prewalk; project prewalk rejected', async (t) => {
  const f = await fixture(t, { autoPrewalk: true });
  sonicTask(f);
  fs.writeFileSync(join(f.env.HOME, 'defer-pi-report'), '');
  const api = await fakeDecisionServer(t, (body) => decisionReply(body, { code: 'no', docs: 'no', web: 'no' }));
  configureFakeDecision(f, api.baseUrl);

  // reviewer and sonic make NO Decision API call by default.
  const rev = await f.call('hud_create', { role: 'reviewer', task: 'Review synthetic diff.' });
  const son = await f.call('hud_create', { role: 'sonic', task: 'List synthetic files.' });
  assert.equal(api.requests.length, 0);
  assert.equal(rev.prewalk, undefined);
  assert.equal(son.prewalk, undefined);

  // oracle prewalks by default (Decision API called).
  const ora = await f.call('hud_create', { role: 'oracle', task: 'Design synthetic architecture.' });
  assert.equal(api.requests.length, 1);
  assert.deepEqual(ora.prewalk, []);

  // frontend-imp (owner role without explicit prewalk) defaults to on, and MCP task receipt includes prewalk.
  const rolesDir = join(f.env.HUD_HOME, 'roles');
  write(join(rolesDir, 'frontend-imp.json'), JSON.stringify({
    role: 'frontend-imp', instructions: 'implementer', can_continue: true,
    run: [{ harness: 'pi', pi_role: 'implementer', model: 'synthetic/fe' }],
  }));
  const rpc = taskRpc(f.rpc);
  await rpc('server/discover');
  const task = await taskCall(rpc, 'hud_create', { role: 'frontend-imp', task: 'Build synthetic UI.' });
  assert.equal(api.requests.length, 2);
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

  // Release sonic job so fixture cleanup finishes promptly.
  write(join(son.task_dir, 'release-sonic'), '');
  publishSonic(ora.task_dir, { state: 'done' });
});
