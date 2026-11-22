import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entry, rpcClient } from '../helpers/thin-mcp-harness.mjs';

const job = 'j0000000000000001';
const workerSession = '00000000-0000-4000-8000-000000000001';
const mainSession = '00000000-0000-4000-8000-000000000002';
const recovery = new RegExp(`worker job ${job}.*resumed without its HUD binding.*Recovery is manual.*retry_of.*fresh tab`);

function fixture(t, agent) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-resume-guard-'));
  const env = { HOME: join(root, 'home'), HUD_HOME: join(root, 'hud'), HUD_MCP_SURFACE: 'roles', HERDR_PANE_ID: 'w9:p2' };
  const jobs = join(env.HUD_HOME, 'jobs'), dir = join(jobs, job);
  fs.mkdirSync(env.HOME);
  fs.mkdirSync(dir, { recursive: true });
  const writeStatus = (id = workerSession) => fs.writeFileSync(join(dir, 'STATUS.json'),
    JSON.stringify({ slot: 'primary', state: 'failed', agent, harness: 'cli', agent_session_id: id }));
  writeStatus();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    jobs, writeStatus,
    start(sessionEnv = {}) {
      const child = spawn(process.execPath, [entry], { cwd: root, env: { ...env, ...sessionEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
      const exit = once(child, 'close');
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      const rpc = rpcClient(child);
      return { rpc, async close() { child.stdin.end(); assert.deepEqual(await exit, [0, null]); return stderr; } };
    },
  };
}

const refusal = (reply) => {
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, recovery);
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
