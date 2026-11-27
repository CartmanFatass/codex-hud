// Run with the temporary-HOME wrapper and Claude Code on PATH. No real provider is called.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { cleanupFixture } from '../helpers/process-cleanup.mjs';
import { waitUntilFs } from '../../dist/utils/fs-wait.js';

const run = promisify(execFile);
const moduleUrl = new URL('../../dist/roles/selection-advisor.js', import.meta.url).href;
const answers = ['Synthetic first answer.', 'Synthetic follow-up answer.'];
const blocks = message => typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
const userText = body => body.messages.filter(m => m.role === 'user').flatMap(blocks).filter(b => b.type === 'text').map(b => b.text);

function reply(res, body, index) {
  const tool = body.tools?.find(tool => tool.name === 'mcp__hud__hud_report');
  const turn = userText(body).join('\n').match(/turn: (\S+)/g)?.at(-1)?.slice('turn: '.length);
  const alreadyReported = body.messages.some(m => m.role === 'assistant' && blocks(m).some(b => b.id === `toolu_fixture_${index}`));
  const report = tool && turn && !alreadyReported;
  const message = { type: 'message', id: `msg_fixture_${index}`, role: 'assistant', model: body.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } };
  const block = report ? { type: 'tool_use', id: `toolu_fixture_${index}`, name: tool.name, input: {} }
    : { type: 'text', text: '' };
  const delta = report ? { type: 'input_json_delta', partial_json: JSON.stringify({ text: answers[index], turn }) }
    : { type: 'text_delta', text: 'Done.' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [type, fields] of [
    ['message_start', { message }], ['content_block_start', { index: 0, content_block: block }],
    ['content_block_delta', { index: 0, delta }], ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: report ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }],
    ['message_stop', {}],
  ]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  res.end();
}

