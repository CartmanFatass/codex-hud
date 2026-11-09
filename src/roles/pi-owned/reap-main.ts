/** Finite post-exit entry. A1/PR3 supplies the trusted installed-release loader. */
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { processState, sameStamp } from '../../core/run/process.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import { readSlotContract, slotPaths, type ReleaseInventory } from './contracts.js';
import {
  Deadline,
  bounded,
  jsonRead,
  readJournal,
  readOwner,
  REAP_BUDGET_MS,
  resourceLock,
  saveJournal,
  type OwnedRuntime,
} from './launch.js';
import { reapOwned, type CleanupRecord } from './reap.js';
import { parseDispatchStatus } from '../pi-dispatch-status.js';
import { join } from 'node:path';

export class ReaperUnavailable extends Error {
  constructor(
    readonly code:
      'trusted_release_loader_unavailable' | 'release_unavailable' | 'reaper_identity_mismatch' | 'autoclose_ineligible'
  ) {
    super(code);
  }
}
export interface ReaperOptions {
  runtime: Omit<OwnedRuntime, 'context'> & { context: Omit<OwnedRuntime['context'], 'release'> };
  /** Passed by the launch-owning worker, never recovered from cwd/SESSION. */
  expectedRelease: { id: string; root: string };
  expectedProcess: ProcessStamp;
  loadRelease?: (id: string) => Promise<ReleaseInventory | null>;
  exitWaitMs?: number;
}
export async function runReaper(options: ReaperOptions): Promise<CleanupRecord> {
  if (!options.loadRelease) throw new ReaperUnavailable('trusted_release_loader_unavailable');
  const deadline = new Deadline(REAP_BUDGET_MS, options.runtime.budgetMs);
  const release = await bounded(options.loadRelease(options.expectedRelease.id), deadline, options.runtime.signal);
  deadline.check(options.runtime.signal);
  if (!release || release.id !== options.expectedRelease.id || release.root !== options.expectedRelease.root)
    throw new ReaperUnavailable('release_unavailable');
  const runtime: OwnedRuntime = { ...options.runtime, context: { ...options.runtime.context, release } };
  const c = readSlotContract(slotPaths(runtime.context.jobDirectory, 'primary').contract, runtime.context);
  const j = readJournal(c);
  const o = j && readOwner(c, j);
  if (!j || !o || !sameStamp(o.process, options.expectedProcess))
    throw new ReaperUnavailable('reaper_identity_mismatch');
  const status = parseDispatchStatus(
    jsonRead(join(c.task_dir, 'STATUS.json'), c.task_dir),
    c.task_dir,
    c.slot,
    c.role,
    c.output_path
  );
  if (
    c.role === 'implementer' ||
    !status ||
    status.state !== 'closed' ||
    !status.output_written ||
    status.session_id !== c.session_id ||
    !status.settled_at ||
    status.error
  )
    throw new ReaperUnavailable('autoclose_ineligible');
  let admitted = false;
  await resourceLock(c.task_dir, 'resource', deadline, runtime.signal, async () => {
    const current = readJournal(c)!;
    if ((current as typeof current & { autoclose?: unknown }).autoclose) return;
    Object.assign(current, { autoclose: { state: 'sent', process: options.expectedProcess } });
    saveJournal(c, current);
    admitted = true;
  });
  if (!admitted) return { schema: 1, state: 'close_unresolved', remaining: ['autoclose already attempted'], steps: {} };
  const exit = new Deadline(30_000, Math.min(options.exitWaitMs ?? 30_000, deadline.remaining()));
  while (processState(options.expectedProcess) === 'alive' && exit.remaining() > 0) {
    deadline.check(runtime.signal);
    await delay(Math.min(25, exit.remaining(), deadline.remaining()), undefined, { signal: runtime.signal });
  }
  if (processState(options.expectedProcess) !== 'dead')
    return { schema: 1, state: 'close_unresolved', remaining: ['primary exit unconfirmed'], steps: {} };
  return reapOwned({ ...runtime, budgetMs: deadline.remaining() });
}
/** No task-selected loader, executable, inventory or fallback-to-current is accepted. */
export async function main(): Promise<never> {
  throw new ReaperUnavailable('trusted_release_loader_unavailable');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
