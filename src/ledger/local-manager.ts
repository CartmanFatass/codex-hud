import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Ledger } from './ledger.js';
import type { IntentAuthority } from './types.js';
import type { CallBudget } from './call-budget.js';

export interface LocalStoreBinding {
  readonly home: string;
  check(ledger: Ledger, actor: IntentAuthority, budget: CallBudget): void;
}
export class LocalStoreProofFailed extends Error {
  readonly auditUnsafe = true;
  constructor(cause?: unknown) {
    super('local_store_proof_failed', { cause });
  }
}

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
  /** Trusted opening composition only. Captures this original gate and this exact connection.
   * The returned closure is deliberately not a serializable actor or store identifier. */
  bind(ledger: Ledger): LocalStoreBinding {
    let invalid = false;
    return Object.freeze({
      home: this.home,
      check: (candidate: Ledger, actor: IntentAuthority, budget: CallBudget) => {
        budget.check('metadata');
        if (invalid) throw new LocalStoreProofFailed();
        try {
          if (
            candidate !== ledger ||
            process.getuid?.() !== process.geteuid?.() ||
            actor.kind !== 'local_user' ||
            actor.uid !== process.getuid?.() ||
            actor.ownerUid !== actor.uid ||
            actor.hudHomeOwned !== true ||
            actor.ledgerOwned !== true ||
            actor.privatePaths !== true ||
            typeof actor.invocationId !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(actor.invocationId) ||
            Object.keys(actor).some(
              (k) =>
                !['kind', 'uid', 'ownerUid', 'invocationId', 'hudHomeOwned', 'ledgerOwned', 'privatePaths'].includes(k)
            )
          )
            throw new Error('unauthorized_local_manager');
          for (const [path, directory, pinned, optional] of [
            [this.home, true, this.homeIdentity, false],
            [this.path, false, this.ledgerIdentity, false],
            [this.path + '-wal', false, null, true],
            [this.path + '-shm', false, null, true],
          ] as const) {
            let st;
            try {
              st = lstatSync(path);
            } catch (error) {
              if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
              throw error;
            }
            if (
              !isAbsolute(path) ||
              st.isSymbolicLink() ||
              (directory ? !st.isDirectory() : !st.isFile()) ||
              st.uid !== process.getuid?.() ||
              (st.mode & 0o077) !== 0 ||
              (!directory && st.nlink !== 1) ||
              (pinned !== null && `${st.dev}:${st.ino}` !== pinned) ||
              realpathSync(path) !== path
            )
              throw new Error('unsafe_ledger_path');
          }
        } catch (cause) {
          invalid = true;
          throw new LocalStoreProofFailed(cause);
        }
        // Expiry is not a store-proof failure and must not invalidate the binding.
        budget.check('metadata');
      },
    });
  }
}
