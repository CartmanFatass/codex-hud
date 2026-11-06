import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { ledgerRuntimeSupported } from '../../dist/ledger/runtime.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  LIMITS,
  parseArgs,
  isolatedEnvironment,
  runChild,
  statistics,
  aggregate,
  createFixture,
  validateResult,
  observe,
  writeReport,
} from '../../scripts/observe-statusline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin/hud-statusline');
const SCRIPT = path.join(ROOT, 'scripts/observe-statusline.mjs');
const scriptUrl = new URL('../../scripts/observe-statusline.mjs', import.meta.url).href;
const productSkip =
  process.platform !== 'linux'
    ? 'Observer product scope requires Linux'
    : !ledgerRuntimeSupported()
      ? 'Observer ledger requires Node 22.x >=22.13 or Node >=24'
      : false;
const linuxSkip = process.platform !== 'linux' ? 'Owned /proc fixture requires Linux' : false;
const posixSkip = process.platform === 'win32' ? 'POSIX TERM/KILL semantics required' : false;
const valid = {
  spawned: true,
  directChildExited: true,
  closeObserved: true,
  exitCode: 0,
  signal: null,
  reason: null,
  cleanupUncertain: false,
  stdout: 'Synthetic Claude · ctx 42% · $0.12\n',
  stderr: '',
};
function mockChild(action) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.unref = () => {};
  process.nextTick(() => action(child));
  return child;
}
const hash = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('strict opt-in arguments and inert import/help cannot start a run', () => {
  assert.deepEqual(parseArgs(['--synthetic']), { samples: 20 });
  for (const n of ['1', '20', '100']) assert.equal(parseArgs(['--synthetic', '--samples', n]).samples, Number(n));
  for (const args of [
    [],
    ['--samples', '1'],
    ['--synthetic', '--samples', '0'],
    ['--synthetic', '--samples', '101'],
    ['--synthetic', '--samples', '01'],
    ['--synthetic', '--samples', '1.0'],
    ['--synthetic', '--source', '/synthetic'],
    ['--synthetic', '--live'],
    ['--synthetic', '--samples', 'Infinity'],
    ['--help', '--synthetic'],
  ])
    assert.throws(() => parseArgs(args));
  const env = { LANG: 'C.UTF-8' };
  const imported = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(new URL('../../scripts/observe-statusline.mjs', import.meta.url).href)})`,
    ],
    { env, encoding: 'utf8' }
  );
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--synthetic/);
  const bad = spawnSync(process.execPath, [SCRIPT, '--synthetic', '--samples', '0'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
});

test('nearest-rank statistics include only valid successful observations and preserve failure receipts', () => {
  assert.deepEqual(statistics([]), { n: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
  const rows = [100, 150, 150, 200].map((elapsedMs) => ({ ...valid, elapsedMs, status: 'PASS' }));
  assert.deepEqual(statistics(rows), { n: 4, p50Ms: 150, p95Ms: 200, p99Ms: 200, maxMs: 200 });
  const row = { ...valid, elapsedMs: 150, status: 'PASS' };
  assert.equal(aggregate('synthetic', 1, [row]).advisoryP95AtMost150Ms, 'PASS');
  assert.equal(aggregate('synthetic', 1, [{ ...row, elapsedMs: 150.001 }]).advisoryP95AtMost150Ms, 'FAIL');
  assert.equal(aggregate('synthetic', 2, [row]).advisoryP95AtMost150Ms, 'NOT_RUN');
  assert.equal(aggregate('synthetic', 1, [{ ...row, status: 'FAIL' }]).advisoryP95AtMost150Ms, 'NOT_RUN');
  assert.equal(statistics([{ ...row, status: 'FAIL' }]).n, 0);
  const attempts = [
    { ...row, elapsedMs: 10 },
    { ...row, elapsedMs: 2000, reason: 'timeout', status: 'FAIL' },
    { ...row, elapsedMs: 3, spawned: false, directChildExited: false, reason: 'spawn_error', status: 'FAIL' },
    { ...row, elapsedMs: 4, status: 'FAIL' },
    { ...row, elapsedMs: 3000, closeObserved: false, cleanupUncertain: true, status: 'FAIL' },
  ];
  const report = aggregate('synthetic', 6, attempts);
  assert.deepEqual(report.latency, { n: 1, p50Ms: 10, p95Ms: 10, p99Ms: 10, maxMs: 10 });
  assert.equal(report.completed, 1);
  assert.equal(report.failed, 4);
  assert.equal(report.censored, 1);
  assert.equal(report.notAttempted, 1);
  assert.equal(report.uncompleted, 5);
  assert.deepEqual(report.attempts, attempts);
  assert.equal(report.advisoryP95AtMost150Ms, 'NOT_RUN');
  assert.equal(statistics([{ ...row, closeObserved: false }]).n, 0);
});

test(
  'actual product five populations and three controls produce a private aggregate-only receipt',
  { skip: productSkip },
  async () => {
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--private-marker-do-not-inherit';
    let report;
    try {
      report = await observe({ samples: 1 });
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
    assert.equal(report.status, 'PASS');
    assert.equal(report.scenarios.length, 8);
    assert.equal(report.cleanup, 'removed_after_confirmed_close');
    assert.equal(
      report.scenarios.reduce((sum, s) => sum + s.attempted, 0),
      8
    );
    for (const s of report.scenarios) {
      assert.equal(s.status, 'PASS', s.name);
      assert.equal(s.attempts[0].closeObserved, true);
    }
    for (const value of Object.values(report.qualifications)) assert.equal(value, 'NOT_RUN');
    const text = JSON.stringify(report);
    assert.doesNotMatch(
      text,
      /private-marker|Synthetic Claude|synthetic-parent|synthetic-child|\/workspace\/|\/tmp\/|"stdout"|"stderr"|HOME|NODE_OPTIONS/
    );
    assert.match(report.sourceSha, /^[a-f0-9]{40}$/);
  }
);

test(
  'fixture uses actual private ledger and rendering changes no durable contents/settings/transcript',
  { skip: productSkip },
  async () => {
    const f = await createFixture();
    try {
      const env = isolatedEnvironment(f.directory, true);
      assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CONFIG_DIR', 'COLUMNS', 'HOME', 'HUD_HOME', 'LANG']);
      fs.mkdirSync(path.join(env.HOME, '.claude'), { mode: 0o700 });
      const settings = path.join(env.HOME, '.claude', 'settings.json');
      const transcript = path.join(f.directory, 'do-not-read.jsonl');
      fs.writeFileSync(settings, 'PRIVATE_MARKER_SETTINGS', { mode: 0o600 });
      fs.writeFileSync(transcript, 'PRIVATE_MARKER_TRANSCRIPT', { mode: 0o600 });
      f.refresh(0);
      const cache = path.join(env.HUD_HOME, 'delegation-summaries-v1');
      const summary = path.join(cache, fs.readdirSync(cache)[0]);
      const files = [settings, transcript, summary, path.join(env.HUD_HOME, 'ledger.sqlite')];
      const before = files.map(hash);
      const result = await runChild({
        args: [BIN],
        input: JSON.stringify({
          model: { display_name: 'Synthetic Claude' },
          context_window: { used_percentage: 42 },
          cost: { total_cost_usd: 0.12 },
          session_id: 'synthetic-parent',
          transcript_path: transcript,
        }),
        env,
        cwd: f.directory,
      });
      assert.equal(validateResult('fresh-summary', result), true);
      assert.deepEqual(files.map(hash), before);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_MARKER/);
    } finally {
      f.cleanup();
    }
  }
);

test('empty, incorrect, extra-line and oversized output cannot pass correctness', async () => {
  for (const stdout of ['', 'wrong\n', valid.stdout + 'unexpected\n'])
    assert.equal(validateResult('stdin-normal', { ...valid, stdout }), false);
  assert.equal(validateResult('stdin-normal', { ...valid, stderr: 'private marker' }), false);
  assert.equal(
    validateResult('malformed-json', { ...valid, exitCode: 3, stdout: '', stderr: 'invalid_statusline_input\n' }),
    true
  );
  const r = await runChild({ args: [], input: '{}', env: {}, cwd: ROOT }, () =>
    mockChild((c) => {
      c.emit('spawn');
      c.stdout.write('x'.repeat(LIMITS.outputBytes + 1));
      c.emit('exit', 0, null);
      c.emit('close', 0, null);
    })
  );
  assert.equal(r.reason, 'output_limit');
  assert.equal(r.stdout.length, LIMITS.outputBytes);
  assert.equal(r.stdoutBytes, LIMITS.outputBytes + 1);
  assert.equal(validateResult('stdin-normal', r), false);
});

test('spawn failures are explicit and do not masquerade as closed successful children', async () => {
  const r = await runChild({ args: [], input: '{}', env: {}, cwd: ROOT }, () => {
    throw Error('PRIVATE_MARKER');
  });
  assert.equal(r.reason, 'spawn_error');
  assert.equal(r.spawned, false);
  assert.equal(r.closeObserved, false);
  assert.equal(r.cleanupUncertain, false);
  const asynchronous = await runChild({ args: [], input: '{}', env: {}, cwd: ROOT }, () =>
    mockChild((c) => {
      c.emit('error', Error('PRIVATE_MARKER'));
      c.emit('close', -2, null);
    })
  );
  assert.equal(asynchronous.reason, 'spawn_error');
  assert.equal(asynchronous.spawned, false);
});

for (const ignoreTerm of [false, true])
  test(`owned real hanging child timeout and TERM escalation (ignore=${ignoreTerm})`, { skip: posixSkip }, async () => {
    const r = await runChild(
      { args: [], input: '{}', env: { LANG: 'C.UTF-8' }, cwd: ROOT, timeoutMs: 200 },
      (exe, _args, options) =>
        spawn(
          exe,
          ['-e', `${ignoreTerm ? 'process.on("SIGTERM",()=>{});' : ''}process.stdin.resume();setInterval(()=>{},1000)`],
          options
        )
    );
    assert.equal(r.reason, 'timeout');
    assert.equal(r.directChildExited, true);
    assert.equal(r.closeObserved, true);
    assert.equal(r.cleanupUncertain, false);
    assert.equal(r.signal, ignoreTerm ? 'SIGKILL' : 'SIGTERM');
  });

test(
  'real exit with descendant-held pipes is uncertain, bounded and never signalled after exit',
  { skip: linuxSkip },
  async () => {
    let child,
      kills = 0,
      ownership;
    const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:['ignore',1,2],detached:true});const stat=fs.readFileSync('/proc/'+c.pid+'/stat','utf8');console.log(JSON.stringify({pid:c.pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));c.unref();`;
    try {
      const r = await runChild({ args: [], input: '{}', env: {}, cwd: ROOT, timeoutMs: 300 }, (exe, _args, options) => {
        child = spawn(exe, ['-e', code], options);
        const kill = child.kill.bind(child);
        child.kill = (...args) => {
          kills++;
          return kill(...args);
        };
        return child;
      });
      ownership = JSON.parse(r.stdout);
      assert.equal(r.directChildExited, true);
      assert.equal(r.closeObserved, false);
      assert.equal(r.cleanupUncertain, true);
      assert.equal(r.reason, 'timeout');
      assert.equal(kills, 0);
      assert.ok(r.elapsedMs < 3000);
    } finally {
      if (ownership && fs.existsSync(`/proc/${ownership.pid}/stat`)) {
        const stat = fs.readFileSync(`/proc/${ownership.pid}/stat`, 'utf8');
        assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], ownership.start);
        process.kill(ownership.pid, 'SIGKILL');
      }
    }
  }
);

