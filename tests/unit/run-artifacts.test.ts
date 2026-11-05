import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { RunArtifacts, RUN_META_READ_BYTES } from '../../src/core/run/artifacts.js';
import type { FinalExitReceipt, RunMeta } from '../../src/core/types/supervision.js';

const supported = process.platform === 'linux';
function fixture(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'hud-run-artifacts-'));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
function meta(run = 'run-one'): RunMeta {
  return {
    schema_version: 1,
    run_id: run,
    link_id: 'synthetic-link',
    source_id: 'synthetic-source',
    binding_generation: 1,
    mode: 'headless',
    supervision_strategy: 'headless',
    supervisor: null,
    command_leader: null,
    harness: null,
    scope: null,
    launch_digest: 'a'.repeat(64),
    profile_digest: 'b'.repeat(64),
    launch_call_id: 'call-one',
    launch_correlation_id: 'correlation-one',
    created_at: 1000,
    stdin_mode: 'closed',
    capture: 'file',
    launch_cwd: '/synthetic/project',
    project_origin: null,
  };
}
function receipt(run = 'run-one'): FinalExitReceipt {
  return {
    schema_version: 1,
    receipt_id: 'receipt-one',
    run_id: run,
    link_id: 'synthetic-link',
    source_id: 'synthetic-source',
    binding_generation: 1,
    mode: 'headless',
    strategy: 'headless',
    supervisor: null,
    command_leader: null,
    harness: null,
    scope: null,
    coverage: 'not_submitted',
    created_at: 1000,
    started_at: null,
    ended_at: 1001,
    recorded_at: 1002,
    duration_ms: 0,
    native_exit: null,
    shell_exit: null,
    reason: 'preflight_failure',
    scope_check: null,
    submission_fence: { event_seq: 1, at: 1001, proof_ids: ['sealed-launcher'] },
    cancel_request_seq: null,
    logs: { stdout: 'stdout.log', stderr: 'stderr.log', capture: 'file' },
  };
}

test(
  'run artifacts create private files exclusively and recover read-only without truncation',
  { skip: !supported },
  () =>
    fixture((home) => {
      const writer = RunArtifacts.create(home, 'run-one');
      writer.writeMeta(meta());
      const logs = writer.openLogs();
      writeSync(logs.stdout, Buffer.from([0, 0xff, 0xe2, 0x82, 0xac, 10]));
      writeSync(logs.stderr, Buffer.from('synthetic stderr'));
      closeSync(logs.stdout);
      closeSync(logs.stderr);
      for (const directory of [home, join(home, 'runs'), writer.directory])
        assert.equal(lstatSync(directory).mode & 0o777, 0o700);
      for (const name of ['meta.json', 'stdout.log', 'stderr.log'])
        assert.equal(lstatSync(join(writer.directory, name)).mode & 0o777, 0o600);
      assert.throws(() => RunArtifacts.create(home, 'run-one'), /EEXIST/);
      assert.throws(() => writer.openLogs(), /EEXIST/);
      const reader = RunArtifacts.open(home, 'run-one');
      assert.deepEqual(reader.readMeta(), meta());
      assert.deepEqual(reader.readLog('stdout', 1, 3), { data: Buffer.from([0xff, 0xe2, 0x82]), nextOffset: 4 });
      assert.deepEqual(reader.readLog('stdout', 4), { data: Buffer.from([0xac, 10]), nextOffset: 6 });
      assert.deepEqual(reader.readLog('stdout', 100), { data: Buffer.alloc(0), nextOffset: 100 });
      assert.throws(() => reader.writeMeta(meta()), /read_only/);
      assert.throws(() => reader.commitExit(receipt()), /read_only/);
      assert.throws(() => reader.openLogs(), /read_only/);
      for (const offset of [-1, 0.5, NaN]) assert.throws(() => reader.readLog('stdout', offset), /invalid_log_range/);
    })
);

