import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { renderStatuslineSession } from '../../src/render/statusline-session.js';
import { renderStatuslineDetails } from '../../src/render/statusline-details.js';
import { visualLength, truncateAnsi } from '../../src/render/colors.js';
import { statuslineCommand } from '../../src/cli/statusline.js';
import { statuslinePreview, statuslineWidth } from '../../src/statusline-preview.js';
import { handshakeFixture } from './b45-handshake-fixture.js';
import { HandshakeService } from '../../packages/hud-mcp/src/handshake.js';
import { insertRecord } from '../../src/ledger/records.js';
import { makeSourceId, sessionRefKey } from '../../src/core/identity.js';
import { readStatuslineSummary } from '../../src/core/statusline-summary.js';
import { renderStatuslineSummary } from '../../src/render/statusline-summary.js';
import { RelationStore } from '../../src/managed/relations.js';

// Synthetic main statusLine facts from the official documentation snapshot read 2026-11-06.
// This is not a tested client version or the separate subagentStatusLine protocol.
const base = {
  model: { display_name: 'Claude' },
  context_window: { used_percentage: 42 },
  cost: { total_cost_usd: 0.12 },
};
const full = {
  ...base,
  workspace: { current_dir: '/synthetic/project' },
  cwd: '/ignored/fallback',
  context_window: {
    used_percentage: 42,
    remaining_percentage: 58,
    total_input_tokens: 12000,
    total_output_tokens: 300,
    context_window_size: 200000,
    current_usage: { cache_read_input_tokens: 700, cache_creation_input_tokens: 800 },
  },
  cost: {
    total_cost_usd: 0.12,
    total_duration_ms: 12345,
    total_api_duration_ms: 6789,
    total_lines_added: 156,
    total_lines_removed: 23,
  },
};
const english = 'model Claude · ctx [####------] 42% · cost $0.12';
const chinese = '模型 Claude · 上下文 [####------] 42% · 费用 $0.12';
const fullEnglish = [
  english,
  'cwd /synthetic/project',
  'left 58%',
  'in 12000 tokens',
  'out 300 tokens',
  'window 200000 tokens',
  'cache read 700 tokens',
  'cache write 800 tokens',
  'session 12345 ms',
  'api 6789 ms',
  'lines +156 -23',
].join(' · ');
const fullChinese = [
  chinese,
  '目录 /synthetic/project',
  '剩余 58%',
  '输入 12000 词元',
  '输出 300 词元',
  '容量 200000 词元',
  '缓存读 700 词元',
  '缓存写 800 词元',
  '会话时长 12345 ms',
  'API时长 6789 ms',
  '改动 +156 -23',
].join(' · ');
const compactCases: Array<{ input: unknown; width: number; expected: string }> = [
  { input: base, width: 80, expected: 'Claude · ctx 42% · $0.12' },
  { input: {}, width: 80, expected: 'Claude' },
  { input: { model: { id: 'native-id' } }, width: 80, expected: 'native-id' },
  {
    input: { context_window: { used_percentage: 0 }, cost: { total_cost_usd: 0 } },
    width: 80,
    expected: 'Claude · ctx 0% · $0.00',
  },
  { input: { cost: { total_cost_usd: 0.0001 } }, width: 80, expected: 'Claude · $0.00010' },
  { input: base, width: 20, expected: 'Claude · ctx 42%' },
  { input: base, width: 10, expected: 'Claude' },
  { input: base, width: 1, expected: '…' },
  { input: { model: { display_name: '模型中文' } }, width: 5, expected: '模型…' },
  { input: { model: { display_name: 'a\n\x1b\u202e' } }, width: 80, expected: 'a\\n\\x1b\\u202e' },
];

test('compact API bytes are unchanged with omitted, empty, disabled or language-only options', () => {
  for (const { input, width, expected } of compactCases) {
    assert.equal(renderStatuslineSession(input, width), expected);
    for (const options of [
      {},
      { details: false },
      { language: 'zh' as const },
      { details: false, language: 'zh' as const },
    ])
      assert.equal(renderStatuslineSession(input, width, options), expected);
  }
});