test(
  'uncertainty stops all later samples, retains owned fixtures, and report strips payloads',
  { skip: productSkip },
  async () => {
    let calls = 0,
      directory;
    const report = await observe({ samples: 2 }, (_exe, _args, options) => {
      calls++;
      directory = options.cwd;
      return mockChild((c) => {
        c.emit('spawn');
        c.stdout.write('PRIVATE_MARKER');
        c.emit('exit', 0, null);
      });
    });
    try {
      assert.equal(calls, 1);
      assert.equal(report.status, 'FAIL');
      assert.equal(report.stopReason, 'cleanup_uncertain');
      assert.equal(report.cleanup, 'retained_uncertain');
      assert.equal(report.scenarios[0].attempts[0].cleanupUncertain, true);
      assert.equal(report.scenarios[0].advisoryP95AtMost150Ms, 'NOT_RUN');
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE_MARKER/);
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  }
);

test('interruption starts no later sample and closes the owned direct child', { skip: productSkip }, async () => {
  const controller = new AbortController();
  let calls = 0;
  const report = await observe({ samples: 2, signal: controller.signal }, () => {
    calls++;
    return mockChild((c) => {
      c.kill = () => {
        c.emit('exit', null, 'SIGTERM');
        c.emit('close', null, 'SIGTERM');
        return true;
      };
      c.emit('spawn');
      controller.abort();
    });
  });
  assert.equal(calls, 1);
  assert.equal(report.stopReason, 'interrupted');
  assert.equal(report.status, 'FAIL');
  assert.equal(report.cleanup, 'removed_after_confirmed_close');
});

