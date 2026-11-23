import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entry, rpcClient } from '../helpers/thin-mcp-harness.mjs';
import { cleanupFixture, stopChild } from '../helpers/process-cleanup.mjs';

const job = 'j0000000000000001';
const workerSession = '00000000-0000-4000-8000-000000000001';
const mainSession = '00000000-0000-4000-8000-000000000002';
const recovery = new RegExp(`worker job ${job}.*resumed without its HUD binding.*Recovery is manual.*retry_of.*fresh tab`);

function fixture(t, agent) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-resume-guard-'));
  const env = { HOME: join(root, 'home'), HUD_HOME: join(root, 'hud'), TMPDIR: root, HUD_MCP_SURFACE: 'roles', HERDR_PANE_ID: 'w9:p2' };
  const stops = [];
  cleanupFixture(t, { root, hudHome: env.HUD_HOME }, () => Promise.all(stops.map((stop) => stop())));
  const jobs = join(env.HUD_HOME, 'jobs'), dir = join(jobs, job);
  fs.mkdirSync(env.HOME);
  fs.mkdirSync(dir, { recursive: true });
  const writeStatus = (id = workerSession) => fs.writeFileSync(join(dir, 'STATUS.json'),
    JSON.stringify({ slot: 'primary', state: 'failed', agent, harness: 'cli', agent_session_id: id }));
  writeStatus();
  return {
    jobs, writeStatus,
    start(sessionEnv = {}) {
      const child = spawn(process.execPath, [entry], { cwd: root, env: { ...env, ...sessionEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
      const exit = once(child, 'close');
      let stopping;
      const stop = () => stopping ??= stopChild(child, exit, { closeStdin: true });
      stops.push(stop);
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      const rpc = rpcClient(child);
      return { rpc, async close() { assert.deepEqual((await stop()).result, [0, null]); return stderr; } };
    },
  };
}

const refusal = (reply) => {
  assert.equal(reply.result.isError, true);
  const { ok, code, error } = JSON.parse(reply.result.content[0].text);
  assert.equal(ok, false);
  assert.equal(code, 'resume_refused');
  assert.match(error, recovery);
};

test('Claude hides the main tools for a resumed worker and fails open for an unrelated session', async (t) => {
  const f = fixture(t, 'claude');
  const worker = f.start({ CLAUDE_CODE_SESSION_ID: workerSession });
  try {
    assert.match((await worker.rpc('initialize')).result.instructions, recovery);
    assert.deepEqual((await worker.rpc('tools/list')).result.tools, []);
    for (const name of ['hud_create', 'hud_close', 'hud_send']) refusal(await worker.rpc('tools/call', { name }));
  } finally { await worker.close(); }

  const broken = join(f.jobs, 'j0000000000000002');
  fs.mkdirSync(broken);
  fs.writeFileSync(join(broken, 'STATUS.json'), '{');
  const main = f.start({ CLAUDE_CODE_SESSION_ID: mainSession });
  let diagnostic;
  try {
    assert.ok((await main.rpc('tools/list')).result.tools.some(({ name }) => name === 'hud_create'));
    assert.notEqual((await main.rpc('tools/call', { name: 'hud_roster' })).result.isError, true);
  } finally { diagnostic = await main.close(); }
  assert.match(diagnostic, /no matching worker session.*1 unreadable status records.*allowing main-session tools/);
});

test('Codex refuses the first call with a resumed thread ID and caches the result without initialize metadata', async (t) => {
  const f = fixture(t, 'codex');
  const worker = f.start();
  try {
    const init = await worker.rpc('initialize', { clientInfo: { name: 'codex', version: '0.166.0' } });
    assert.doesNotMatch(init.result.instructions, recovery);
    assert.ok((await worker.rpc('tools/list', { _meta: { progressToken: 1 } })).result.tools.some(({ name }) => name === 'hud_create'));
    refusal(await worker.rpc('tools/call', {
      name: 'hud_create', arguments: { _meta: { threadId: mainSession } },
      _meta: { threadId: workerSession, 'x-codex-turn-metadata': { thread_id: workerSession } },
    }));
    f.writeStatus(mainSession);
    refusal(await worker.rpc('tools/call', { name: 'hud_send' }));
    assert.deepEqual((await worker.rpc('tools/list')).result.tools, []);
  } finally { await worker.close(); }

  f.writeStatus();
  const main = f.start();
  try {
    const roster = await main.rpc('tools/call', { name: 'hud_roster', _meta: { threadId: mainSession } });
    assert.notEqual(roster.result.isError, true);
    assert.ok((await main.rpc('tools/list')).result.tools.some(({ name }) => name === 'hud_create'));
  } finally { await main.close(); }
});

test('Antigravity refuses resumed workers from conversation metadata and a clean main-session miss stays silent', async (t) => {
  const f = fixture(t, 'agy');
  const init = { clientInfo: { name: 'antigravity-client', version: 'synthetic' } };
  const conversation = (id) => ({ 'antigravity.google/conversation_id': id });
  const worker = f.start();
  try {
    await worker.rpc('server/discover');
    assert.doesNotMatch((await worker.rpc('initialize', init)).result.instructions, recovery);
    assert.ok((await worker.rpc('tools/list')).result.tools.some(({ name }) => name === 'hud_wait'));
    refusal(await worker.rpc('tools/call', {
      name: 'hud_create', arguments: { _meta: conversation(mainSession) }, _meta: conversation(workerSession),
    }));
    refusal(await worker.rpc('tools/call', { name: 'hud_send' }));
    assert.deepEqual((await worker.rpc('tools/list')).result.tools, []);
  } finally { assert.equal(await worker.close(), ''); }

  const main = f.start();
  try {
    await main.rpc('initialize', init);
    const reply = await main.rpc('tools/call', { name: 'hud_roster', _meta: conversation(mainSession) });
    assert.notEqual(reply.result.isError, true);
    assert.ok((await main.rpc('tools/list')).result.tools.some(({ name }) => name === 'hud_create'));
  } finally { assert.equal(await main.close(), ''); }
});
