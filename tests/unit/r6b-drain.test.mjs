import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = process.env.R6B_AUDIT_TEST_SCRIPT ?? resolve('scripts/audit-r6b-drain.mjs');
// A separate process traps even attempted writes/signals, including signal(0).
const guard = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const refuse=()=>{process.stderr.write('audit_effect_forbidden\\n');throw Error('audit_effect_forbidden')};process.kill=refuse;
for(const name of ['writeFileSync','appendFileSync','renameSync','unlinkSync','rmSync','mkdirSync','chmodSync','truncateSync','writeSync','createWriteStream'])fs[name]=refuse;
const open=fs.openSync;fs.openSync=(p,f,...a)=>{if(typeof f==='string'?!['r','rs','sr'].includes(f):(f&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)))refuse();return open(p,f,...a)};
syncBuiltinESMExports();`;
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'r6b-audit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['home', 'hud', 'codex', 'hud/jobs']) fs.mkdirSync(join(root, dir), { recursive: true });
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    HUD_HOME: join(root, 'hud'),
    CODEX_HOME: join(root, 'codex'),
  };
  for (const key of Object.keys(env)) if (key.startsWith('HERDR_')) delete env[key];
  return { root, env, home: join(root, 'hud'), inventory: join(root, 'inventory.json') };
}
function snapshot(root) {
  return fs
    .readdirSync(root, { recursive: true })
    .sort()
    .map((name) => {
      const file = join(root, name),
        stat = fs.lstatSync(file);
      let bytes = null;
      try {
        if (stat.isFile()) bytes = fs.readFileSync(file).toString('hex');
      } catch (error) {
        if (error.code !== 'EACCES') throw error;
        bytes = 'unreadable';
      }
      return [name, stat.mode, bytes];
    });
}
function run(f, slice = 'pi', extra = [], inventory = true) {
  const before = snapshot(f.root);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(guard)}`,
      script,
      '--slice',
      slice,
      '--home',
      f.home,
      ...(inventory ? ['--inventory', f.inventory] : []),
      ...extra,
    ],
    { env: f.env, encoding: 'utf8', timeout: 10000 }
  );
  assert.ifError(result.error);
  assert.doesNotMatch(result.stderr, /audit_effect_forbidden/);
  assert.equal(result.stderr, '');
  assert.deepEqual(snapshot(f.root), before, 'audit tree must be byte-identical with no new files or changed modes');
  return result;
}
function inventory(f, processes, slice = 'pi') {
  fs.writeFileSync(f.inventory, JSON.stringify({ schema: 1, slice, processes }));
}

test('audit checks real live, dead and reused process stamps without signals or writes', async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();console.log("ready")'], {
    env: f.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.stdin.end());
  await once(child.stdout, 'data');
  const fields = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' ');
  const stamp = {
    pid: child.pid,
    start_ticks: Number(fields[19]),
    boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  };
  inventory(f, [stamp]);
  let r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL inventory_process_0$/m);
  assert.equal(child.exitCode, null, 'live subject was not signalled');
  inventory(f, [{ ...stamp, start_ticks: stamp.start_ticks + 1 }]);
  assert.match(run(f).stdout, /^PASS inventory_process_0$/m);
  inventory(f, [{ ...stamp, boot_id: 'undisclosed-boot' }]);
  assert.match(run(f).stdout, /^UNKNOWN inventory_process_0$/m);
  const exited = once(child, 'exit');
  child.stdin.end();
  await exited;
  inventory(f, [stamp]);
  r = run(f);
  assert.match(r.stdout, /^PASS inventory_process_0$/m);
  assert.equal(r.status, 1, 'dead process is not proof that panes/helpers were closed');
});

test('audit inventory malformed, truncated, unreadable and missing is UNKNOWN and nonzero', (t) => {
  const f = fixture(t);
  for (const value of [
    'not json',
    '{"schema":1,',
    '[]',
    '{"schema":1,"slice":"pi"}',
    JSON.stringify({ schema: 2, slice: 'pi', processes: [] }),
  ]) {
    fs.writeFileSync(f.inventory, value);
    const r = run(f);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^UNKNOWN inventory_readable$/m);
    assert.doesNotMatch(r.stdout, /^PASS inventory_readable$/m);
  }
  inventory(f, []);
  const unreadableBytes = fs.readFileSync(f.inventory);
  fs.chmodSync(f.inventory, 0);
  let r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^UNKNOWN inventory_readable$/m);
  assert.doesNotMatch(r.stdout, /^PASS inventory_readable$/m);
  fs.chmodSync(f.inventory, 0o600);
  assert.deepEqual(fs.readFileSync(f.inventory), unreadableBytes);
  fs.unlinkSync(f.inventory);
  r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^UNKNOWN inventory_readable$/m);
});

test('audit all slices retain undisclosed ownership/config scope; closed legacy is not drain proof', (t) => {
  const f = fixture(t);
  const job = join(f.home, 'jobs', 'j0123456789abcdef');
  fs.mkdirSync(job);
  const receipt = {
    schema: 1,
    state: 'closed',
    binding: { harness: 'pi', executor: 'herdr' },
    executor: { kind: 'herdr' },
    pi_dispatch: { contract_version: 1 },
  };
  fs.writeFileSync(join(job, 'receipt.json'), JSON.stringify(receipt));
  assert.match(run(f, 'pi', [], false).stdout, /^UNKNOWN legacy_pi_resources$/m);
  delete receipt.pi_dispatch;
  fs.writeFileSync(join(job, 'receipt.json'), JSON.stringify(receipt));
  assert.match(run(f, 'pi', [], false).stdout, /^UNKNOWN legacy_pi_resources$/m);
  receipt.pi_dispatch = { contract_version: 2, transport: 'hud-owned' };
  fs.writeFileSync(join(job, 'receipt.json'), JSON.stringify(receipt));
  assert.doesNotMatch(run(f, 'pi', [], false).stdout, /legacy_pi_resources/);
  for (const slice of ['transports', 'workbench', 'runtime']) {
    inventory(f, [], slice);
    const r = run(f, slice);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^PASS inventory_readable$/m);
    assert.match(r.stdout, /^UNKNOWN owner_|^UNKNOWN six_role_activation/m);
    if (slice === 'runtime') assert.match(r.stdout, /^UNKNOWN client_files_readable$/m);
  }
  const config = join(f.root, 'client.json');
  fs.writeFileSync(config, '{"synthetic":true}');
  inventory(f, [], 'runtime');
  const r = run(f, 'runtime', ['--prefix', f.root, '--clients', config]);
  assert.match(r.stdout, /^PASS client_files_readable$/m);
  assert.match(r.stdout, /^UNKNOWN six_role_activation_and_complete_client_scope$/m);
});