test('portable report error, EPIPE and stalled writes fail without payload diagnostics', async () => {
  await assert.rejects(
    writeReport(
      'PRIVATE_MARKER',
      new Writable({
        write(_data, _encoding, callback) {
          callback(Object.assign(Error('PRIVATE_MARKER'), { code: 'EPIPE' }));
        },
      })
    ),
    /report_failed/
  );
  await assert.rejects(writeReport('PRIVATE_MARKER', new Writable({ write() {} })), /report_failed/);
});

test('real product CLI EPIPE reports failure after a supported observation', { skip: productSkip }, async () => {
  const child = spawn(process.execPath, [SCRIPT, '--synthetic', '--samples', '1'], {
    cwd: ROOT,
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c;
  });
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /statusline_observation_report_failed/);
  assert.doesNotMatch(stderr, /PRIVATE_MARKER|\/workspace/);
});

test('unsupported runtime/platform refuses with prerequisite exit 2 before fixture setup', () => {
  for (const override of [
    "Object.defineProperty(process.versions, 'node', { value: '18.20.0' });",
    "Object.defineProperty(process.versions, 'node', { value: '20.19.0' });",
    "Object.defineProperty(process.versions, 'node', { value: '22.12.0' });",
    "Object.defineProperty(process.versions, 'node', { value: '23.0.0' });",
    "Object.defineProperty(process, 'platform', { value: 'win32' });",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `${override} const {main}=await import(${JSON.stringify(scriptUrl)});process.exitCode=await main(['--synthetic','--samples','1']);`,
      ],
      { env: {}, encoding: 'utf8' }
    );
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^statusline_observation_prerequisite_failed:/);
    assert.doesNotMatch(result.stderr, /\/workspace|PRIVATE_MARKER/);
  }
  if (productSkip) {
    const actual = spawnSync(process.execPath, [SCRIPT, '--synthetic', '--samples', '1'], {
      env: {},
      encoding: 'utf8',
    });
    assert.equal(actual.status, 2);
    assert.equal(actual.stdout, '');
    assert.match(actual.stderr, /^statusline_observation_prerequisite_failed:/);
  }
});

