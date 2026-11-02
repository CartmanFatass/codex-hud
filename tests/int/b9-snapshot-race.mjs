import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite');
const Native = sqlite.DatabaseSync;
const writer = new Native(process.argv[2]);
let changed = false;
sqlite.DatabaseSync = class extends Native {
  prepare(sql) {
    if (!changed && sql.startsWith('SELECT * FROM links')) {
      changed = true;
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare("UPDATE links SET label='Synthetic concurrent label' WHERE link_id='link-a'").run();
      writer
        .prepare(
          "INSERT INTO events(link_id,run_id,kind,payload,at) VALUES('link-a','run-a','synthetic.changed','{}',12000)"
        )
        .run();
      writer.exec('COMMIT');
    }
    return super.prepare(sql);
  }
};
syncBuiltinESMExports();
const { openLinkLedgerReader } = await import('../../dist/core/link-ledger-read.js');
const reader = await openLinkLedgerReader(process.argv[2]);
try {
  const first = reader.read();
  assert.equal(first.state, 'available');
  assert.equal(first.snapshot.asOfSeq, 2);
  assert.equal(first.snapshot.links[0].label, 'Synthetic worker');
  const second = reader.read();
  assert.equal(second.state, 'available');
  assert.equal(second.snapshot.asOfSeq, 3);
  assert.equal(second.snapshot.links[0].label, 'Synthetic concurrent label');
  assert.equal(first.snapshot.links[0].label, 'Synthetic worker');
  assert.throws(() => {
    second.snapshot.links[0].label = 'Untrusted caller edit';
  }, TypeError);
  console.log('B9 snapshot race: passed');
} finally {
  reader.close();
  writer.close();
}
