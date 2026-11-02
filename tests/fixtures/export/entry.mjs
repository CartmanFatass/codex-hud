// Test-only process entry. Production CLI dispatch belongs to B11.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ledgerRuntimeSupported } from '../../../dist-test/src/ledger/runtime.js';

if (!ledgerRuntimeSupported()) {
  process.stderr.write('B18 export requires Node 22.x >=22.13 or >=24 (23 unsupported)\n');
  process.exit(1);
}
const [mode, home, rawOptions = '{"schemaVersion":1}'] = process.argv.slice(2);
if (mode === 'fixture-cleanup-probe') {
  // Read-only demonstration of the old unsafe cleanup predicate, restricted to
  // the explicitly supplied fixture handle. This probe never deletes anything.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(home, 'ledger.sqlite'), { readOnly: true });
  try {
    const allowed = ['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm'];
    const rows = db.prepare('SELECT count(*) AS n FROM runs').get().n;
    const events = db.prepare('SELECT count(*) AS n FROM events').get().n;
    const sources = db.prepare('SELECT root_path,label FROM sources').all();
    const seedOnly =
      rows === 0 &&
      events === 0 &&
      sources.length === 1 &&
      sources[0].root_path === '/synthetic/source' &&
      sources[0].label === 'Process acceptance';
    process.stdout.write(
      JSON.stringify({
        rows,
        events,
        homeMatchesLegacyPredicate: seedOnly && readdirSync(home).every((name) => allowed.includes(name)),
        containerMatchesLegacyPredicate: seedOnly && readdirSync(dirname(home)).every((name) => allowed.includes(name)),
      })
    );
  } finally {
    db.close();
  }
} else if (mode === 'writer') {
  const { openLedger } = await import('../../../dist-test/src/ledger/ledger.js');
  const ledger = await openLedger(join(home, 'ledger.sqlite'));
  try {
    await ledger.transaction((tx) => {
      tx.run("UPDATE runs SET state='uncertain' WHERE run_id='synthetic-run-a3'");
      tx.run("INSERT INTO events(kind,payload,at) VALUES('synthetic.concurrent','{}',1700000010000)");
    });
    writeFileSync(join(home, 'writer-done'), 'committed');
  } finally {
    await ledger.close();
  }
} else {
  if (mode === 'race') {
    const { DatabaseSync } = await import('node:sqlite');
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      if (sql === 'SELECT coalesce(max(seq),0) AS seq FROM events') {
        process.send?.('snapshot-pinned');
        const deadline = performance.now() + 5000;
        while (!existsSync(join(home, 'writer-done'))) {
          if (performance.now() > deadline) throw new Error('test writer did not commit');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
      }
      return prepare.call(this, sql);
    };
  }
  if (mode === 'slow-encoding') {
    // Show that encoding itself counts, even though A4 checks supplied timing before encoding.
    let shift = 0;
    const now = performance.now.bind(performance);
    Object.defineProperty(performance, 'now', { value: () => now() + shift });
    const stringify = JSON.stringify;
    JSON.stringify = function (value, ...args) {
      const result = stringify.call(this, value, ...args);
      if (value?.format === 'hud-delegation-export') shift = 1001;
      return result;
    };
  }
  const { queryDelegationExport } = await import('../../../dist-test/src/core/export-query.js');
  const result = await queryDelegationExport(home, JSON.parse(rawOptions));
  if (result.ok) process.stdout.write(result.value.json);
  else {
    process.stderr.write(`${result.reason}\n`);
    process.exitCode = 1;
  }
}
