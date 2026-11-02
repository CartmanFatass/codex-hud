/// <reference path="../../../src/types/node-sqlite.d.ts" />
import { realpathSync } from 'node:fs';
import type { Caller, Source } from '../../../src/core/types/identity.js';
import { makeSourceId } from '../../../src/core/identity.js';
import { canonicalJson } from '../../../src/core/canonical.js';
import { openLedger, type Ledger } from '../../../src/ledger/ledger.js';
import { PrivateLedgerGate } from '../../../src/ledger/local-manager.js';
import { decodeRecord, insertRecord } from '../../../src/ledger/records.js';
import { Refusal } from './errors.js';
import { LinuxProcessReader, type ProcessReaderPort } from './process.js';
import type { CallerRegistryPort } from './registry.js';

/** Physical registration only: no scope, context, claim, alias or logical binding. */
export class LedgerCallerRegistry implements CallerRegistryPort {
  constructor(
    readonly ledger: Ledger,
    readonly gate: PrivateLedgerGate,
    readonly reader: ProcessReaderPort = new LinuxProcessReader()
  ) {}
  async register(caller: Caller, source: Source | null): Promise<void> {
    const copy = structuredClone(caller),
      origin = structuredClone(source);
    const verify = () => {
      this.gate.check();
      const self = this.reader.get(process.pid),
        parent = this.reader.get(self.ppid);
      if (
        copy.pid !== process.pid ||
        copy.pid !== self.pid ||
        copy.procStart !== self.procStart ||
        copy.ppid !== self.ppid ||
        copy.parentProcStart !== parent.procStart ||
        self.pidNamespace !== parent.pidNamespace ||
        copy.cwd !== process.cwd() ||
        !copy.cwd ||
        copy.instanceKind !== 'dedicated' ||
        copy.retiredAt !== null ||
        copy.sourceId !== (origin?.sourceId ?? null)
      )
        throw new Refusal('registration_unverified');
    };
    verify();
    if (
      origin &&
      (makeSourceId(origin.harness, realpathSync(origin.rootPath)) !== origin.sourceId ||
        copy.harness !== origin.harness)
    )
      throw new Refusal('registration_unverified');
    await this.ledger.transaction((tx) => {
      verify();
      if (origin) {
        const old = tx.get('SELECT * FROM sources WHERE source_id=?', origin.sourceId);
        if (old) {
          const stored = decodeRecord<Source>(old);
          if (canonicalJson([stored.harness, stored.rootPath]) !== canonicalJson([origin.harness, origin.rootPath]))
            throw new Refusal('registration_unverified');
        } else insertRecord(tx, 'sources', origin);
      }
      insertRecord(tx, 'callers', copy);
    });
  }
}
export async function createLedgerCallerRegistry(home: string): Promise<LedgerCallerRegistry> {
  const gate = new PrivateLedgerGate(home);
  const ledger = await openLedger(gate.path);
  try {
    gate.check();
    return new LedgerCallerRegistry(ledger, gate);
  } catch (error) {
    await ledger.close();
    throw error;
  }
}
