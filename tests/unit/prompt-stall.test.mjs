import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoverStalledPrompt } from '../../dist/mcp/dispatch/prompt-stall.js';

const prompt = 'Read the synthetic brief.';
const user = JSON.stringify({ type: 'message', message: { role: 'user', content: prompt } }) + '\n';
function fixture(t, { agent, editor = prompt + '\n', wait = true, onWait, rebind } = {}) {
  const task = fs.mkdtempSync(join(tmpdir(), 'prompt-stall-'));
  t.after(() => fs.rmSync(task, { recursive: true, force: true }));
  const root = join(task, 'sessions'); fs.mkdirSync(root);
  const file = join(task, 'store', 'bound.jsonl'); fs.mkdirSync(join(task, 'store'));
  fs.symlinkSync(file, join(root, 'bound.jsonl'));
  fs.writeFileSync(join(root, 'earlier.jsonl'), user); // Never scan other sessions for proof.
  const live = { name: 'synthetic', pane_id: 'pane', agent_status: 'idle', agent_session: { value: file }, ...agent };
  const calls = [];
  const herdr = async args => {
    calls.push(args);
    const [kind, op] = args;
    let stdout = '', ok = true;
    if (op === 'get') stdout = JSON.stringify({ result: { agent: { ...live, ...(calls.length > 1 && rebind) } } });
    else if (op === 'read') stdout = editor;
    else if (op === 'wait') { onWait?.(file); ok = wait; }
    else assert.deepEqual([kind, ...args.slice(1)], ['pane', 'send-keys', 'pane', 'Enter']);
    return { ok, stdout, stderr: '', reason: ok ? 'ok' : 'timeout' };
  };
  return { file, calls, run: () => recoverStalledPrompt(task, 'synthetic', 'pane', prompt, herdr),
    enters: () => calls.filter(a => a[1] === 'send-keys').length };
}

test('exact first prompt, including a soft wrap: one Enter and one bounded wait; never paste again', async t => {
  for (const editor of [prompt + '\n', 'Read the synthetic\n brief.\n', `earlier output\n──────\n${prompt}\n──────\nfooter\n`]) {
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
    { editor: '' }, { editor: prompt + ' additional text' }, { editor: `old: ${prompt}\n──────\nsomething else\n──────\n` }]) {
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

test('malformed bound transcript is not taken as empty', async t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{truncated');
  await assert.rejects(f.run(), /inspect with/); assert.equal(f.enters(), 0);
});
