import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import fsDefault, * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { main } from '../../dist/cli/hud-main.js';
import { main as entryMain } from '../../dist/cli/hud.js';
import { reportSignature, turnToken } from '../../dist/roles/cli-turn.js';
import { readProcStat } from '../../dist/utils/proc.js';

const id = 'j0000000000000001', sent_at = '2026-01-01T00:00:00Z';
function fixture(t, job = {}, status = { state: 'working', harness: 'pi' }) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = join(home, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, text) => {
    const file = join(dir, name);
    fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
  };
  write('job.json', { job: id, role: 'imp', project_root: '/tmp/synthetic-project', ...job });
  write('STATUS.json', status);
  return { dir, write, run: async (args = ['doctor', id]) => {
    let stdout = '', stderr = '';
    const code = await main(args, { env: { HUD_HOME: home }, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
    return { code, stdout, stderr };
  } };
}

function snapshot(root) {
  return ['', ...fs.readdirSync(root, { recursive: true }).sort()].map((name) => {
    const file = join(root, name), st = fs.statSync(file, { bigint: true });
    return { name, size: st.size, mtime: st.mtimeNs, contents: st.isFile() ? fs.readFileSync(file) : null };
  });
}

test('doctor shows stale and current CLI bindings and leaves a failed job untouched', async (t) => {
  const { dir, write, run } = fixture(t, {
    cli: { agent: 'claude' }, used_place: 'claude (synthetic/model)', checks: ['synthetic-check'],
    attempts: [{ index: 0, place: 'claude (synthetic/model)' }], worktree: { root: '/tmp/synthetic-worktree' },
  }, { state: 'failed', harness: 'cli', exit_reason: 'Synthetic failure', future_field: { nested: ['keep', 42] },
    pid: process.pid, pid_start_time: readProcStat(process.pid).start });
  const turn = { seq: 3, sent_at, report_sig: null };
  write('turn.json', turn);
  write('report.md', 'Synthetic initial report body.');
  const done = { ...turn, at: sent_at, report_sig: reportSignature(dir) };
  write('done.json', done);
  const checks = { turn: turnToken(turn), report_sig: done.report_sig, state: 'done',
    results: [{ command: 'synthetic-check', exit_code: 0 }] };
  write('checks.json', checks);
  write('report.md', 'Synthetic updated report body.');
  write('progress.jsonl', [JSON.stringify({ at: sent_at, text: 'Synthetic first' }),
    JSON.stringify({ at: sent_at, text: 'Synthetic last' })].join('\n') + '\n');
  write('supervisor.pid', String(process.pid));
  write('STATUS.json.stop-requested', '');
  fs.mkdirSync(join(dir, 'qa'));
  write('qa/q2.md', 'Synthetic question');
  write('qa/q3.md', 'Synthetic answered question');
  write('qa/q3.answer.md', 'Synthetic answer');
  const before = snapshot(dir);
  const { code, stdout, stderr } = await run();
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.deepEqual(snapshot(dir), before);
  for (const expected of [/^identity: .*"agent":"claude".*"used_place":/m, /^shared: .*"display_state":"failed"/m,
    /^turn: .*"seq":3/m, /"changed_since_turn":true/, /"for_current_turn":true.*"matches_report_on_disk":false/,
    /^questions: \["q2"\]/m, /"bound_to_current_report":false/, /"future_field": \{\s+"nested": \[\s+"keep",\s+42/,
    /stop_requested":"present".*close_requested":"missing"/, /supervisor.*alive \(PID only\).*worker.*"liveness":"alive"/,
    /^progress: .*Synthetic last/m, /done\.json report_sig differs from the current report\.md signature/]) assert.match(stdout, expected);
  assert.doesNotMatch(stdout, /Synthetic (updated report body|first)/);
  const report_sig = reportSignature(dir);
  write('done.json', { ...done, seq: 2, report_sig });
  const wrongTurn = (await run()).stdout;
  assert.match(wrongTurn, /"for_current_turn":false.*"matches_report_on_disk":true/);
  assert.match(wrongTurn, /done\.json seq 2 differs from turn\.json seq 3/);
  write('done.json', { ...done, report_sig });
  write('checks.json', { ...checks, report_sig });
  const fresh = (await run()).stdout;
  assert.match(fresh, /"for_current_turn":true.*"matches_report_on_disk":true/);
  assert.match(fresh, /"bound_to_current_report":true/);
});

for (const [name, job, harness] of [
  ['pi', {}, 'pi'], ['headless sonic', { role: 'sonic', headless: true }, 'pi'], ['browser', { bro: {} }, 'bro'],
]) test(`doctor handles a ${name} job without CLI artifacts`, async (t) => {
  const { run } = fixture(t, job, { state: 'working', harness, ...(job.headless ? {
    pid: process.pid, pid_start_time: readProcStat(process.pid).start,
  } : {}) });
  const { code, stdout } = await run();
  assert.equal(code, 0);
  assert.match(stdout, /^shared: .*"display_state":"working"/m);
  assert.match(stdout, /^turn: n\/a\nreceipt: n\/a$/m);
  if (job.headless) {
    assert.match(stdout, /^identity: .*"role":"sonic".*"headless":true/m);
    assert.match(stdout, /supervisor_pid_file":"missing".*worker.*"liveness":"alive"/);
  }
  if (job.bro) assert.doesNotMatch(stdout, /^processes:/m);
});

test('doctor labels missing, corrupt and oversize records', async (t) => {
  const { dir, run, write } = fixture(t, { cli: { agent: 'claude' } });
  for (const body of ['{', ' '.repeat(64 * 1024) + '{}', null]) {
    if (body === null) fs.unlinkSync(join(dir, 'STATUS.json')); else write('STATUS.json', body);
    write('turn.json', '{');
    write('report.md', 'x'.repeat(64 * 1024 + 1));
    const { code, stdout, stderr } = await run();
    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.match(stdout, body === null ? /^status: missing$/m : /^status: unreadable$/m);
    assert.match(stdout, /^report: unreadable\nturn: unreadable\nreceipt: missing$/m);
  }
});

test('doctor validates its id and appears in help', async (t) => {
  const { run } = fixture(t);
  assert.match((await run(['help'])).stdout, /hud doctor <jobId>/);
  assert.match((await run(['help'])).stdout, /hud doctor\s+Check the local installation/);
  for (const [args, code, reason] of [[[id, id], 2, /^Usage:/], [['../job'], 2, /^invalid_job_id:/],
    [['j0000000000000002'], 1, /^job_not_found:/]]) {
    const result = await run(['doctor', ...args]);
    assert.equal(result.code, code);
    assert.match(result.stderr, reason);
  }
});

test('bare doctor diagnoses install failures without changing files or exposing config contents', async (t) => {
  const base = fs.mkdtempSync(join(tmpdir(), 'hud-install-doctor-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'hud'), bin = join(base, 'bin'), checkout = join(base, 'checkout');
  const env = { HOME: base, HUD_HOME: home, PATH: `${bin}:/usr/bin:/bin`, HERDR_SOCKET_PATH: join(base, 'herdr.sock') };
  let version = '0.9.5', capabilities;
  const herdr = createServer(peer => peer.once('data', bytes => {
    const request = JSON.parse(bytes.toString());
    assert.equal(request.method, 'ping');
    peer.end(JSON.stringify({ id: request.id, result: { type: 'pong', version, capabilities } }) + '\n');
  }));
  herdr.listen(env.HERDR_SOCKET_PATH);
  await once(herdr, 'listening');
  t.after(() => new Promise(done => herdr.close(done)));
  fs.mkdirSync(home, { mode: 0o700 });
  const put = (rel, value, mode = 0o600) => {
    const file = join(base, rel);
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    return file;
  };
  put('bin/herdr', '#!/bin/sh\nprintf \'{"result":{"panes":[]}}\\n\'\n', 0o700);
  for (const tool of ['pi', 'claude', 'codex', 'agy']) put(`bin/${tool}`, '#!/bin/sh\nexit 99\n', 0o700);
  fs.symlinkSync(process.execPath, join(bin, 'node'));
  put('checkout/bin/hud', '#!/bin/sh\nexit 99\n', 0o700);
  put('checkout/bin/hud-statusline', '#!/bin/sh\nexit 99\n', 0o700);
  fs.symlinkSync(join(checkout, 'bin/hud'), join(bin, 'hud'));
  const sentinel = put('checkout/dist/index.js', 'synthetic');
  put('checkout/dist/harness/pi/package-entry.js', 'synthetic');
  const mcp = put('checkout/packages/hud-mcp/bin/hud-mcp.mjs', `console.log('ready'); setInterval(() => {}, 1000);`, 0o700);
  put('checkout/package-lock.json', { packages: { '': {}, 'node_modules/synthetic': { version: '1.0.0' } } });
  put('checkout/node_modules/synthetic/package.json', { version: '0.0.0' });
  put('.claude.json', { mcpServers: { hud: { command: mcp, env: { SYNTHETIC_TOKEN: 'do-not-print-config-data' } } } });
  put('.claude/settings.json', { statusLine: { type: 'command', command: join(checkout, 'bin/hud-statusline') } });
  const codexConfig = put('dotfiles/codex.toml', `[mcp_servers.hud]\ncommand = ${JSON.stringify(mcp)}\nenabled = false\n`);
  fs.mkdirSync(join(base, '.codex'));
  fs.symlinkSync(codexConfig, join(base, '.codex/config.toml'));
  put('.gemini/antigravity-cli/settings.json', { statusLine: { type: 'command', command: 'owner-status' }, permissions: { allow: ['mcp(hud/*)'] } });
  put('.gemini/config/mcp_config.json', { mcpServers: { hud: { command: bin + '/node', args: [mcp] } } });
  const hook = put('checkout/integrations/agy/pre-invocation.sh', '#!/bin/sh\nexit 99\n', 0o700);
  const hookLink = join(home, 'integrations/agy/pre-invocation.sh');
  fs.mkdirSync(dirname(hookLink), { recursive: true });
  fs.symlinkSync(hook, hookLink);
  put('.gemini/config/hooks.json', { hud: { PreInvocation: [{ command: `'${hookLink}'` }] } });
  for (const [pkg, ext] of [['pi-package', 'hud.mjs'], ['pi-display', 'hud-display.mjs']]) {
    put(`hud/${pkg}/binding.json`, { release: checkout, hudHome: home, node: process.execPath });
    put(`hud/${pkg}/package.json`, {});
    put(`hud/${pkg}/extensions/${ext}`, 'synthetic');
  }
  const piSettings = put('dotfiles/pi.json', { packages: [join(home, 'pi-package'), { source: '../../hud/pi-display' }] });
  fs.mkdirSync(join(base, '.pi/agent'), { recursive: true });
  fs.symlinkSync(piSettings, join(base, '.pi/agent/settings.json'));
  const credentials = put('hud/credentials.env', 'SYNTHETIC_KEY=do-not-print-credential-data\n');
  fs.chmodSync(credentials, 0o644);
  const grokTrustFile = join(base, '.grok/trusted_folders.toml');
  fs.mkdirSync(dirname(grokTrustFile));
  fs.linkSync(credentials, grokTrustFile);
  const staleLease = put(`hud/leases/${'a'.repeat(64)}.json`, { project: checkout, name: 'synthetic-lease',
    kind: 'main', holder: 'synthetic-holder', pid: process.pid, pid_start_time: '0', since: sent_at });
  const project = join(base, 'example'), orphan = join(base, 'example-wt', 'unowned-abcdef');
  fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { env, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@hud.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture');
  git('worktree', 'add', '-qb', 'wt/unowned-abcdef', orphan);
  put('hud/projects.json', { version: 1, projects: [{ root: project, registered_at: sent_at }] });
  const server = spawn(process.execPath, [mcp], { env });
  t.after(async () => { if (server.exitCode === null && server.signalCode === null) { server.kill(); await once(server, 'exit'); } });
  await once(server.stdout, 'data');
  const generation = `hud/generations/${server.pid}.json`, start = readProcStat(server.pid).start;
  put(generation, { kind: 'mcp', stamp: '1:1', start });

  const run = async () => {
    let stdout = '', stderr = '';
    const code = await entryMain(['doctor'], { env, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
    assert.equal(stderr, '');
    assert.doesNotMatch(stdout, /do-not-print-|synthetic-holder/);
    for (const line of stdout.trimEnd().split('\n')) {
      assert.match(line, /^(PASS|FAIL) /);
      assert.equal(line.split('Fix:').length, line.startsWith('FAIL ') ? 2 : 1);
    }
    return { code, stdout };
  };
  const before = snapshot(base);
  let failed;
  const credentialReads = [];
  for (const method of ['openSync', 'readFileSync']) {
    const original = fs[method];
    t.mock.method(fsDefault, method, (file, ...args) => {
      if (file === credentials || file === grokTrustFile) credentialReads.push(method);
      return original(file, ...args);
    });
  }
  syncBuiltinESMExports();
  try { failed = await run(); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(credentialReads, []);
  assert.equal(failed.code, 1);
  for (const expected of [/^FAIL herdr: .*herdr-hud.*-hud/m, /^PASS pi:/m, /^FAIL package-lock \/ node_modules:.*synthetic/m,
    /^FAIL MCP generation:.*stale generation/m, /^PASS watcher generation: not running/m,
    /^PASS Claude MCP: checkout .*; Node /m, /^FAIL Codex MCP: HUD binding is disabled/m,
    /^PASS Antigravity MCP: checkout .*; Node /m, /^PASS Antigravity hook \/ permission:/m, /^PASS pi roles: checkout /m,
    /^FAIL project CLI trust: .*claude, agy/m, /^FAIL credentials.env mode: 0644/m,
    /^FAIL stuck leases: 1 inactive/m, /^FAIL orphaned worktrees: 1 .*unowned-abcdef/m]) assert.match(failed.stdout, expected);
  assert.deepEqual(snapshot(base), before);

  put('checkout/node_modules/synthetic/package.json', { version: '1.0.0' });
  put('dotfiles/codex.toml', `[mcp_servers.hud]\ncommand = ${JSON.stringify(mcp)}\n`);
  put('.claude.json', { mcpServers: { hud: { command: mcp } }, projects: { [project]: { hasTrustDialogAccepted: true } } });
  put('.gemini/antigravity-cli/settings.json', { trustedWorkspaces: [project],
    statusLine: { type: 'command', command: 'owner-status' }, permissions: { allow: ['mcp(hud/*)'] } });
  fs.chmodSync(credentials, 0o600);
  fs.unlinkSync(grokTrustFile);
  fs.unlinkSync(staleLease);
  put('hud/jobs/j0000000000abcdef/job.json', { worktree: { root: orphan } });
  const { ino, ctimeNs } = fs.statSync(sentinel, { bigint: true });
  put(generation, { kind: 'mcp', stamp: `${ino}:${ctimeNs}`, start });
  version = '0.9.5-hud.76b187b0';
  const outdated = await run();
  assert.equal(outdated.code, 1);
  assert.match(outdated.stdout, /^FAIL herdr: .*Upgrade the running HUD herdr fork.*agy_background_work/m);
  capabilities = { agy_background_work: true };
  const healthy = await run();
  assert.equal(healthy.code, 0, healthy.stdout);
  assert.match(healthy.stdout, /^PASS herdr: reachable \(herdr-hud\)/m);
  assert.doesNotMatch(healthy.stdout, /pi-role|pi-dispatch/);
  assert.match(healthy.stdout, /^PASS credentials.env mode: 0600 \(metadata only\)/m);
});

test('hud --version prints the published version, commit and UTC build time', async (t) => {
  const { run } = fixture(t);
  const result = await run(['--version']);
  const info = JSON.parse(fs.readFileSync(new URL('../../dist/build-info.json', import.meta.url), 'utf8'));
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(info.commit, /^[a-f0-9]{40,64}$/);
  assert.equal(result.stdout, `hud ${info.version} (commit ${info.commit}, built ${info.builtAt})\n`);
});