test('native details dispatch, canonical labels, context bar and widths are exact', () => {
  assert.equal(renderStatuslineSession(base, 80, { details: true }), english);
  assert.equal(renderStatuslineSession(base, 80, { details: true, language: 'zh' }), chinese);
  for (const [width, expected] of [
    [1, '…'],
    [10, 'Claude'],
    [32, 'model Claude · ctx 42%'],
    [48, english],
    [80, english],
    [500, english],
  ] as const)
    assert.equal(renderStatuslineDetails(base, width, 'en'), expected);
  assert.equal(renderStatuslineDetails(full, 500, 'en'), fullEnglish);
  assert.equal(renderStatuslineDetails(full, 500, 'zh'), fullChinese);
  for (const [raw, bar, percent] of [
    [0, '----------', 0],
    [-0, '----------', 0],
    [9.49, '----------', 9],
    [9.5, '#---------', 10],
    [42.49, '####------', 42],
    [99.5, '##########', 100],
    [100, '##########', 100],
  ] as const)
    assert.equal(
      renderStatuslineDetails({ context_window: { used_percentage: raw } }, 80, 'en'),
      `model Claude · ctx [${bar}] ${percent}%`
    );
});

const sparse: Array<{ input: unknown; suffix: string }> = [
  { input: { workspace: { current_dir: '/synthetic' } }, suffix: 'cwd /synthetic' },
  { input: { cwd: '/fallback' }, suffix: 'cwd /fallback' },
  { input: { context_window: { remaining_percentage: 0 } }, suffix: 'left 0%' },
  { input: { context_window: { total_input_tokens: 0 } }, suffix: 'in 0 tokens' },
  { input: { context_window: { total_output_tokens: 0 } }, suffix: 'out 0 tokens' },
  { input: { context_window: { context_window_size: 1 } }, suffix: 'window 1 tokens' },
  { input: { context_window: { current_usage: { cache_read_input_tokens: 0 } } }, suffix: 'cache read 0 tokens' },
  { input: { context_window: { current_usage: { cache_creation_input_tokens: 0 } } }, suffix: 'cache write 0 tokens' },
  { input: { cost: { total_duration_ms: 0 } }, suffix: 'session 0 ms' },
  { input: { cost: { total_api_duration_ms: 0 } }, suffix: 'api 0 ms' },
  { input: { cost: { total_lines_added: 0 } }, suffix: 'lines +0' },
  { input: { cost: { total_lines_removed: 0 } }, suffix: 'lines -0' },
  { input: { cost: { total_lines_added: -0, total_lines_removed: -0 } }, suffix: 'lines +0 -0' },
  { input: { cost: { total_cost_usd: -0 } }, suffix: 'cost $0.00' },
  { input: { cost: { total_cost_usd: 0.0001 } }, suffix: 'cost $0.00010' },
];

test('each optional fact stands alone, including known zeros and independent line-change sides', () => {
  assert.equal(renderStatuslineDetails({}, 500, 'en'), 'model Claude');
  for (const { input, suffix } of sparse)
    assert.equal(renderStatuslineDetails(input, 500, 'en'), `model Claude · ${suffix}`);
  assert.equal(
    renderStatuslineDetails({ cost: { total_lines_added: null, total_lines_removed: 3 } }, 500, 'en'),
    'model Claude · lines -3'
  );
  assert.equal(
    renderStatuslineDetails({ workspace: { current_dir: '   ' }, cwd: ' fallback ' }, 500, 'en'),
    'model Claude · cwd fallback'
  );
});

test('native percentages are independent, never inferred or reconciled from tokens or remaining', () => {
  const counts = { total_input_tokens: Number.MAX_SAFE_INTEGER, context_window_size: 1 };
  assert.equal(
    renderStatuslineDetails({ context_window: { ...counts, remaining_percentage: 15.5 } }, 500, 'en'),
    'model Claude · left 16% · in 9007199254740991 tokens · window 1 tokens'
  );
  assert.equal(
    renderStatuslineDetails(
      { context_window: { ...counts, used_percentage: 42, remaining_percentage: 90 } },
      500,
      'en'
    ),
    'model Claude · ctx [####------] 42% · left 90% · in 9007199254740991 tokens · window 1 tokens'
  );
});

