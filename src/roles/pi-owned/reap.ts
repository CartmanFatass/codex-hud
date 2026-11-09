/** Shared explicit/autoclose cleanup. No STATUS writes, guessed resources or group kills. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readProcess, processState, sameStamp } from '../../core/run/process.js';
import { readSlotContract, slotPaths, type SlotContract } from './contracts.js';
import {
  callHerdr,
  Deadline,
  dispatchPath,
  inventory,
  jsonRead,
  jsonWrite,
  matchesAgent,
  OwnedOperationError,
  ownedTab,
  readJournal,
  readOwner,
  REAP_BUDGET_MS,
  resourceLock,
  verifyWorker,
  type LaunchJournal,
  type OwnedRuntime,
} from './launch.js';

export interface CleanupRecord {
  schema: 1;
  state: 'closing' | 'closed' | 'close_unresolved';
  remaining: string[];
  steps: Record<string, { state: 'sent' | 'acked' }>;
}
function readCleanup(directory: string): CleanupRecord {
  const path = dispatchPath(directory, 'cleanup.json');
  if (!fs.existsSync(path)) return { schema: 1, state: 'closing', remaining: [], steps: {} };
  const value = jsonRead(path, directory);
  if (value.schema !== 1 || !value.steps || !Array.isArray(value.remaining))
    throw new OwnedOperationError('close_unresolved', 'cleanup record');
  return value;
}
function saveCleanup(directory: string, value: CleanupRecord): void {
  jsonWrite(dispatchPath(directory, 'cleanup.json'), value, directory);
}
async function cleanupResult(
  runtime: OwnedRuntime,
  deadline: Deadline,
  state: CleanupRecord['state'],
  remaining: string[] = []
): Promise<CleanupRecord> {
  const directory = runtime.context.jobDirectory;
  return resourceLock(directory, 'resource', deadline, runtime.signal, async () => {
    const current = readCleanup(directory);
    if (current.state === 'closed') return current;
    current.state = state;
    current.remaining = remaining;
    saveCleanup(directory, current);
    return current;
  });
}
async function cleanupEffect(
  runtime: OwnedRuntime,
  deadline: Deadline,
  key: string,
  argv: string[],
  cap = 15_000,
  slot?: { c: SlotContract; j: LaunchJournal }
): Promise<void> {
  const directory = runtime.context.jobDirectory;
  await resourceLock(directory, 'resource', deadline, runtime.signal, async () => {
    const cleanup = readCleanup(directory);
    if (cleanup.steps[key]) return; // A lost acknowledgement is not permission to repeat.
    if (!slot) throw new OwnedOperationError('close_unresolved', 'cleanup identity required');
    await verifyWorker(runtime, deadline, slot.c, slot.j);
    cleanup.steps[key] = { state: 'sent' };
    saveCleanup(directory, cleanup);
    const out = await callHerdr(runtime, deadline, argv, cap);
    if (out.ok) {
      cleanup.steps[key] = { state: 'acked' };
      saveCleanup(directory, cleanup);
    }
  });
}
function allSlots(runtime: OwnedRuntime): SlotContract[] {
  const directory = runtime.context.jobDirectory;
  return fs
    .readdirSync(dispatchPath(directory))
    .filter((n) => /^(?:primary|sonic-(?:[1-9]|10)|review-[1-3])$/.test(n))
    .map((slot) => readSlotContract(slotPaths(directory, slot).contract, runtime.context));
}
function accounted(c: SlotContract, j: LaunchJournal): boolean {
  if (j.steps.tab?.state === 'sent' || j.steps.split?.state === 'sent') return false;
  return true;
}
/** PID inspection is best effort, not an atomic kernel process handle. Refuse any mismatch. */
export function signalOwnedWorker(c: SlotContract, j: LaunchJournal): boolean {
  const o = readOwner(c, j);
  if (!o || processState(o.process) !== 'alive') return false;
  try {
    const argv = fs.readFileSync(`/proc/${o.process.pid}/cmdline`, 'utf8').split('\0');
    const contractArg = argv.indexOf('--hud-role-contract');
    const sessionArg = argv.indexOf('--session-id');
    if (
      contractArg < 0 ||
      argv[contractArg + 1] !== slotPaths(c.task_dir, c.slot).contract ||
      sessionArg < 0 ||
      argv[sessionArg + 1] !== c.session_id ||
      !sameStamp(o.process, readProcess(o.process.pid)!.stamp)
    )
      return false;
    process.kill(o.process.pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
export async function reapOwned(runtime: OwnedRuntime): Promise<CleanupRecord> {
  const deadline = new Deadline(REAP_BUDGET_MS, runtime.budgetMs);
  try {
    return await resourceLock(runtime.context.jobDirectory, 'cleanup', deadline, runtime.signal, () =>
      reapOperation(runtime, deadline)
    );
  } catch (error) {
    return {
      schema: 1,
      state: 'close_unresolved',
      remaining: [error instanceof Error ? error.message : String(error)],
      steps: {},
    };
  }
}
async function reapOperation(runtime: OwnedRuntime, deadline: Deadline): Promise<CleanupRecord> {
  const directory = runtime.context.jobDirectory;
  let cleanup: CleanupRecord = { schema: 1, state: 'closing', remaining: [], steps: {} };
  try {
    await resourceLock(directory, 'resource', deadline, runtime.signal, async () => {
      const path = dispatchPath(directory, 'control.json');
      const control = fs.existsSync(path) ? jsonRead(path, directory) : { schema: 1, closing: false, generation: 0 };
      if (control.schema !== 1 || typeof control.closing !== 'boolean' || !Number.isSafeInteger(control.generation))
        throw new OwnedOperationError('close_unresolved', 'control');
      if (!control.closing)
        jsonWrite(path, { schema: 1, closing: true, generation: control.generation + 1 }, directory);
      cleanup = readCleanup(directory);
    });
    if (cleanup.state === 'closed') return cleanup;
    const slots = allSlots(runtime);
    const primary = slots.find((c) => c.slot === 'primary');
    if (!primary) throw new OwnedOperationError('close_unresolved', 'primary contract missing');
    const journal = readJournal(primary);
    if (!journal) {
      return await cleanupResult(runtime, deadline, 'closed');
    }
    if (journal.caller_tab !== runtime.callerTab) throw new OwnedOperationError('close_unresolved', 'caller mismatch');
    const journals = slots.map((c) => ({ c, j: readJournal(c) }));
    if (journals.some(({ c, j }) => j && !accounted(c, j)))
      throw new OwnedOperationError('close_unresolved', 'unacknowledged resource operation');
    const ownedProcesses = journals.flatMap(({ c, j }) => {
      const owner = j && readOwner(c, j);
      if (j?.steps.start && !owner) throw new OwnedOperationError('close_unresolved', 'startup ownership unreadable');
      return owner ? [owner.process] : [];
    });
    let list = await inventory(runtime, deadline, journal);
    if (!journal.tab) {
      if (journal.steps.tab) throw new OwnedOperationError('close_unresolved', 'unknown created tab');
      return await cleanupResult(runtime, deadline, 'closed');
    }
    const absent = () =>
      !list.tabs.some((t) => t.tabId === journal.tab) &&
      !list.panes.some((p) => p.tabId === journal.tab) &&
      !list.agents.some((a) => a.tab_id === journal.tab);
    if (absent()) {
      // Only our recorded close attempt can account for a missing formerly owned tab.
      if (!cleanup.steps.close)
        throw new OwnedOperationError('close_unresolved', 'tab disappeared without owned close');
    } else {
      if (!ownedTab(journal, list.tabs)) throw new OwnedOperationError('close_unresolved', 'tab identity');
      for (const agent of list.agents.filter((a) => a.tab_id === journal.tab)) {
        const slot = journals.find(({ c, j }) => j && readOwner(c, j) && matchesAgent(agent, readOwner(c, j)!));
        if (!slot || !slot.j || processState(readOwner(slot.c, slot.j)!.process) !== 'alive')
          throw new OwnedOperationError('close_unresolved', 'foreign/stale occupant');
        await cleanupEffect(
          runtime,
          deadline,
          `quit-${slot.c.slot}`,
          ['agent', 'prompt', slot.j.agent, '/quit'],
          Math.min(15_000, deadline.remaining()),
          { c: slot.c, j: slot.j }
        );
      }
      // One shared grace, not one grace per agent. Do not hold the mutation lock while waiting.
      const grace = new Deadline(30_000, deadline.remaining());
      for (;;) {
        list = await inventory(runtime, deadline, journal);
        const live = journals.filter(
          ({ c, j }) => j && readOwner(c, j) && processState(readOwner(c, j)!.process) === 'alive'
        );
        if (!list.agents.some((a) => a.tab_id === journal.tab) && !live.length) break;
        if (grace.remaining() <= 0) break;
        await delay(Math.min(50, grace.remaining(), deadline.remaining()), undefined, { signal: runtime.signal });
      }
      for (const { c, j } of journals)
        if (j && readOwner(c, j) && processState(readOwner(c, j)!.process) === 'alive') {
          const o = readOwner(c, j)!;
          if (!list.agents.some((a) => matchesAgent(a, o)))
            throw new OwnedOperationError('close_unresolved', 'detached live process');
          const key = `term-${c.slot}`;
          await resourceLock(directory, 'resource', deadline, runtime.signal, async () => {
            const current = readCleanup(directory);
            if (current.steps[key]) return;
            await verifyWorker(runtime, deadline, c, j);
            current.steps[key] = { state: 'sent' };
            saveCleanup(directory, current);
            if (signalOwnedWorker(c, j)) {
              current.steps[key] = { state: 'acked' };
              saveCleanup(directory, current);
            }
          });
        }
      // Verification/close share the resource fence. Never close with any remaining occupant.
      await resourceLock(directory, 'resource', deadline, runtime.signal, async () => {
        list = await inventory(runtime, deadline, journal);
        if (
          !ownedTab(journal, list.tabs) ||
          list.agents.some((a) => a.tab_id === journal.tab) ||
          ownedProcesses.some((stamp) => processState(stamp) !== 'dead')
        )
          throw new OwnedOperationError('close_unresolved', 'resources remain');
        const allowed = new Set([journal.left, journal.right, ...journals.map(({ j }) => j?.pane)]);
        if (list.panes.some((p) => p.tabId === journal.tab && !allowed.has(p.paneId)))
          throw new OwnedOperationError('close_unresolved', 'unrecorded pane');
        const current = readCleanup(directory);
        if (!current.steps.close) {
          current.steps.close = { state: 'sent' };
          saveCleanup(directory, current);
          const out = await callHerdr(runtime, deadline, ['tab', 'close', journal.tab!]);
          if (out.ok) {
            current.steps.close = { state: 'acked' };
            saveCleanup(directory, current);
          }
        }
      });
      list = await inventory(runtime, deadline, journal);
      if (!absent()) throw new OwnedOperationError('close_unresolved', 'tab close unconfirmed');
    }
    if (ownedProcesses.some((stamp) => processState(stamp) !== 'dead'))
      throw new OwnedOperationError('close_unresolved', 'worker exit unconfirmed');
    return await cleanupResult(runtime, deadline, 'closed');
  } catch (error) {
    // Preserve every admitted effect even if a later call timed out or was aborted.
    try {
      cleanup = readCleanup(directory);
    } catch {
      /* Retain local diagnostic. */
    }
    const remaining = [error instanceof Error ? error.message : String(error)];
    try {
      return await cleanupResult(runtime, deadline, 'close_unresolved', remaining);
    } catch {
      return { ...cleanup, state: 'close_unresolved', remaining };
    } // No unbounded or unlocked write after cancellation/deadline.
  }
}
/** Helpers retire only their own agent; never close the parent's tab. */
export async function retireHelper(runtime: OwnedRuntime, c: SlotContract, budgetMs = 30_000): Promise<boolean> {
  const deadline = new Deadline(REAP_BUDGET_MS, budgetMs);
  const j = readJournal(c);
  if (!j) return true;
  try {
    const owner = readOwner(c, j);
    if (readCleanup(c.task_dir).state === 'closed') return !!owner && processState(owner.process) === 'dead';
    let list = await inventory(runtime, deadline, j);
    if (!owner || !ownedTab(j, list.tabs)) return false;
    const occupying = list.agents.filter((a) => a.pane_id === j.pane);
    if (occupying.some((a) => !matchesAgent(a, owner))) return false;
    if (occupying.length)
      await cleanupEffect(runtime, deadline, `quit-${c.slot}`, ['agent', 'prompt', j.agent, '/quit'], 15_000, { c, j });
    while (processState(owner.process) === 'alive') {
      deadline.check(runtime.signal);
      await delay(Math.min(25, deadline.remaining()), undefined, { signal: runtime.signal });
    }
    list = await inventory(runtime, deadline, j);
    return processState(owner.process) === 'dead' && !list.agents.some((a) => a.pane_id === j.pane);
  } catch {
    return false;
  }
}
