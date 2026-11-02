// Separate process: intercept node:sqlite BEFORE the production reader imports it.
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite');
const Native = sqlite.DatabaseSync;
const opens = [];
let statements = 0;
sqlite.DatabaseSync = class extends Native {
  constructor(path, options) {
    opens.push({ memory: path === ':memory:', readOnly: options?.readOnly === true });
    super(path, options);
  }
  prepare(sql) {
    statements++;
    return super.prepare(sql);
  }
};
syncBuiltinESMExports();
const { openLinkLedgerReader } = await import('../../dist/core/link-ledger-read.js');
const { projectLinkTree } = await import('../../dist/core/link/index.js');
const reader = await openLinkLedgerReader(process.argv[2]);
const before = statements;
const ledger = reader.read();
const projection = projectLinkTree({ ledger, roots: [], sessions: [], nowMs: 12000 });
reader.close();
console.log(JSON.stringify({ opens, readStatements: statements - before, state: projection.ledger.state }));