test('null, arrays, malformed containers and unknown fields never create native facts', () => {
  for (const bad of [null, [], 42, 'text', true, undefined]) {
    assert.equal(renderStatuslineDetails(bad, 500, 'en'), 'model Claude');
    assert.equal(
      renderStatuslineDetails({ model: bad, context_window: bad, cost: bad, workspace: bad }, 500, 'en'),
      'model Claude'
    );
    assert.equal(renderStatuslineDetails({ context_window: { current_usage: bad } }, 500, 'en'), 'model Claude');
  }
  assert.equal(
    renderStatuslineDetails(
      {
        model: { display_name: null, id: ' id-model ' },
        session_id: 'PRIVATE',
        agent_id: 'PRIVATE',
        transcript_path: '/PRIVATE',
        details: true,
        lang: 'zh',
        tools: ['PRIVATE'],
        tasks: ['PRIVATE'],
        session_name: 'PRIVATE',
        prompt_cache: { cache_read_input_tokens: 8 },
        context_window: { input_tokens: 4, remaining: 77, current_usage: { output_tokens: 10 } },
        cost: { total_cost: 5, duration: 9 },
        workspace: { project_dir: '/PRIVATE' },
      },
      500,
      'en'
    ),
    'model id-model'
  );
});

test('numeric validation rejects coercion, unsafe and fractional counts but accepts safe integer edges', () => {
  const invalid = [undefined, null, NaN, Infinity, -Infinity, -1, '42', {}, [], true, new Number(1)];
  for (const n of invalid) {
    assert.equal(
      renderStatuslineDetails(
        { context_window: { used_percentage: n, remaining_percentage: n }, cost: { total_cost_usd: n } },
        500,
        'en'
      ),
      'model Claude'
    );
  }
  for (const n of [...invalid, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      renderStatuslineDetails(
        {
          context_window: {
            total_input_tokens: n,
            total_output_tokens: n,
            context_window_size: n,
            current_usage: { cache_read_input_tokens: n, cache_creation_input_tokens: n },
          },
          cost: { total_duration_ms: n, total_api_duration_ms: n, total_lines_added: n, total_lines_removed: n },
        },
        500,
        'en'
      ),
      'model Claude'
    );
  }
  assert.equal(renderStatuslineDetails({ context_window: { context_window_size: 0 } }, 500, 'en'), 'model Claude');
  for (const n of [-0.01, 100.01, Number.MAX_VALUE])
    assert.equal(
      renderStatuslineDetails({ context_window: { used_percentage: n, remaining_percentage: n } }, 500, 'en'),
      'model Claude'
    );
  const maximum = Number.MAX_SAFE_INTEGER;
  assert.equal(
    renderStatuslineDetails(
      { context_window: { total_output_tokens: maximum }, cost: { total_duration_ms: maximum } },
      500,
      'en'
    ),
    'model Claude · out 9007199254740991 tokens · session 9007199254740991 ms'
  );
});

test('external text is bounded and escaped, with no split high surrogate at the raw bound', () => {
  const raw = ' \x1b]52;c;PRIVATE\x07\n\r\t\x00\x85\u202e\u2066\u061c\u200e\u200f\u2028\u2029end ';
  const escaped = '\\x1b]52;c;PRIVATE\\x07\\n\\r\\t\\x00\\x85\\u202e\\u2066\\u061c\\u200e\\u200f  end';
  assert.equal(
    renderStatuslineDetails({ model: { display_name: raw }, cwd: raw }, 500, 'en'),
    `model ${escaped} · cwd ${escaped}`
  );
  const bounded = '\u0301'.repeat(511) + '😀TRAIL';
  const line = renderStatuslineDetails({ model: { display_name: bounded } }, 500, 'en');
  assert.equal(line, 'model ' + '\u0301'.repeat(511));
  assert.doesNotMatch(line, /[\ud800-\udfff]/u);
  assert.equal(
    renderStatuslineDetails({ model: { display_name: ' '.repeat(512) + 'ignored', id: 'fallback' } }, 80, 'en'),
    'model fallback'
  );
  assert.equal(renderStatuslineDetails({ cwd: ' '.repeat(512) + 'not-read' }, 500, 'en'), 'model Claude');
  for (const bad of [null, [], {}, 1, true, new String('boxed'), '\u2028\u2029 '])
    assert.equal(
      renderStatuslineDetails({ model: { display_name: bad, id: bad }, cwd: bad }, 500, 'en'),
      'model Claude'
    );
});