test('Claude selection advisor keeps mentions literal and omits project memory across native turns', { timeout: 45000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-claude-advisor-probe-')));
  const home = join(root, 'home'), hud = join(root, 'hud'), cwd = join(root, 'checkout'), config = join(root, 'claude');
  cleanupFixture(t, { root, hudHome: hud });
  const sentinel = 'SYNTHETIC_UNSELECTED_CONTENT_MUST_NOT_TRAVEL';
  const instructions = 'SYNTHETIC_PROJECT_INSTRUCTIONS_MUST_NOT_TRAVEL';
  const memory = 'SYNTHETIC_PROJECT_MEMORY_MUST_NOT_TRAVEL';
  const memoryDir = join(config, 'projects', cwd.replace(/[^a-zA-Z0-9_-]/g, '-'), 'memory');
  const relative = join(cwd, 'NOTES.md'), absolute = join(cwd, 'absolute-link.md'), homeFile = join(home, 'home-note.md');
  for (const dir of [home, hud, cwd, config]) fs.mkdirSync(dir);
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(join(memoryDir, 'MEMORY.md'), `${memory}\n`);
  fs.writeFileSync(join(cwd, 'CLAUDE.md'), `${instructions}\n`);
  fs.writeFileSync(relative, sentinel);
  fs.symlinkSync(relative, absolute); // The owner-supplied absolute spelling is not the resolved file path.
  fs.writeFileSync(homeFile, sentinel);
  fs.writeFileSync(join(config, '.claude.json'), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  fs.writeFileSync(join(hud, 'hud-settings.json'), JSON.stringify({ autoPrewalk: false }));

  const excerpt = `Excerpt: @NOTES.md @${absolute}`;
  const question = `Question about @~/home-note.md and @"${absolute}"?`;
  const followUp = `Follow-up: @NOTES.md @${absolute} @~/home-note.md`;
  const requests = [[], []];
  let index = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404).end('{}'); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests[index].push(body);
    reply(res, body, index);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { PATH: process.env.PATH, HOME: home, HUD_HOME: hud, CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'synthetic',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', // The owner may have explicitly enabled auto-memory.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_PROXY: '127.0.0.1',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' };
  const dispatch = async code => {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', code], { cwd, env, timeout: 10000 });
    return JSON.parse(stdout);
  };
  const initial = await dispatch(`import { startSelectionAdvisor } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await startSelectionAdvisor(process.env.HUD_HOME, ${JSON.stringify({ excerpt, question,
      source: { project: 'checkout', projectRoot: cwd, pane: 'w1:p1', job: null, role: null, time: new Date(0).toISOString() } })}, process.env)));`);
  assert.ok(initial.advisor, JSON.stringify(initial));
  const { id, target } = initial.advisor;
  const dir = join(hud, 'jobs', target), read = file => JSON.parse(fs.readFileSync(join(dir, file), 'utf8'));
  assert.equal(read('job.json').cli.agent, 'claude');
  async function closed(turnNumber) {
    const status = await waitUntilFs({ targets: [{ dir }], timeoutMs: 15000, signal: t.signal, check: ({ timedOut }) => {
      const status = read('STATUS.json');
      const closed = status.state === 'closed' && fs.readFileSync(join(dir, 'report.md'), 'utf8') === answers[turnNumber];
      return closed || status.state === 'failed' || timedOut ? { done: true, value: status } : { done: false };
    } });
    assert.equal(status?.state, 'closed', JSON.stringify(status) + '\n' + fs.readFileSync(join(dir, 'stderr.log'), 'utf8'));
    assert.equal(fs.readFileSync(join(dir, 'report.md'), 'utf8'), answers[turnNumber]);
    return status.agent_session_id;
  }
  const idBefore = await closed(index);
  index++;
  assert.equal(await dispatch(`import { continueSelectionAdvisor } from ${JSON.stringify(moduleUrl)};
    console.log(await continueSelectionAdvisor(process.env.HUD_HOME, ${JSON.stringify(id)}, ${JSON.stringify(followUp)}));`), true);
  assert.ok(idBefore);
  assert.equal(await closed(index), idBefore);

  for (const [turn, bodies] of requests.entries()) {
    assert.ok(bodies.length > 0, `no provider request for turn ${turn}`);
    for (const body of bodies) {
      const raw = JSON.stringify(body), visible = userText(body).join('\n').replaceAll('\uFEFF', '');
      assert.ok(visible.includes(excerpt) && visible.includes(question), 'the owner-supplied first turn must arrive visibly intact');
      if (turn) assert.ok(visible.includes(followUp), 'the owner-supplied follow-up must arrive visibly intact');
      assert.ok(!raw.includes(sentinel) && !raw.includes(relative) && !raw.includes(homeFile),
        'file contents or a resolved path reached the provider');
      assert.ok(!raw.includes(memory) && !raw.includes(memoryDir), 'project memory reached the provider');
      assert.ok(!raw.includes(instructions) && !raw.includes(join(cwd, 'CLAUDE.md')), 'project instructions reached the provider');
      assert.ok(!raw.includes('Called the Read tool') && !raw.includes('File contents are not attached automatically'),
        'a mention produced an extra native attachment');
      assert.equal(raw.split(absolute).length - 1, turn ? 3 : 2, 'the absolute spelling must appear only in the owner prompt');
      // Claude may pad the tool list with an internal deferred-tools placeholder.
      assert.deepEqual(body.tools.map(tool => tool.name).filter(name => name !== 'DeferredToolPlaceholder'), ['mcp__hud__hud_report']);
    }
  }
  const receipts = requests.flat().flatMap(body => body.messages.flatMap(blocks))
    .filter(block => block.type === 'tool_result');
  assert.ok(receipts.length > 0, 'provider must see the report receipt');
  for (const receipt of receipts) {
    const text = typeof receipt.content === 'string' ? receipt.content : receipt.content[0].text;
    assert.deepEqual(JSON.parse(text), { ok: true });
  }
});
