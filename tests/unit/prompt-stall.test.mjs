import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promptBoundary, recoverStalledPrompt } from '../../dist/mcp/dispatch/prompt-stall.js';

const prompt = 'Read the synthetic brief.';
const user = JSON.stringify({ type: 'message', message: { role: 'user', content: prompt } }) + '\n';
function fixture(t, { agent, editor = prompt + '\n', wait = true, onWait, rebind, prior } = {}) {
  const task = fs.mkdtempSync(join(tmpdir(), 'prompt-stall-'));
  t.after(() => fs.rmSync(task, { recursive: true, force: true }));
  const root = join(task, 'sessions'); fs.mkdirSync(root);
  const file = join(task, 'store', 'bound.jsonl'); fs.mkdirSync(join(task, 'store'));
  fs.symlinkSync(file, join(root, 'bound.jsonl'));
  fs.writeFileSync(join(root, 'earlier.jsonl'), user); // Never scan other sessions for proof.
  if (prior) fs.writeFileSync(file, prior);
  const boundary = promptBoundary(task, file);
  const live = { name: 'synthetic', pane_id: 'pane', agent_status: 'idle', agent_session: { value: file }, ...agent };
  const calls = [];
  const herdr = async args => {
    calls.push(args);
    const [kind, op] = args;
    let stdout = '', ok = true;
    if (op === 'get') stdout = JSON.stringify({ result: { agent: { ...live, ...(calls.length > 1 && rebind) } } });
    else if (op === 'read') stdout = editor;
    else if (op === 'wait') { if (onWait) onWait(file); else if (wait) fs.appendFileSync(file, user); ok = wait; }
    else assert.deepEqual([kind, ...args.slice(1)], ['pane', 'send-keys', 'pane', 'Enter']);
    return { ok, stdout, stderr: '', reason: ok ? 'ok' : 'timeout' };
  };
  return { file, calls, run: () => recoverStalledPrompt(task, 'synthetic', 'pane', prompt, boundary, herdr),
    enters: () => calls.filter(a => a[1] === 'send-keys').length };
}

test('exact first prompt: one Enter and one bounded wait; never paste again', async t => {
  for (const editor of [prompt, prompt + '\n']) {
    const f = fixture(t, { editor }); await f.run();
    assert.equal(f.enters(), 1);
    assert.deepEqual(f.calls.filter(a => a[1] === 'wait'), [['agent','wait','synthetic','--until','working','--until','blocked','--until','done','--timeout','120000']]);
    assert.ok(!f.calls.some(a => a[1] === 'prompt'));
  }
});

test('already submitted through the exact job session link: no editor read, Enter or wait', async t => {
  const f = fixture(t); fs.writeFileSync(f.file, user);
  await f.run(); assert.deepEqual(f.calls, [['agent', 'get', 'synthetic']]);
});

test('not the bound idle editor or prompt is only a substring/history line: fail without sending keys', async t => {
  for (const opts of [{ agent: { name: 'other' } }, { agent: { pane_id: 'other' } }, { agent: { agent_status: 'working' } },
    { rebind: { pane_id: 'other' } }, { rebind: { agent_session: { value: '/different' } } }, { rebind: { agent_status: 'working' } },
    { editor: '' }, { editor: 'Read the synthetic\n brief.\n' }, { editor: `──────\nextra\n──────\n${prompt}\n──────\n` }, { editor: prompt + ' additional text' }, { editor: `old: ${prompt}\n──────\nsomething else\n──────\n` }]) {
    const f = fixture(t, opts); await assert.rejects(f.run(), /inspect with: herdr agent read/); assert.equal(f.enters(), 0);
  }
});

test('fast turn missed by wait succeeds only with this session’s message, and never retries Enter', async t => {
  for (const delivered of [false, true]) {
    const f = fixture(t, { wait: false, onWait: file => { if (delivered) fs.writeFileSync(file, user); } });
    if (delivered) await f.run(); else await assert.rejects(f.run(), /did not start after one Enter/);
    assert.equal(f.enters(), 1);
  }
});

test('a resumed transcript needs a matching appended turn, not an earlier user message', async t => {
  const f = fixture(t, { prior: user, wait: false });
  await assert.rejects(f.run(), /did not start after one Enter/); assert.equal(f.enters(), 1);
  const g = fixture(t, { prior: user, wait: false, onWait: file => fs.appendFileSync(file, user) });
  await g.run(); assert.equal(g.enters(), 1);
  const unconfirmed = fixture(t, { prior: user, wait: true, onWait: () => {} });
  await assert.rejects(unconfirmed.run(), /no matching new user message/); assert.equal(unconfirmed.enters(), 1);
  const h = fixture(t, { prior: user }); fs.appendFileSync(h.file, user.replace(prompt, 'other input'));
  await assert.rejects(h.run(), /different user input/); assert.equal(h.enters(), 0);
});

test('malformed bound transcript is not taken as empty', async t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{truncated');
  await assert.rejects(f.run(), /inspect with/); assert.equal(f.enters(), 0);
});
