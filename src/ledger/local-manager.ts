import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface TrustedLocalActor {
  kind: 'trusted_local';
  uid: number;
  invocationId: string;
}

/** Pins the existing private store. Recheck inside each management write transaction.
 * No user-supplied path/actor flag establishes local management authority.
 */
export class PrivateLedgerGate {
  readonly path: string;
  private readonly homeIdentity: string;
  private readonly ledgerIdentity: string;
  constructor(readonly home: string) {
    this.path = join(home, 'ledger.sqlite');
    this.homeIdentity = this.inspect(home, true);
    this.ledgerIdentity = this.inspect(this.path, false);
    this.check();
  }
  private inspect(path: string, directory: boolean): string {
    if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error('unsafe_ledger_path');
    const st = lstatSync(path);
    if (
      (directory ? !st.isDirectory() : !st.isFile()) ||
      st.isSymbolicLink() ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o077) !== 0 ||
      (!directory && st.nlink !== 1)
    )
      throw new Error('unsafe_ledger_path');
    return `${st.dev}:${st.ino}`;
  }
  check(actor?: TrustedLocalActor): void {
    if (process.getuid?.() !== process.geteuid?.()) throw new Error('unauthorized_local_manager');
    if (this.inspect(this.home, true) !== this.homeIdentity || this.inspect(this.path, false) !== this.ledgerIdentity)
      throw new Error('ledger_path_replaced');
    for (const suffix of ['-wal', '-shm']) {
      try {
        this.inspect(this.path + suffix, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (
      actor &&
      (actor.kind !== 'trusted_local' ||
        actor.uid !== process.getuid?.() ||
        typeof actor.invocationId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(actor.invocationId) ||
        Object.keys(actor).some((key) => !['kind', 'uid', 'invocationId'].includes(key)))
    )
      throw new Error('unauthorized_local_manager');
  }
  actor(): TrustedLocalActor {
    this.check();
    return { kind: 'trusted_local', uid: process.getuid!(), invocationId: randomUUID() };
  }
}