test(
  'fixture error after a successful sample keeps every attempt and all remaining populations',
  { skip: productSkip },
  async (t) => {
    const original = fsDefault.writeFileSync;
    let refreshes = 0,
      calls = 0;
    const mocked = t.mock.method(fsDefault, 'writeFileSync', function (file, ...args) {
      if (String(file).includes('delegation-summaries-v1') && ++refreshes === 2) throw Error('PRIVATE_MARKER_FIXTURE');
      return original.call(this, file, ...args);
    });
    syncBuiltinESMExports();
    let report;
    try {
      report = await observe({ samples: 2 }, (...args) => {
        calls++;
        return spawn(...args);
      });
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(calls, 7);
    assert.equal(report.scenarios.length, 8);
    assert.equal(
      report.scenarios.reduce((n, s) => n + s.attempts.length, 0),
      7
    );
    assert.equal(report.status, 'FAIL');
    assert.equal(report.stopReason, 'fixture_error');
    assert.equal(report.cleanup, 'removed_after_confirmed_close');
    const current = report.scenarios.find((s) => s.name === 'fresh-summary');
    assert.equal(current.completed, 1);
    assert.equal(current.attempted, 1);
    assert.equal(current.status, 'FAIL');
    assert.equal(current.incompleteReason, 'fixture_error');
    assert.equal(current.advisoryP95AtMost150Ms, 'NOT_RUN');
    for (const later of report.scenarios.slice(4)) {
      assert.equal(later.status, 'NOT_RUN');
      assert.equal(later.attempted, 0);
      assert.equal(later.incompleteReason, 'fixture_error');
    }
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_MARKER_FIXTURE/);
  }
);

test('Git metadata failure captures and discards subprocess stderr and publishes unknown metadata', () => {
  const code = `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const original=cp.execFileSync;
    cp.execFileSync=(_exe,_args,options)=>original(process.execPath,['-e','process.stderr.write("PRIVATE_MARKER_GIT /synthetic/private/repository");process.exit(1)'],options);
    syncBuiltinESMExports();
    const {metadata}=await import(${JSON.stringify(scriptUrl)});
    const result=metadata(${JSON.stringify(ROOT)});
    if(result.sourceSha!==null||result.dirty!=='unknown') process.exitCode=1;
    console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: {}, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /PRIVATE_MARKER|synthetic\/private/);
  assert.equal(JSON.parse(result.stdout).sourceSha, null);
  assert.equal(JSON.parse(result.stdout).dirty, 'unknown');
});
