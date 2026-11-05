import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderStatuslineSession } from '../../src/render/statusline-session.js';
import { visualLength } from '../../src/render/colors.js';
import { readStatuslineInput, statuslinePreview, statuslineWidth } from '../../src/statusline-preview.js';

const facts = {
  model: { display_name: 'Claude', id: 'unused-id' },
  context_window: { used_percentage: 42, total_input_tokens: 999999 },
  cost: { total_cost_usd: 0.12 },
};
test('stdin model, native context percent and cost are displayed without interpreting other fields', () => {
  assert.equal(renderStatuslineSession(facts), 'Claude · ctx 42% · $0.12');
  assert.equal(renderStatuslineSession({ model: { id: 'model-id' } }), 'model-id');
  assert.equal(renderStatuslineSession({ transcript_path: '/private', session_id: 'secret' }), 'Claude');
});
test('unknown and malformed values are omitted, while zero and tiny costs remain facts', () => {
  assert.equal(
    renderStatuslineSession({ context_window: { used_percentage: 0 }, cost: { total_cost_usd: 0 } }),
    'Claude · ctx 0% · $0.00'
  );
  for (const value of [null, -1, Infinity, NaN, '42', {}])
    assert.equal(
      renderStatuslineSession({ context_window: { used_percentage: value }, cost: { total_cost_usd: value } }),
      'Claude'
    );
  assert.equal(renderStatuslineSession({ context_window: { used_percentage: 101 } }), 'Claude');
  assert.equal(renderStatuslineSession({ cost: { total_cost_usd: 0.0001 } }), 'Claude · $0.00010');
});
test('narrow output drops cost and context before shortening identity', () => {
  assert.equal(renderStatuslineSession(facts, 20), 'Claude · ctx 42%');
  assert.equal(renderStatuslineSession(facts, 10), 'Claude');
  for (let width = 1; width <= 80; width++) {
    const line = renderStatuslineSession({ ...facts, model: { display_name: '模型中文 long model' } }, width);
    assert.ok(visualLength(line) <= width);
  }
});
test('terminal controls and bidi are escaped, never emitted as commands or extra lines', () => {
  const line = renderStatuslineSession({ model: { display_name: '\x1b]52;c;secret\x07\n\r\t\u202e\u2066\u2028evil' } });
  assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/);
  assert.match(line, /\\x1b/);
});
test('width precedence is explicit, COLUMNS, TTY, default; malformed widths never coerce', () => {
  assert.equal(statuslineWidth(['--width', '48'], '100', 120), 48);
  assert.equal(statuslineWidth([], '100', 120), 100);
  assert.equal(statuslineWidth([], 'bad', 120), 120);
  assert.equal(statuslineWidth([], '0', 501), 80);
  for (const args of [['--width', '0'], ['--width', '501'], ['--width', '4.8'], ['--width', '08'], ['extra']])
    assert.throws(() => statuslineWidth(args), /invalid_arguments/);
});
test('input accepts chunked UTF-8 JSON but rejects invalid UTF-8, arrays, trailing objects and large input', async () => {
  const bytes = Buffer.from('{"model":{"display_name":"中文"}}');
  assert.deepEqual(await readStatuslineInput(Readable.from([bytes.subarray(0, 28), bytes.subarray(28)])), {
    model: { display_name: '中文' },
  });
  for (const input of ['', '[]', 'null', '{}{}', '{"secret":', Buffer.from([0xff])])
    await assert.rejects(readStatuslineInput(Readable.from([input])), /invalid_statusline_input/);
  await assert.rejects(readStatuslineInput(Readable.from([' '.repeat(65537)])), /statusline_input_too_large/);
});
test('input deadline and premature close stop a stalled producer', async () => {
  const stalled = new PassThrough();
  await assert.rejects(readStatuslineInput(stalled, 10), /statusline_input_timeout/);
  assert.equal(stalled.listenerCount('data'), 0);
  stalled.destroy();
  const closed = new PassThrough();
  const result = readStatuslineInput(closed);
  closed.destroy();
  await assert.rejects(result, /statusline_input_unavailable/);
});
test('argument/input failures leave stdout empty and never include private input in diagnostics', async () => {
  for (const [args, input, code] of [
    [['bad'], '{}', 2],
    [[], '{PRIVATE', 3],
  ] as const) {
    let out = '',
      err = '';
    assert.equal(
      await statuslinePreview(args, Readable.from([input]), {
        stdout: (v) => {
          out += v;
        },
        stderr: (v) => {
          err += v;
        },
      }),
      code
    );
    assert.equal(out, '');
    assert.doesNotMatch(err, /PRIVATE/);
  }
});
test('help does not consume input, and an output rejection is reported once', async () => {
  const input = new PassThrough();
  let out = '',
    err = '';
  assert.equal(
    await statuslinePreview(['--help'], input, {
      stdout: (v) => {
        out += v;
      },
      stderr: (v) => {
        err += v;
      },
    }),
    0
  );
  assert.match(out, /stdin/);
  assert.equal(input.listenerCount('data'), 0);
  input.destroy();
  let attempts = 0;
  assert.equal(
    await statuslinePreview([], Readable.from(['{}']), {
      stdout: () => {
        attempts++;
        throw new Error('PRIVATE');
      },
      stderr: (v) => {
        err += v;
      },
    }),
    1
  );
  assert.equal(attempts, 1);
  assert.equal(err, 'statusline_output_failure\n');
});
test('built standalone command renders with isolated HOME and creates no files', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hud-statusline-preview-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = resolve('bin/hud-statusline-preview');
  const env = { ...process.env, HOME: home, HUD_HOME: home, COLUMNS: '80' };
  const result = spawnSync(process.execPath, [bin], {
    input: JSON.stringify(facts),
    encoding: 'utf8',
    env,
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Claude · ctx 42% · $0.12\n');
  assert.deepEqual(readdirSync(home), []);
  const invalid = spawnSync(process.execPath, [bin], { input: 'PRIVATE', encoding: 'utf8', env, timeout: 5000 });
  assert.equal(invalid.status, 3);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'invalid_statusline_input\n');
});
