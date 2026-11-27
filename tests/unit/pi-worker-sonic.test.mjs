import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { importCommand } from '../../dist/cli/import.js';
import { readContract } from '../../dist/harness/pi/worker/contract.js';
import { roleRuntime } from '../../dist/harness/pi/worker/role-runtime.js';
import { trackTps } from '../../dist/harness/pi/worker/tps.js';
import { webSearch } from '../../dist/harness/pi/worker/web-search.js';
import { piWorkerArgv } from '../../dist/mcp/dispatch/pi-worker-argv.js';
import { rolePlacesFixture, until } from '../helpers/thin-mcp-harness.mjs';

const model = 'ds/deepseek-v4.1-flash-1017';
const job = { job: 'j1111111111111111', role: 'sonic', model, thinking: 'high', headless: true };
const protocol = ['hud_report', 'hud_progress', 'hud_lease'];
const legacyTools = ['bash', 'deepseek_fetch', 'deepseek_search', 'edit', 'find', 'grep', 'hud_lease', 'hud_progress', 'hud_report', 'ls', 'read', 'write'];
function temp(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-pi-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function host() {
  const hooks = {}, tools = {}, records = [];
  let active = ['read'];
  return { hooks, tools, records, on: (key, fn) => { hooks[key] = fn; }, registerTool: tool => { tools[tool.name] = tool; },
    appendEntry: (...args) => records.push(args), getThinkingLevel: () => 'high', getActiveTools: () => active, setActiveTools: names => { active = names; },
    getAllTools: () => [...legacyTools, 'powershell', 'ask_user', 'hud_sonic', 'hud_ask', 'ask_orchestrator', 'codemode'].map(name => ({ name })) };
}

test('native Sonic argv and private contract round trip, checkout and installed entry', t => {
  const home = temp(t), dir = join(home, 'jobs', job.job), installed = join(home, 'pi-worker', 'hud-worker.mjs');
  fs.mkdirSync(dir, { recursive: true });
  const build = more => piWorkerArgv(home, dir, { ...job, ...more }, { instructions: 'sonic' }, 'sonic', ['--skill', '/synthetic/skill'], 'literal brief');
  assert.deepEqual(build(), ['-ne', '-ns', '-np', '--no-themes', '--no-mcp', '-e', resolve('integrations/pi/worker/hud-worker.mjs'),
    '--model', model, '--thinking', 'high', '--skill', '/synthetic/skill', '--exclude-tools', 'hud_ask,ask_orchestrator,hud_sonic',
    '--session', join(dir, 'sonic-session.jsonl'), '--print', '--mode', 'json', '--', 'literal brief']);
  const file = join(dir, 'pi-worker.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readContract(dir), { version: 1, role: 'sonic', job: job.job, model, thinking: 'high', instructions: 'sonic', explicitTools: false, tps: true });
  fs.mkdirSync(join(home, 'pi-worker'));
  fs.symlinkSync(resolve('integrations/pi/worker/hud-worker.mjs'), installed);
  const args = build({ skills: true, pi_args: ['--tools', 'read', '-xt', 'write'], tps: false });
  assert.ok(args.includes(installed)); assert.ok(!args.includes('-ns'));
  assert.ok(args.includes(['read', ...protocol].join(','))); assert.ok(readContract(dir).explicitTools); assert.equal(readContract(dir).tps, false);
  assert.equal(args[args.indexOf('--exclude-tools') + 1], 'hud_ask,ask_orchestrator,hud_sonic,write');
  assert.throws(() => build({ mcp: true }), /attachment is missing/);
  assert.throws(() => build({ pi_args: ['--role-bundle=invalid'] }), /legacy role/);
  fs.writeFileSync(file, JSON.stringify({ ...readContract(dir), version: 2 }));
  assert.throws(() => readContract(dir), /Invalid/);
});

test('headless role section, active tools, model and thinking match the legacy probe', () => {
  const pi = host(), ctx = { model: { provider: 'ds', id: model.split('/')[1] } };
  roleRuntime(pi, { ...job, instructions: 'sonic' }, reason => { throw Error(reason); });
  pi.hooks.session_start({}, ctx);
  const opts = { sections: {}, skills: [{ name: 'helper-pane' }, { name: 'kept' }] };
  pi.hooks.before_agent_start({ systemPromptOptions: opts });
  assert.deepEqual({ section: opts.sections.role, activeTools: pi.getActiveTools().sort(), model: `${ctx.model.provider}/${ctx.model.id}`, thinking: pi.getThinkingLevel() },
    { section: fs.readFileSync('packages/hud-mcp/instructions/sonic.md', 'utf8').trim(), activeTools: legacyTools, model, thinking: 'high' });
  assert.deepEqual(opts.skills, [{ name: 'kept' }]);
  assert.throws(() => pi.hooks.session_start({}, { model: { provider: 'other', id: ctx.model.id } }), /Requested model/);
  pi.getThinkingLevel = () => 'off'; assert.throws(() => pi.hooks.session_start({}, ctx), /Requested thinking/);
});

test('explicit private key import and DeepSeek search/fetch: only public tool inputs leave; errors do not quote upstream bodies', async t => {
  const home = temp(t), old = join(home, 'old-key'), dest = join(home, 'credentials.env'), output = [];
  fs.writeFileSync(old, 'synthetic-key\n');
  const migrate = mode => importCommand([mode, '--deepseek-key', '--from', old], { env: { HUD_HOME: home }, stdout: s => output.push(s), stderr: assert.fail });
  assert.equal(await migrate('preview'), 0); assert.ok(!fs.existsSync(dest));
  const pi = host(), requests = [];
  const fetchStub = async (url, opts) => { requests.push({ url, ...opts }); return Response.json(url.endsWith('search') ?
    { results: [{ title: 'Example', url: 'https://example.invalid', summary: 'Summary' }] } : { title: 'Page', content: 'Page body' }); };
  webSearch(pi, home, fetchStub); assert.deepEqual(Object.keys(pi.tools), []);
  assert.equal(await migrate('apply'), 0); assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
  fs.writeFileSync(old, 'different-key'); assert.equal(await migrate('apply'), 0);
  assert.doesNotMatch(output.join(''), /synthetic-key|different-key/);
  webSearch(pi, home, fetchStub);
  const result = await pi.tools.deepseek_search.execute('id', { query: ' docs ' });
  assert.deepEqual(JSON.parse(requests[0].body), { query: 'docs', count: 5, need_content: false });
  assert.equal(requests[0].headers.Authorization, 'Bearer synthetic-key'); assert.match(result.content[0].text, /Summary/);
  await assert.rejects(pi.tools.deepseek_fetch.execute('id', { url: 'https://name:pass@example.invalid' }));
  const page = await pi.tools.deepseek_fetch.execute('id', { url: 'https://example.invalid', max_chars: 4 });
  assert.deepEqual(JSON.parse(requests[1].body), { url: 'https://example.invalid' }); assert.match(page.content[0].text, /Truncated/);
  webSearch(pi, home, async () => new Response('secret upstream error', { status: 401 }));
  await assert.rejects(pi.tools.deepseek_search.execute('id', { query: 'docs' }), { message: 'DeepSeek search: HTTP 401' });
});

test('tps writes the pi-tps 1.3 custom entry payload with a measured stream span and native usage', () => {
  const pi = host(); let now = 100;
  trackTps(pi, () => now);
  const cost = { input: .01, output: .02, cacheRead: 0, cacheWrite: 0, total: .03 };
  const msg = { message: { role: 'assistant', provider: 'test', model: 'tiny', usage: { input: 90, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost } } };
  pi.hooks.turn_start(); now = 110; pi.hooks.message_start(msg);
  for (now of [150, 160, 210, 260, 310, 360]) pi.hooks.message_update(msg);
  now = 370; pi.hooks.message_end(msg); now = 450; pi.hooks.turn_end();
  assert.equal(pi.records.length, 1); const [type, { timestamp, ...data }] = pi.records[0]; assert.equal(type, 'tps'); assert.ok(Number.isFinite(timestamp));
  assert.deepEqual(data, { model: { provider: 'test', modelId: 'tiny' }, tokens: { input: 90, output: 10, cacheRead: 0, cacheWrite: 0, total: 100 },
    timing: { ttftMs: 50, totalMs: 350, generationMs: 260, streamMs: 200, stallMs: 0, stallCount: 0, messageCount: 1 },
    tps: 50, isPrimaryBranch: true, cost, rateUsdPerMTokens: 300 });
});

test('headless Sonic on a closed PATH resolves omitted model and declares its report', async t => {
  const f = await rolePlacesFixture(t);
  const roles = join(f.env.HUD_HOME, 'roles'); fs.mkdirSync(roles, { recursive: true });
  fs.writeFileSync(join(roles, 'sonic.json'), JSON.stringify({ role: 'sonic', instructions: 'sonic', can_continue: false, run: [{ harness: 'pi', pi_role: 'sonic' }] }));
  const created = await f.call('hud_create', { role: 'sonic', task: 'Synthetic query.' });
  assert.ok(created.task_dir, JSON.stringify(created));
  assert.equal(readContract(created.task_dir).model, model);
  await until(() => fs.existsSync(join(created.task_dir, 'done.json')), t.signal);
  assert.equal(fs.readFileSync(join(created.task_dir, 'report.md'), 'utf8'), 'Synthetic implementation report.');
});