test('all 1–500 widths in EN/ZH are deterministic, cell-bounded, single-line and terminal-safe', () => {
  const inputs = [
    {},
    base,
    full,
    { ...full, model: { display_name: '模型😀e\u0301中文' } },
    { ...full, model: { display_name: 'LONG'.repeat(300) }, cwd: '/long'.repeat(300) },
    { ...full, model: { display_name: '\x1b]52;x\x07\n\u202e\u061c\u200f' } },
  ];
  for (const language of ['en', 'zh'] as const)
    for (const input of inputs)
      for (let width = 1; width <= 500; width++) {
        const line = renderStatuslineDetails(input, width, language);
        assert.ok(line.length > 0);
        assert.ok(visualLength(line) <= width, `${language}/${width}: ${line}`);
        assert.equal(renderStatuslineDetails(input, width, language), line);
        assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/);
      }
});

test('rightmost optional facts are removed first, without backfill or early identity truncation', () => {
  const parts = fullEnglish.split(' · ');
  for (let count = parts.length; count >= 3; count--) {
    const expected = parts.slice(0, count).join(' · ');
    assert.equal(renderStatuslineDetails(full, visualLength(expected), 'en'), expected);
    if (count > 3)
      assert.equal(
        renderStatuslineDetails(full, visualLength(expected) - 1, 'en'),
        parts.slice(0, count - 1).join(' · ')
      );
  }
  assert.equal(renderStatuslineDetails(base, 35, 'en'), 'model Claude · ctx 42% · cost $0.12');
  assert.equal(renderStatuslineDetails(base, 20, 'en'), 'model Claude');
  assert.equal(
    renderStatuslineDetails(
      { model: { display_name: 'Identity' }, cwd: '/very-long-directory', cost: { total_lines_added: 0 } },
      30,
      'en'
    ),
    'model Identity'
  );
  const name = 'identity'.repeat(20);
  const input = { ...full, model: { display_name: name } };
  assert.equal(renderStatuslineDetails(input, 80, 'en'), truncateAnsi(name, 80));
  assert.equal(renderStatuslineDetails(input, visualLength('model ' + name), 'en'), 'model ' + name);
});

test('renderer width errors stay invalid_statusline_width; the stream width protocol is unchanged', () => {
  for (const width of [0, 501, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => renderStatuslineDetails(base, width, 'en'), /invalid_statusline_width/);
    assert.throws(() => renderStatuslineSession(base, width, { details: true }), /invalid_statusline_width/);
    assert.throws(() => renderStatuslineSession(base, width), /invalid_statusline_width/);
  }
  assert.equal(statuslineWidth(['--width', '48'], '10', 20), 48);
  assert.equal(statuslineWidth([], '32', 20), 32);
  assert.equal(statuslineWidth([], '08', 48), 48);
  assert.equal(statuslineWidth([], 'bad', 501), 80);
});

const bins = [[resolve('bin/hud-statusline')], [resolve('bin/hud'), 'statusline']];
function homeFixture(t: test.TestContext): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-native-details-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { HOME: home, HUD_HOME: home, COLUMNS: '80', NODE_NO_WARNINGS: '1' };
}
function run(argv: string[], args: string[], input: string | Buffer, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [...argv, ...args], { input, env, encoding: 'utf8', timeout: 10000 });
}

