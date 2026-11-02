import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { openLedger } from '../../src/ledger/ledger.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { PrivateLedgerGate } from '../../src/ledger/local-manager.js';
import { LedgerCallerRegistry } from '../../packages/hud-mcp/src/ledger-registry.js';
import { LinuxProcessReader } from '../../packages/hud-mcp/src/process.js';
import { registerCaller } from '../../packages/hud-mcp/src/registry.js';
const skip = ledgerRuntimeSupported() ? false : 'Ledger requires Node 22 >=22.13 or >=24';

test(
  'int hud-mcp physical caller registration persists real procStart/cwd without logical authority',
  { skip },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'hud-mcp-ledger-'));
    const ledger = await openLedger(join(home, 'ledger.sqlite'));
    try {
      const registry = new LedgerCallerRegistry(ledger, new PrivateLedgerGate(home));
      const reader = new LinuxProcessReader();
      const input = {
        reader,
        registry,
        profile: null,
        pid: process.pid,
        cwd: () => process.cwd(),
        envPane: null,
        nowMs: Date.now(),
      };
      await assert.rejects(
        () =>
          registerCaller({
            ...input,
            cwd: () => {
              throw new Error('missing');
            },
          }),
        /cwd_unavailable/
      );
      assert.equal(
        ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM callers')!.n),
        0
      );
      const registration = await registerCaller(input);
      const row = ledger.snapshot((tx) =>
        tx.get('SELECT * FROM callers WHERE caller_id=?', registration.caller.callerId)
      );
      assert.equal(row?.proc_start, reader.get(process.pid).procStart);
      assert.equal(row?.parent_proc_start, reader.get(process.ppid).procStart);
      assert.equal(row?.cwd, process.cwd());
      for (const table of ['caller_scopes', 'caller_contexts', 'child_bindings', 'claims'])
        assert.equal(
          ledger.snapshot((tx) => tx.get(`SELECT count(*) AS n FROM ${table}`)!.n),
          0
        );
      await assert.rejects(
        () => registry.register({ ...registration.caller, procStart: 'forged' }, null),
        /registration_unverified/
      );
      await assert.rejects(
        () => registry.register({ ...registration.caller, cwd: '/synthetic/session-cwd' }, null),
        /registration_unverified/
      );
    } finally {
      await ledger.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
);

test('int hud-mcp composition uses existing ledger even when diagnostic registry requested', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-mcp-composition-'));
  const ledger = await openLedger(join(home, 'ledger.sqlite'));
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    env: { ...process.env, HUD_HOME: home, HUD_MCP_REGISTRY_DIR: join(home, 'diagnostic') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (x) => (stderr += x));
  const done = new Promise<number | null>((resolve) => child.once('exit', resolve));
  child.stdin.end();
  try {
    assert.equal(await done, 0, stderr);
    const rows = ledger.snapshot((tx) => tx.all('SELECT * FROM callers'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pid, child.pid);
    assert.equal(rows[0].cwd, process.cwd());
    assert.ok(rows[0].proc_start);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    await ledger.close();
    rmSync(home, { recursive: true, force: true });
  }
});
