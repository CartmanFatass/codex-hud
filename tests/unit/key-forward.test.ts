import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbenchInputDecoder, type WorkbenchInput } from '../../src/utils/workbench-input.js';
import { forwardCalls, KeyForwarder, mergeForward, type TmuxCall } from '../../src/utils/key-forward.js';

const forwarding = () => new WorkbenchInputDecoder('monitor', { forward: true });
const raws = (inputs: WorkbenchInput[]) => inputs.map((i) => (i.type === 'key' ? i.raw : i.type));

test('every key keeps its exact bytes: letters, arrows, Ctrl, Alt, and a character split across reads', () => {
  const d = forwarding();
  assert.deepEqual(raws(d.push(Buffer.from('hello m a ,\r'))), [
    'h',
    'e',
    'l',
    'l',
    'o',
    ' ',
    'm',
    ' ',
    'a',
    ' ',
    ',',
    '\r',
  ]);
  assert.deepEqual(raws(d.push(Buffer.from('\x1b[A\x03\x1bx\x1b[15~'))), ['\x1b[A', '\x03', '\x1bx', '\x1b[15~']);
  const han = Buffer.from('汉');
  assert.deepEqual(d.push(han.subarray(0, 2)), []);
  assert.deepEqual(raws(d.push(han.subarray(2))), ['汉']);
  // The panel's names are still there for an overlay that needs them.
  assert.deepEqual(d.push(Buffer.from('j')), [{ type: 'key', key: 'down', raw: 'j' }]);
  // Focus reports are not keys.
  assert.deepEqual(d.push(Buffer.from('\x1b[I\x1b[O')), []);
  assert.deepEqual(d.push(Buffer.from('\x1b')), []);
  assert.deepEqual(d.flushEscape(), [{ type: 'key', key: 'escape', raw: '\x1b' }]);
});

test('a paste is kept whole, however it is split, and never becomes keys', () => {
  const d = forwarding();
  const body = 'line one\nb, m, q\n' + 'x'.repeat(5000);
  const all = Buffer.from(`\x1b[200~${body}\x1b[201~k`);
  const out: WorkbenchInput[] = [];
  for (let i = 0; i < all.length; i += 7) out.push(...d.push(all.subarray(i, i + 7)));
  assert.deepEqual(out, [
    { type: 'paste', text: body },
    { type: 'key', key: 'up', raw: 'k' },
  ]);
  // Without forwarding the body is still thrown away, as before.
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('\x1b[200~bmq\x1b[201~')), []);
});

test('one read is one send-keys in hex, a paste goes through a buffer, and the focus follows', () => {
  assert.deepEqual(
    mergeForward([
      { kind: 'keys', text: 'h' },
      { kind: 'keys', text: 'i' },
      { kind: 'paste', text: 'p' },
      { kind: 'keys', text: '' },
      { kind: 'keys', text: '\r' },
    ]),
    [
      { kind: 'keys', text: 'hi' },
      { kind: 'paste', text: 'p' },
      { kind: 'keys', text: '\r' },
    ]
  );
  const calls = forwardCalls('%3', [
    { kind: 'keys', text: 'hé' },
    { kind: 'paste', text: 'a\nb' },
  ]);
  assert.deepEqual(calls, [
    { args: ['send-keys', '-t', '%3', '-H', '68', 'c3', 'a9'] },
    {
      args: [
        'load-buffer',
        '-b',
        'codex-hud-fwd',
        '-',
        ';',
        'paste-buffer',
        '-p',
        '-r',
        '-d',
        '-b',
        'codex-hud-fwd',
        '-t',
        '%3',
        ';',
        'select-pane',
        '-t',
        '%3',
      ],
      input: 'a\nb',
    },
  ]);
  assert.deepEqual(forwardCalls('%3', []), []);
});

test('forwards run one at a time, in order, and survive a failed call', async () => {
  const seen: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const forwarder = new KeyForwarder(
    () => '%1',
    async (call: TmuxCall) => {
      const text = Buffer.from(call.args.slice(4, call.args.indexOf(';')).join(''), 'hex').toString();
      if (text === 'a') await gate;
      if (text === 'b') throw new Error('pane gone');
      seen.push(text);
    }
  );
  void forwarder.send([{ kind: 'keys', text: 'a' }]);
  void forwarder.send([{ kind: 'keys', text: 'b' }]);
  const last = forwarder.send([{ kind: 'keys', text: 'c' }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [], 'c waits for a');
  release();
  await last;
  assert.deepEqual(seen, ['a', 'c']);
  // No Codex pane, nothing sent.
  const none = new KeyForwarder(
    () => undefined,
    async () => assert.fail('no pane, no call')
  );
  await none.send([{ kind: 'keys', text: 'x' }]);
});