/** Product process with stdin deliberately left open: no fake parser, transport or provider. */
function openInput(
  argv: string[],
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: Buffer,
  endInput = false,
  closeOutput = false
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [...argv, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 10000);
    child.stdout.setEncoding('utf8').on('data', (text: string) => (stdout += text));
    child.stderr.setEncoding('utf8').on('data', (text: string) => (stderr += text));
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      if (timedOut) reject(new Error('owned product child did not exit within 10 seconds'));
      else resolveResult({ code, stdout, stderr });
    });
    if (closeOutput) child.stdout.destroy();
    if (endInput) child.stdin.end(input);
    else if (input) child.stdin.write(input);
  });
}

function snapshot(root: string) {
  const entries: Array<[string, string]> = [];
  const walk = (relative: string) => {
    const items = fs.readdirSync(join(root, relative), { withFileTypes: true });
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, item.name);
      if (item.isDirectory()) {
        entries.push([path, 'directory']);
        walk(path);
      } else {
        // Existing read-only SQLite locking can change SHM bytes, but must not create new files.
        const hash = path.endsWith('-shm')
          ? 'sqlite-shared-memory'
          : createHash('sha256')
              .update(fs.readFileSync(join(root, path)))
              .digest('hex');
        entries.push([path, hash]);
      }
    }
  };
  walk('');
  return entries;
}

test('both product bins preserve compact golden bytes and consume explicit details in either order', (t) => {
  const env = homeFixture(t);
  const before = snapshot(env.HOME!);
  for (const argv of bins) {
    for (const { input, width, expected } of compactCases) {
      const result = run(argv, ['--width', String(width)], JSON.stringify(input), env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected + '\n');
      assert.equal(result.stderr, '');
    }
    for (const [args, expected] of [
      [['--details'], english],
      [['--details', '--lang', 'en', '--width', '80'], english],
      [['--width', '80', '--lang', 'zh', '--details'], chinese],
      [['--source', env.HOME!, '--lang', 'zh', '--width', '80', '--details'], chinese],
      [['--lang', 'en', '--source', env.HOME!, '--details', '--width', '500'], english],
    ] as Array<[string[], string]>) {
      const result = run(argv, args, JSON.stringify(base), env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected + '\n');
      assert.equal(result.stderr, '');
    }
    for (const language of ['en', 'zh'] as const)
      for (const width of [1, 10, 32, 48, 80, 500]) {
        const result = run(
          argv,
          ['--details', '--lang', language, '--width', String(width)],
          JSON.stringify(full),
          env
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, renderStatuslineDetails(full, width, language) + '\n');
      }
  }
  assert.deepEqual(snapshot(env.HOME!), before);
});

test('both product bins reject invalid grammar before input and retain help/settings routing', async (t) => {
  const env = homeFixture(t);
  const invalid = [
    ['--details', '--details'],
    ['--details', 'true'],
    ['--details=true'],
    ['--detail'],
    ['--lang', 'en'],
    ['--details', '--lang'],
    ['--details', '--lang', 'EN'],
    ['--details', '--lang', 'zh-CN'],
    ['--details', '--lang', ''],
    ['--details', '--lang', '--width', '80'],
    ['--details', '--lang', 'en', '--lang', 'zh'],
    ['--details', '--lang=zh'],
    ['--details', '--help'],
    ['--help', '--lang', 'en'],
    ['--details', '--unknown'],
    ['--details', 'extra'],
    ['--details', '--source'],
    ['--details', '--source', '--lang', 'zh'],
    ['--details', '--source', env.HOME!, '--source', env.HOME!],
    ['--details', '--width'],
    ['--details', '--width', '--lang', 'zh'],
    ['--width', '--details'],
    ['--details', '--width', '80', '--width', '80'],
    ...['0', '501', '08', '2.5', '-1', 'NaN', 'Infinity', ''].map((n) => ['--details', '--width', n]),
  ];
  const before = snapshot(env.HOME!);
  for (const argv of bins) {
    for (const args of invalid) {
      const result = await openInput(argv, args, env);
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'invalid_arguments\n');
    }
    const help = await openInput(argv, ['--help'], env);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /--details.*--lang en\|zh/);
    assert.equal(help.stderr, '');
    const oldHelp = await openInput(argv, ['--source', env.HOME!, '--help'], env);
    assert.equal(oldHelp.code, 0, oldHelp.stderr);
    assert.match(oldHelp.stdout, /hud-statusline-preview/);
    assert.doesNotMatch(oldHelp.stdout, /--details/);
    for (const action of ['preview', 'apply', 'restore']) {
      const settings = await openInput(argv, ['settings', action, '--details'], env);
      assert.equal(settings.code, 2);
      assert.equal(settings.stdout, '');
      assert.equal(
        settings.stderr,
        'statusline_settings_failed: invalid input, changed settings, unsafe path, or unavailable build\n'
      );
    }
  }
  assert.deepEqual(snapshot(env.HOME!), before);
});

