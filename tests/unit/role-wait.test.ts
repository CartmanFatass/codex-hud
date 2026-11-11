import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { DEFAULT_WAIT_MS, waitForJob } from '../../src/roles/job-wait.js';
import { REPO_ROOT } from '../fixtures/paths.js';

test('bare direct wait passes the 30 minute default; explicit bounds stay unchanged', async (t) => {
  const f = fixture(t);
  assert.equal(DEFAULT_WAIT_MS, 1_800_000);
  assert.equal((await f.run(['--job', JOB])).code, 0);
  assert.equal((await f.run(['--job', JOB, '--timeout-ms', '123'])).code, 0);
  const calls = fs
    .readFileSync(f.env.WAIT_LOG!, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls[0].at(-1), '1800000');
  assert.equal(calls[1].at(-1), '123');
});

test('dispatch timeout exits 6 with the current STATUS, QA and helper observation', async (t) => {
  const f = fixture(t, true);
  fs.writeFileSync(join(f.directory, 'qa/q1.md'), 'Synthetic question pointer');
  fs.mkdirSync(join(f.directory, '.dispatch/sonic-1'), { recursive: true });
  fs.writeFileSync(
    join(f.directory, '.dispatch/sonic-1/STATUS.json'),
    JSON.stringify({ ...f.status, slot: 'sonic-1', role: 'sonic', output_path: join(f.directory, 'sonic-1.md') })
  );
  const result = await f.run();
  assert.equal(result.code, 6);
  assert.equal(result.value.ok, true);
  assert.equal(result.value.event, 'TIMEOUT');
  assert.equal(result.value.status, 'working');
  assert.equal(result.value.dispatch.session_id, 'synthetic-session');
  assert.equal(result.value.pending[0].id, 'q1');
  assert.equal(result.value.helpers[0].slot, 'sonic-1');
  assert.equal(result.value.acceptance, null);
  assert.equal(result.stderr, '');
});

for (const mode of ['timeout', 'agent_not_found', 'malformed', 'multiline', 'oversized']) {
  test(`native herdr ${mode} is distinguished from an observation timeout`, async (t) => {
    const f = fixture(t);
    f.env.WAIT_MODE = mode;
    const result = await f.run();
    assert.equal(result.code, mode === 'timeout' ? 6 : 4);
    assert.equal(result.value.ok, mode === 'timeout');
    if (mode === 'timeout') {
      assert.equal(result.value.event, 'TIMEOUT');
      assert.equal(result.value.status, 'working');
      assert.equal(result.value.report_path, join(f.directory, 'report.md'));
      assert.equal(result.value.herdr_code, 'timeout');
    } else {
      assert.equal(result.value.code, 'wait_failed');
      assert.equal(result.value.herdr_code, mode === 'agent_not_found' ? mode : undefined);
    }
  });
}

test('HUD watchdog timeout is TIMEOUT, not a real wait failure', { timeout: 25000 }, async (t) => {
  const f = fixture(t);
  f.env.WAIT_MODE = 'hang';
  const result = await f.run();
  assert.equal(result.code, 6);
  assert.equal(result.value.event, 'TIMEOUT');
  assert.equal(result.value.ok, true);
  assert.equal(result.value.status, 'working');
});

test('unknown job and unresolved direct or dispatch launches retain exit 4', async (t) => {
  const f = fixture(t);
  assert.equal((await f.run(['--job', 'jfedcba9876543210'])).code, 4);
  fs.writeFileSync(join(f.directory, 'receipt.json'), JSON.stringify({ ...f.receipt, state: 'launch_unknown' }), {
    mode: 0o600,
  });
  assert.equal((await f.run()).code, 4);
  const dispatch = fixture(t, true);
  fs.rmSync(join(dispatch.directory, 'STATUS.json'));
  const result = await dispatch.run();
  assert.equal(result.code, 4);
  assert.equal(result.value.code, 'launch_unknown');
});

test('dispatch settlement still returns DONE and Jev remains unsupported by the local waiter', async (t) => {
  const f = fixture(t, true);
  fs.writeFileSync(join(f.directory, 'STATUS.json'), JSON.stringify({ ...f.status, state: 'idle_grace' }));
  const result = await f.run();
  assert.equal(result.code, 0);
  assert.equal(result.value.event, 'DONE');
  fs.writeFileSync(
    join(f.directory, 'receipt.json'),
    JSON.stringify({ ...f.receipt, pi_dispatch: undefined, executor: { kind: 'jev', job: 'synthetic-jev' } }),
    { mode: 0o600 }
  );
  assert.equal((await waitForJob(f.home, f.env, JOB, 0)).code, 'unsupported');
});

/** Pin every emitted import/re-export/dynamic import, not just source import text. */
test('wait module transitive import graph excludes facade, Jev, routing, MCP and ledger', () => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    assert.doesNotMatch(
      file,
      /\/(?:facade|routing|jev-adapter|launch)\.js$|\/(?:jev|ledger|hud-mcp|pi-owned|harness\/pi)\//,
      'waiter imports an execution module'
    );
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const scan = (node: ts.Node) => {
      let specifier: ts.Node | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        specifier = node.arguments[0];
        assert.ok(specifier && ts.isStringLiteral(specifier), `computed module import in ${file}`);
      }
      if (specifier && ts.isStringLiteral(specifier)) {
        const name = specifier.text;
        if (!name.startsWith('node:')) {
          assert.ok(name.startsWith('.'), `external dependency ${name}`);
          visit(fileURLToPath(new URL(name, pathToFileURL(file))));
        }
      }
      ts.forEachChild(node, scan);
    };
    scan(source);
  };
  visit(join(REPO_ROOT, 'dist/roles/job-wait.js'));
  visit(join(REPO_ROOT, 'dist/cli/wait.js'));
  assert.ok([...seen].some((file) => file.endsWith('/pi-dispatch-status.js')));
});

test('real bin/hud wait dynamically bypasses the ordinary CLI and forbidden runtime graphs', (t) => {
  const f = fixture(t, true);
  const loader = join(f.home, 'guard.mjs');
  fs.writeFileSync(
    loader,
    `export async function resolve(name, context, next) {
    const result = await next(name, context);
    if (/\\/(?:hud-main|facade|routing|jev-adapter|launch)\\.js$|\\/(?:jev|ledger|hud-mcp|pi-owned|harness\\/pi)\\//.test(result.url)) throw new Error('heavy wait import: '+result.url);
    return result;
  }`
  );
  const child = spawnSync(
    process.execPath,
    ['--experimental-loader', loader, join(REPO_ROOT, 'bin/hud'), 'wait', '--job', JOB, '--timeout-ms', '0'],
    { env: f.env, encoding: 'utf8', timeout: 10000 }
  );
  assert.equal(child.status, 6, child.stderr);
  assert.equal(JSON.parse(child.stdout).event, 'TIMEOUT');
});
import { JOB, fixture } from '../fixtures/role-wait-perf.js';

test('semantic residue: file-only wait observes STATUS without writing it', async (t) => {
  const f = fixture(t, true);
  const file = join(f.directory, 'STATUS.json');
  const before = fs.statSync(file, { bigint: true });
  const bytes = fs.readFileSync(file);
  assert.equal((await waitForJob(f.home, f.env, JOB, 0)).event, 'TIMEOUT');
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, before.mtimeNs);
  assert.equal(fs.statSync(file, { bigint: true }).ino, before.ino);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