test(
  'run artifacts final receipts are immutable, idempotent, validated and matched to meta',
  { skip: !supported },
  () =>
    fixture((home) => {
      const writer = RunArtifacts.create(home, 'run-one');
      writer.writeMeta(meta());
      assert.throws(() => writer.commitExit({ ...receipt(), source_id: 'wrong-source' }), /instance_mismatch/);
      assert.throws(
        () => writer.commitExit({ ...receipt(), schema_version: 2 } as unknown as FinalExitReceipt),
        /invalid_exit/
      );
      assert.throws(
        () => writer.commitExit({ ...receipt(), submission_fence: {} } as FinalExitReceipt),
        /invalid_exit/
      );
      writer.commitExit(receipt());
      const before = readFileSync(join(writer.directory, 'exit.json'));
      writer.commitExit(receipt());
      assert.deepEqual(readFileSync(join(writer.directory, 'exit.json')), before);
      assert.equal(lstatSync(join(writer.directory, 'exit.json')).mode & 0o777, 0o600);
      assert.deepEqual(RunArtifacts.open(home, 'run-one').readExit(), receipt());
      assert.throws(() => writer.commitExit({ ...receipt(), recorded_at: 1003 }), /receipt_conflict/);
      assert.throws(() => writer.writeMeta(meta()), /final_receipt/);
    })
);

