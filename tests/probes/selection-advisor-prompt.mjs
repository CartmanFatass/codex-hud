// Run with the temporary-HOME wrapper and pi 1.6+ on PATH. No real provider is called.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { piWorkerArgv } from '../../dist/mcp/dispatch/pi-worker-argv.js';
import { formatSelectionMessage } from '../../dist/roles/select-send.js';

const run = promisify(execFile);
const requests = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  requests.push(body);
  const base = { id: 'synthetic', model: 'test-model', object: 'chat.completion.chunk', created: 1 };
  const parts = [{ delta: { role: 'assistant', content: 'Synthetic answer.' }, finish_reason: null },
    { delta: {}, finish_reason: 'stop' }];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const choice of parts) res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, ...choice }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
const root = fs.mkdtempSync(join(tmpdir(), 'hud-selection-advisor-probe-'));
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const agent = join(root, 'pi'), home = join(root, 'hud'), cwd = join(root, 'synthetic-checkout');
  const job = 'j1111111111111111', dir = join(home, 'jobs', job), session = join(dir, 'advisor.jsonl');
  fs.mkdirSync(agent);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(join(cwd, '.pi'), { recursive: true });
  const sentinel = 'SYNTHETIC_PROJECT_APPEND_MUST_NOT_TRAVEL';
  fs.writeFileSync(join(cwd, '.pi', 'APPEND_SYSTEM.md'), sentinel);
  fs.writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'advisor-fixture': {
    api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic', models: [{ id: 'test-model' }],
  } } }));
  const receipt = { job, role: 'oracle', headless: true, selection_advisor: 'test-excerpt', model: 'advisor-fixture/test-model', cwd };
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify(receipt));
  fs.writeFileSync(session, '');

  const env = { HOME: root, PATH: process.env.PATH, HUD_JOB_DIR: dir, HUD_HOME: home, PI_CODING_AGENT_DIR: agent };
  const first = formatSelectionMessage({ excerpt: '+ synthetic guard', question: 'Why is it needed?',
    source: { project: basename(cwd), projectRoot: cwd, pane: 'w1:p1', job: null, role: null, time: new Date(0).toISOString() } });
  const followUp = 'Follow-up question: Does it still run?';
  for (const turn of [first, followUp]) {
    const args = piWorkerArgv(home, dir, receipt, { instructions: 'oracle' }, 'architect', [], turn, session);
    const processResult = run('pi', ['--offline', '--approve', ...args], { cwd, env, timeout: 15000 });
    processResult.child.stdin.end();
    await processResult;
    assert.equal(requests.length, 1);
    const raw = requests.pop();
    assert.ok(!raw.includes(sentinel), 'checkout append prompt leaked to the provider');
    assert.ok(!raw.includes(cwd), 'checkout path leaked to the provider');
    const { messages, tools } = JSON.parse(raw);
    const system = messages.filter(message => ['system', 'developer'].includes(message.role));
    assert.equal(system.length, 1);
    assert.match(JSON.stringify(system[0].content), /Discuss only the supplied selection/);
    assert.deepEqual(tools.map(tool => tool.function.name), ['hud_report']);
    assert.ok(messages.filter(message => message.role === 'user').some(message => JSON.stringify(message.content).includes('+ synthetic guard')));
    if (turn === first) {
      const transcript = fs.readFileSync(session, 'utf8');
      assert.ok(transcript.includes(sentinel), 'the trusted checkout prompt must be present in native state for this test');
      env.HUD_RESUME_SESSION_ID = JSON.parse(transcript.split('\n')[0]).id;
    } else {
      assert.ok(raw.includes(followUp));
      assert.ok(raw.includes('Synthetic answer.'));
    }
  }
  console.log('Fresh and resumed provider input contains only advisor instructions and the selection conversation.');
} finally {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