test('new grammar failures attach no stdin data listener to the real command', async () => {
  const listeners = process.stdin.listenerCount('data');
  let out = '',
    err = '';
  const code = await statuslineCommand(['--details', '--lang', 'PRIVATE'], {
    env: {},
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  });
  assert.equal(code, 2);
  assert.equal(process.stdin.listenerCount('data'), listeners);
  assert.equal(out, '');
  assert.equal(err, 'invalid_arguments\n');
});

test('actual product input bounds, UTF-8, JSON shape and stalled producer semantics remain unchanged', async (t) => {
  const env = homeFixture(t);
  for (const argv of bins) {
    const boundary = '{"pad":"' + 'x'.repeat(65536 - 10) + '"}';
    assert.equal(Buffer.byteLength(boundary), 65536);
    const good = run(argv, ['--details'], boundary, env);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout, 'model Claude\n');
    for (const [input, reason] of [
      [boundary + ' ', 'statusline_input_too_large'],
      [Buffer.from([0xff]), 'invalid_statusline_input'],
      ['[]', 'invalid_statusline_input'],
      ['null', 'invalid_statusline_input'],
      ['{}{}', 'invalid_statusline_input'],
      ['{"PRIVATE":', 'invalid_statusline_input'],
      ['', 'invalid_statusline_input'],
    ] as Array<[string | Buffer, string]>) {
      const bad = run(argv, ['--details'], input, env);
      assert.equal(bad.status, 3, bad.stderr);
      assert.equal(bad.stdout, '');
      assert.equal(bad.stderr, reason + '\n');
    }
    const overflow = run(
      argv,
      ['--details'],
      '{"context_window":{"used_percentage":1e309,"total_input_tokens":1e309},"cost":{"total_cost_usd":1e309}}',
      env
    );
    assert.equal(overflow.status, 0, overflow.stderr);
    assert.equal(overflow.stdout, 'model Claude\n');
    const stalled = await openInput(argv, ['--details'], env, Buffer.from('{"PRIVATE":'));
    assert.equal(stalled.code, 3, stalled.stderr);
    assert.equal(stalled.stdout, '');
    assert.equal(stalled.stderr, 'statusline_input_timeout\n');
    const oversizedOpen = await openInput(argv, ['--details'], env, Buffer.alloc(65537, 32));
    assert.equal(oversizedOpen.code, 3, oversizedOpen.stderr);
    assert.equal(oversizedOpen.stderr, 'statusline_input_too_large\n');
    assert.equal(oversizedOpen.stdout, '');
  }
  assert.deepEqual(snapshot(env.HOME!), []);
});

