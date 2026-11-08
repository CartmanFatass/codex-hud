import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import ts from 'typescript';
import { main } from '../../src/cli/hud.js';
import { DEFAULT_WAIT_MS, waitForJob } from '../../src/roles/job-wait.js';
import { REPO_ROOT } from '../fixtures/paths.js';

const JOB = 'j0123456789abcdef';
function fixture(t: TestContext, dispatch = false) {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-wait-')));
  fs.chmodSync(home, 0o700);
  const directory = join(home, 'jobs', JOB);
  const bin = join(home, 'bin');
  fs.mkdirSync(join(directory, 'qa'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin);
  const receipt = {
    schema: 1,
    job: JOB,
    role: 'imp',
    phase: null,
    state: 'open',
    prompted: true,
    binding: { executor: 'herdr', harness: 'pi' },
    executor: { kind: 'herdr', agent: 'synthetic-agent' },
    ...(dispatch
      ? {
          pi_dispatch: {
            contract_version: 1,
            role: 'implementer',
            executable: '/synthetic/pi-dispatch',
            reaper: '/synthetic/pi-role-reap',
            launch: 'acked',
          },
        }
      : {}),
  };
  fs.writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
  const status = {
    version: 1,
    task_dir: directory,
    slot: 'primary',
    role: 'implementer',
    output_path: join(directory, 'report.md'),
    state: 'working',
    output_written: false,
    session_id: 'synthetic-session',
    model: null,
    thinking: null,
    error: null,
    exit_reason: null,
    settled_at: null,
    idle_deadline_at: null,
    ended_at: null,
    helper_pending: null,
  };
  if (dispatch) fs.writeFileSync(join(directory, 'STATUS.json'), JSON.stringify(status));
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.WAIT_LOG) require('node:fs').appendFileSync(process.env.WAIT_LOG, JSON.stringify(args)+'\\n');
if (args[1] === 'get') { console.log(JSON.stringify({result:{agent:{agent_status:'working'}}})); }
else if (process.env.WAIT_MODE === 'hang') { setInterval(()=>{},1000); }
else if (process.env.WAIT_MODE === 'malformed') { console.error('not JSON: timeout'); process.exitCode=1; }
else if (process.env.WAIT_MODE === 'oversized') { console.error(' '.repeat(5000)+JSON.stringify({error:{code:'timeout'}})+'x'); process.exitCode=1; }
else if (process.env.WAIT_MODE === 'multiline') { console.error(JSON.stringify({error:{code:'timeout'}})+'\\n{}'); process.exitCode=1; }
else if (process.env.WAIT_MODE) { console.error(JSON.stringify({error:{code:process.env.WAIT_MODE,message:'synthetic'},id:'cli:agent:wait'})); process.exitCode=1; }
else { console.log(JSON.stringify({result:{agent:{agent_status:'idle'}}})); }
`;
  fs.writeFileSync(join(bin, 'herdr'), script, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    HUD_HOME: home,
    PATH: bin,
    WAIT_LOG: join(home, 'argv.log'),
    PI_CODING_AGENT_DIR: join(home, 'pi'),
    PI_ROLES_LEDGER: join(home, 'ledger'),
  };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = async (args: string[] = ['--job', JOB, '--timeout-ms', '0']) => {
    let stdout = '',
      stderr = '';
    const code = await main(['wait', ...args], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, value: stdout ? JSON.parse(stdout) : null, stderr };
  };
  return { home, directory, bin, env, receipt, status, run };
}

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
    assert.doesNotMatch(file, /\/(?:facade|routing|jev-adapter)\.js$|\/(?:jev|ledger|hud-mcp)\//);
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
    if (/\\/(?:hud-main|facade|routing|jev-adapter)\\.js$|\\/(?:jev|ledger|hud-mcp)\\//.test(result.url)) throw new Error('heavy wait import: '+result.url);
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