test('run artifacts meta permits one-time instance enrichment and freezes stable identity', { skip: !supported }, () =>
  fixture((home) => {
    const writer = RunArtifacts.create(home, 'run-one');
    writer.writeMeta(meta());
    const enriched = {
      ...meta(),
      supervisor: { pid: 123, proc_start: '42', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' },
    };
    writer.writeMeta(enriched);
    assert.deepEqual(writer.readMeta(), enriched);
    assert.throws(() => writer.writeMeta(meta()), /immutable_meta_identity/);
    assert.throws(() => writer.writeMeta({ ...enriched, launch_cwd: '/other' }), /immutable_meta_field/);
  })
);

test('scope receipt preserves shell 137 separately from unknown native exit', { skip: !supported }, () =>
  fixture((home) => {
    const writer = RunArtifacts.create(home, 'run-one');
    const process = { pid: 123, proc_start: '42', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' };
    const scope = {
      scope_id: 'scope-one',
      scope_kind: 'pgid' as const,
      pid_domain: process.pid_domain,
      boot_id: process.boot_id,
      pgid: 123,
      sid: 123,
      group_leader: process,
    };
    writer.writeMeta({ ...meta(), command_leader: process, scope });
    const final: FinalExitReceipt = {
      ...receipt(),
      coverage: 'scope',
      reason: 'scope_ended',
      scope,
      duration_ms: 1,
      started_at: 1000,
      command_leader: process,
      shell_exit: {
        process,
        subject: 'command_leader',
        observed_at: 1001,
        exit_code: 137,
        signal: null,
        status_source: 'wait_status',
        evidence_id: 'shell-result',
      },
      scope_check: {
        scope_id: scope.scope_id,
        checked_at: 1001,
        result: 'gone',
        visibility: 'complete',
        member_evidence_ids: [],
        zombie_evidence_ids: [],
        launcher_seal_evidence_ids: ['sealed-launcher'],
        harness_termination_evidence_ids: ['terminated-harness'],
      },
    };
    assert.throws(() => writer.commitExit({ ...final, reason: 'normal_exit' }), /invalid_exit/);
    assert.throws(
      () => writer.commitExit({ ...final, scope_check: { ...final.scope_check!, result: 'alive' } }),
      /invalid_exit/
    );
    writer.commitExit(final);
    assert.equal(writer.readExit()?.native_exit, null);
    assert.equal(writer.readExit()?.shell_exit?.exit_code, 137);
  })
);

test('run artifacts check current owner and refuse hard-linked files', { skip: !supported }, () =>
  fixture((home) => {
    const writer = RunArtifacts.create(home, 'run-one');
    const getuid = process.getuid!;
    try {
      process.getuid = () => getuid() + 1;
      assert.throws(() => writer.readMeta(), /unsafe_run_directory/);
    } finally {
      process.getuid = getuid;
    }
    const outside = join(home, 'outside');
    writeFileSync(outside, '{}', { mode: 0o600 });
    linkSync(outside, join(writer.directory, 'meta.json'));
    assert.throws(() => writer.readMeta(), /unsafe_run_file/);
  })
);

test(
  'run artifacts reject traversal, symlink ancestors, replacement directories and unsafe permissions',
  { skip: !supported },
  () =>
    fixture((home) => {
      for (const run of ['../escape', 'a/b', '', '.'])
        assert.throws(() => RunArtifacts.create(home, run), /invalid_run_id/);
      assert.throws(() => RunArtifacts.create('relative', 'run-one'), /invalid_hud_home/);
      const real = join(home, 'real');
      mkdirSync(real, 0o700);
      const alias = join(home, 'alias');
      symlinkSync(real, alias);
      assert.throws(() => RunArtifacts.create(join(alias, 'home'), 'run-one'));
      const writer = RunArtifacts.create(real, 'run-one');
      chmodSync(writer.directory, 0o755);
      assert.throws(() => writer.readExit(), /unsafe_run_directory/);
      chmodSync(writer.directory, 0o700);
      const external = join(home, 'external');
      writeFileSync(external, '{}', { mode: 0o600 });
      symlinkSync(external, join(writer.directory, 'meta.json'));
      assert.throws(() => writer.readMeta(), /ELOOP/);
      assert.throws(() => writer.writeMeta(meta()), /ELOOP/);
      rmSync(join(writer.directory, 'meta.json'));
      writer.writeMeta(meta());
      chmodSync(join(writer.directory, 'meta.json'), 0o644);
      assert.throws(() => writer.readMeta(), /unsafe_run_file/);
      chmodSync(join(writer.directory, 'meta.json'), 0o600);
      renameSync(writer.directory, writer.directory + '-old');
      mkdirSync(writer.directory, 0o700);
      assert.throws(() => writer.readMeta(), /run_directory_replaced/);
    })
);

test('run artifact reads ignore partial or malformed final files and unknown schemas', { skip: !supported }, () =>
  fixture((home) => {
    const writer = RunArtifacts.create(home, 'run-one');
    writeFileSync(join(writer.directory, '.exit.json.synthetic.tmp'), JSON.stringify(receipt()), { mode: 0o600 });
    assert.equal(writer.readExit(), null);
    for (const invalid of [
      '{',
      '{}',
      JSON.stringify({ ...receipt(), schema_version: 2 }),
      JSON.stringify({ ...receipt(), logs: {} }),
    ]) {
      writeFileSync(join(writer.directory, 'exit.json'), invalid, { mode: 0o600 });
      assert.equal(writer.readExit(), null);
    }
    assert.throws(() => writer.commitExit(receipt()), /receipt_conflict/);
    writeFileSync(join(writer.directory, 'meta.json'), JSON.stringify({ ...meta(), supervisor: { pid: '123' } }), {
      mode: 0o600,
    });
    assert.equal(writer.readMeta(), null);
  })
);

test('crash after temporary receipt fsync and before rename leaves no final receipt', { skip: !supported }, () =>
  fixture((home) => {
    const moduleUrl = new URL('../../src/core/run/artifacts.js', import.meta.url).href;
    const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { RunArtifacts } from ${JSON.stringify(moduleUrl)};
    const writer = RunArtifacts.create(${JSON.stringify(home)}, 'run-one');
    fs.renameSync = () => process.exit(73);
    syncBuiltinESMExports();
    writer.commitExit(${JSON.stringify(receipt())});
  `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.equal(child.status, 73, child.stderr);
    const recovered = RunArtifacts.open(home, 'run-one');
    assert.equal(recovered.readExit(), null);
    assert.equal(existsSync(join(recovered.directory, 'exit.json')), false);
    assert.equal(readdirSync(recovered.directory).filter((name) => name.endsWith('.tmp')).length, 1);
    assert.throws(() => recovered.commitExit(receipt()), /read_only/);
  })
);

test('crash after final rename leaves a recoverable receipt without metadata', { skip: !supported }, () =>
  fixture((home) => {
    const moduleUrl = new URL('../../src/core/run/artifacts.js', import.meta.url).href;
    const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { RunArtifacts } from ${JSON.stringify(moduleUrl)};
    const writer = RunArtifacts.create(${JSON.stringify(home)}, 'run-one');
    const rename = fs.renameSync;
    fs.renameSync = (...args) => { rename(...args); process.exit(74); };
    syncBuiltinESMExports();
    writer.commitExit(${JSON.stringify(receipt())});
  `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.equal(child.status, 74, child.stderr);
    assert.deepEqual(RunArtifacts.open(home, 'run-one').readExit(), receipt());
  })
);

test(
  'bounded metadata accepts the byte limit, rejects larger files and preserves writer/recovery semantics',
  { skip: !supported },
  () =>
    fixture((home) => {
      const writer = RunArtifacts.create(home, 'run-one');
      writer.writeMeta(meta());
      const reader = RunArtifacts.open(home, 'run-one');
      const path = join(writer.directory, 'meta.json');
      const json = JSON.stringify(meta());
      writeFileSync(path, json.padEnd(RUN_META_READ_BYTES, ' '));
      assert.deepEqual(reader.readMetaBounded(), meta());
      writeFileSync(path, json.padEnd(RUN_META_READ_BYTES + 1, ' '));
      assert.throws(() => reader.readMetaBounded(), /run_meta_too_large/);
      assert.deepEqual(reader.readMeta(), meta());
      writer.writeMeta(meta());
      assert.deepEqual(reader.readMetaBounded(), meta());
    })
);

test(
  'bounded metadata performs no allocation/read/parse for oversize and caps reads after fstat growth',
  { skip: !supported },
  () =>
    fixture((home) => {
      const writer = RunArtifacts.create(home, 'run-one');
      writer.writeMeta(meta());
      const path = join(writer.directory, 'meta.json');
      const moduleUrl = new URL('../../src/core/run/artifacts.js', import.meta.url).href;
      // Instrument built-in seams in an owned subprocess, without changing the parent test runtime.
      const source = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { RunArtifacts, RUN_META_READ_BYTES } from ${JSON.stringify(moduleUrl)};
      const reader = RunArtifacts.open(${JSON.stringify(home)}, 'run-one');
      const path = ${JSON.stringify(path)};
      const original = fs.readFileSync(path);
      fs.appendFileSync(path, ' '.repeat(8 * 1024 * 1024));
      const read = fs.readSync, stat = fs.fstatSync, alloc = Buffer.alloc, parse = JSON.parse;
      let reads = 0, allocations = 0, parses = 0, bytes = 0;
      fs.readFileSync = () => { throw new Error('unbounded read'); };
      fs.readSync = (...args) => { reads++; bytes += args[3]; return read(...args); };
      Buffer.alloc = (...args) => { allocations++; assert.ok(args[0] <= RUN_META_READ_BYTES + 1); return alloc(...args); };
      JSON.parse = (...args) => { parses++; return parse(...args); };
      syncBuiltinESMExports();
      assert.throws(() => reader.readMetaBounded(), /run_meta_too_large/);
      assert.deepEqual([reads, allocations, parses], [0, 0, 0]);
      fs.writeFileSync(path, original);
      let grown = false;
      fs.fstatSync = (...args) => {
        const result = stat(...args);
        if (result.isFile() && !grown) {
          grown = true;
          fs.appendFileSync(path, ' '.repeat(8 * 1024 * 1024));
        }
        return result;
      };
      syncBuiltinESMExports();
      assert.throws(() => reader.readMetaBounded(), /run_meta_too_large/);
      assert.equal(grown, true);
      assert.equal(allocations, 1);
      assert.equal(parses, 0);
      assert.ok(bytes <= RUN_META_READ_BYTES + 1);
    `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
    })
);