test('COLUMNS fallback, JSON presentation isolation and standalone preview stay compatible', (t) => {
  const env = homeFixture(t);
  for (const argv of bins) {
    for (const [columns, width] of [
      ['10', 10],
      ['08', 80],
      ['501', 80],
      ['bad', 80],
    ] as const) {
      const result = run(argv, ['--details'], JSON.stringify(base), { ...env, COLUMNS: columns });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, renderStatuslineDetails(base, width, 'en') + '\n');
    }
    const explicit = run(argv, ['--details', '--width', '48'], JSON.stringify(base), { ...env, COLUMNS: '1' });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(explicit.stdout, english + '\n');
    const jsonOptions = run(argv, [], JSON.stringify({ ...base, details: true, language: 'zh' }), env);
    assert.equal(jsonOptions.status, 0, jsonOptions.stderr);
    assert.equal(jsonOptions.stdout, 'Claude · ctx 42% · $0.12\n');
  }
  const preview = [resolve('bin/hud-statusline-preview')];
  const good = run(preview, [], JSON.stringify(full), env);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout, 'Claude · ctx 42% · $0.12\n');
  const bad = run(preview, ['--details'], JSON.stringify(base), env);
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr, 'invalid_arguments\n');
  assert.equal(bad.stdout, '');
});

test('both product bins report output failure after their stdout pipe is closed', async (t) => {
  const env = homeFixture(t);
  for (const argv of bins) {
    const result = await openInput(argv, ['--details'], env, Buffer.from(JSON.stringify(base)), true, true);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'statusline_output_failure\n');
  }
});

test('details output rejection retains exit 1 and generic private diagnostics at the stream seam', async () => {
  let attempts = 0,
    err = '';
  const code = await statuslinePreview([], Readable.from([JSON.stringify(base)]), {
    render: (input, width) => renderStatuslineSession(input, width, { details: true }),
    stdout: async () => {
      attempts++;
      throw new Error('PRIVATE');
    },
    stderr: (text) => {
      err += text;
    },
  });
  assert.equal(code, 1);
  assert.equal(attempts, 1);
  assert.equal(err, 'statusline_output_failure\n');
});

// Minimal ledger fixture from statusline-summary.test.ts. No projection is published: the
// existing "not loaded" marker is selected and has NO_CLOCK, so comparisons are age-free.
async function summaryFixture(t: test.TestContext) {
  const f = await handshakeFixture();
  t.after(() => f.close());
  await f.startup();
  const service = new HandshakeService({
    ledger: f.ledger,
    registration: f.child.registration,
    reader: f.reader,
    env: { HUD_CLAIM: f.claim },
    now: f.now,
  });
  await service.whoami({}, f.child.authority);
  const sourceRoot = join(f.root, 'synthetic-claude');
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  const parent = {
    harness: 'claude' as const,
    sourceId: makeSourceId('claude', sourceRoot),
    sessionId: 'synthetic-parent',
    threadId: null,
  };
  await f.ledger.transaction((tx) => {
    insertRecord(tx, 'sources', {
      sourceId: parent.sourceId,
      harness: 'claude',
      rootPath: sourceRoot,
      label: 'Synthetic',
    });
    tx.run(
      'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
      sessionRefKey(parent),
      parent.harness,
      parent.sourceId,
      parent.sessionId,
      ''
    );
    tx.run(
      'UPDATE links SET parent_ref=?,label=? WHERE link_id=?',
      sessionRefKey(parent),
      'Synthetic review',
      'link-a'
    );
  });
  // These are directories, not readable transcript/settings files. Rendering must not inspect them.
  const transcript = join(f.root, 'unreadable-transcript.jsonl');
  fs.mkdirSync(transcript, { mode: 0o700 });
  fs.mkdirSync(join(sourceRoot, 'settings.json'), { mode: 0o700 });
  const input = { ...full, session_id: parent.sessionId, transcript_path: transcript };
  const env = { HOME: f.root, HUD_HOME: f.root, CLAUDE_CONFIG_DIR: sourceRoot, NODE_NO_WARNINGS: '1' };
  return { ...f, sourceRoot, parent, input, env };
}

test('native EN/ZH preserves original summary identity, second-line bytes and read-only composition', async (t) => {
  const f = await summaryFixture(t);
  const summary = await readStatuslineSummary(f.input, f.env, undefined, { clock: () => 0 });
  assert.equal(summary.state, 'partial');
  assert.equal(summary.children.length, 1);
  assert.equal(summary.children[0].status, null);
  const second = renderStatuslineSummary(summary, 500, 1700000000000);
  assert.ok(second);
  assert.match(second, /partial.*Synthetic review.*not loaded/);
  assert.equal(renderStatuslineSummary(summary, 500, 1900000000000), second);
  const before = snapshot(f.root);
  for (const argv of bins) {
    for (const args of [[], ['--details'], ['--details', '--lang', 'zh']]) {
      const result = run(argv, [...args, '--width', '500'], JSON.stringify(f.input), f.env);
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.trimEnd().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(lines[1], second);
      assert.equal(
        lines[0],
        args.length ? (args.includes('zh') ? fullChinese : fullEnglish) : 'Claude · ctx 42% · $0.12'
      );
      assert.equal(result.stderr, '');
    }
    for (const input of [
      { ...f.input, agent_id: 'wrong-thread' },
      { ...f.input, session_id: 'wrong-session' },
    ]) {
      const rejected = run(argv, ['--details', '--width', '500'], JSON.stringify(input), f.env);
      assert.equal(rejected.status, 0, rejected.stderr);
      assert.equal(rejected.stdout, fullEnglish + '\n');
    }
    const noSource = { HOME: f.root, HUD_HOME: f.root, NODE_NO_WARNINGS: '1' };
    const missing = run(
      argv,
      ['--details', '--width', '500'],
      JSON.stringify({ ...f.input, cwd: f.sourceRoot, workspace: { current_dir: f.sourceRoot } }),
      noSource
    );
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.stdout.trimEnd().split('\n').length, 1, 'cwd/workspace do not select source identity');
    const explicit = run(
      argv,
      ['--lang', 'zh', '--source', f.sourceRoot, '--details', '--width', '500'],
      JSON.stringify(f.input),
      noSource
    );
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(explicit.stdout, fullChinese + '\n' + second + '\n');
    const wrongSource = run(argv, ['--details', '--source', f.root, '--width', '500'], JSON.stringify(f.input), f.env);
    assert.equal(wrongSource.status, 0, wrongSource.stderr);
    assert.equal(wrongSource.stdout, fullEnglish + '\n', 'explicit source still overrides env');
  }
  assert.deepEqual(
    snapshot(f.root),
    before,
    'same paths and persistent bytes; existing SQLite SHM lock bytes excluded'
  );
});

test('details integration preserves native calls, legacy summary, and explicit source isolation without starting a host', async (t) => {
  const f = await summaryFixture(t);
  new RelationStore(f.root).record({
    owner: f.parent,
    callId: 'synthetic-native-call',
    child: { harness: 'codex', threadId: 'synthetic-native-child' },
    workspace: f.root,
    profileId: 'codex-local',
    createdAt: 1,
  });
  const before = snapshot(f.root);
  const summary = renderStatuslineSummary(await readStatuslineSummary(f.input, f.env), 500, Date.now());
  for (const argv of bins) {
    for (const args of [[], ['--details'], ['--details', '--lang', 'zh']]) {
      const result = run(argv, [...args, '--width', '500'], JSON.stringify(f.input), f.env);
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.trimEnd().split('\n');
      assert.equal(lines.length, 3);
      assert.equal(
        lines[0],
        args.length ? (args.includes('zh') ? fullChinese : fullEnglish) : 'Claude · ctx 42% · $0.12'
      );
      assert.equal(lines[1], summary);
      assert.match(lines[2], /^Native calls: codex: .*native source unavailable/);
    }
    const wrongSource = run(argv, ['--details', '--source', f.root, '--width', '500'], JSON.stringify(f.input), f.env);
    assert.equal(wrongSource.status, 0, wrongSource.stderr);
    assert.equal(wrongSource.stdout, fullEnglish + '\n');
  }
  assert.equal(fs.existsSync(join(f.root, 'native-hosts')), false);
  assert.deepEqual(snapshot(f.root), before);
});

test('compact product and standalone preview close oversized open input without changing diagnostics', async (t) => {
  const env = homeFixture(t);
  for (const argv of [...bins, [resolve('bin/hud-statusline-preview')]]) {
    const result = await openInput(argv, [], env, Buffer.alloc(65537, 32));
    assert.equal(result.code, 3, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'statusline_input_too_large\n');
  }
});
