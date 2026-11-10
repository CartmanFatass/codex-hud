/** Conservative, finite cleanup. No STATUS writes and no name/group based OS kills. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readSlotContract, slotPaths, type ContractContext, type SlotContract } from './contracts.js';
import {
  Deadline,
  ExecutionError,
  Runtime,
  locked,
  optionalJson,
  processState,
  readProcess,
  sameStamp,
  save,
  readRuntimeBinding,
  type Journal,
  type Owner,
  type RuntimeOptions,
} from './runtime.js';

export const REAP_BUDGET_MS = 180_000;
export const DETACH_GRACE_MS = 30_000;
export interface ReapOptions extends RuntimeOptions {
  graceMs?: number;
}
export interface Cleanup {
  schema: 1;
  state: 'closed' | 'close_unresolved';
  remaining: string[];
  steps: Record<string, 'sent' | 'acked'>;
  instance?: string;
  tab?: string;
  label?: string;
}
function commandMatches(owner: Owner, contract: SlotContract): boolean {
  try {
    const before = readProcess(owner.process.pid);
    if (!before || !sameStamp(before.stamp, owner.process)) return false;
    const args = fs.readFileSync(`/proc/${owner.process.pid}/cmdline`, 'utf8').split('\0');
    const has = (flag: string, value: string) => args.some((arg, n) => arg === flag && args[n + 1] === value);
    const after = readProcess(owner.process.pid);
    return (
      !!after &&
      sameStamp(after.stamp, owner.process) &&
      has('--hud-role-contract', slotPaths(contract.task_dir, contract.slot).contract) &&
      has('--session-id', contract.session_id) &&
      has('--session-dir', contract.session_dir)
    );
  } catch {
    return false;
  }
}
async function recordedOwner(runtime: Runtime, contract: SlotContract, journal: Journal): Promise<Owner> {
  const owner = optionalJson<Owner>(runtime.path(contract.slot, 'owner.json'), contract.task_dir);
  if (!owner) throw new ExecutionError('owner_unknown');
  if (processState(owner.process) === 'alive') {
    try {
      return await runtime.owner(contract, journal);
    } catch (error) {
      // Successful one-shots may detach between stamp inspection and agent get.
      // Only a now-dead exact stamp can fall through to immutable exit validation.
      if (processState(owner.process) !== 'dead') throw error;
    }
  }
  // A dead stamp is not permission to signal its PID. Validate immutable identity even on exit.
  if (
    owner.schema !== 1 ||
    owner.job !== contract.job ||
    owner.slot !== contract.slot ||
    owner.session_id !== contract.session_id ||
    owner.instance !== journal.instance ||
    owner.tab_id !== journal.tab ||
    owner.pane_id !== journal.pane ||
    owner.agent_name !== journal.name ||
    !owner.session_file?.startsWith(contract.session_dir + '/') ||
    !owner.session_file.endsWith(`_${contract.session_id}.jsonl`) ||
    processState(owner.process) !== 'dead'
  )
    throw new ExecutionError('owner_unknown');
  return owner;
}
/** Caller holds resources lock (or admitted retirement); waits share the one operation deadline. */
async function detach(
  runtime: Runtime,
  slots: { contract: SlotContract; journal: Journal }[],
  cleanup: Cleanup,
  persist: () => void,
  graceMs: number
): Promise<void> {
  const owners = new Map<string, Owner>();
  for (const { contract, journal } of slots) {
    if (!journal.steps.start || journal.steps.start.state === 'intent') continue;
    const owner = await recordedOwner(runtime, contract, journal);
    owners.set(journal.name, owner);
    // Historical helpers share a pane. A dead slot never owns the next slot's occupant.
    // The live slot and the final complete inventory still have to account for it.
    if (processState(owner.process) === 'dead') continue;
    const inventory = await runtime.tab(journal);
    const occupants = inventory.agents.filter((a) => a.pane_id === journal.pane);
    if (occupants.some((a) => !runtime.matches(a, owner, journal))) throw new ExecutionError('foreign_occupant');
    if (!occupants.length) {
      if (processState(owner.process) === 'alive') throw new ExecutionError('process_not_detached');
      continue;
    }
    const key = `quit:${contract.slot}`;
    if (!cleanup.steps[key]) {
      // Exact live session/pane is checked again immediately before the mutating call.
      await runtime.owner(contract, journal);
      cleanup.steps[key] = 'sent';
      persist();
      const out = await runtime.call(['agent', 'prompt', journal.name, '/quit']);
      if (out.ok) {
        cleanup.steps[key] = 'acked';
        persist();
      }
    }
  }
  const graceEnd = new Deadline(Math.min(graceMs, runtime.deadline.remaining()), runtime.deadline.signal);
  for (;;) {
    let active = false;
    for (const owner of owners.values()) {
      const state = processState(owner.process);
      if (state === 'unknown') throw new ExecutionError('process_unknown');
      if (state === 'alive') active = true;
    }
    if (!active) break;
    if (performance.now() >= graceEnd.end) break;
    await runtime.deadline.pause(Math.min(50, Math.max(1, graceEnd.end - performance.now())));
  }
  for (const { contract, journal } of slots) {
    const owner = owners.get(journal.name);
    if (!owner || processState(owner.process) === 'dead') continue;
    await runtime.owner(contract, journal);
    if (!commandMatches(owner, contract)) throw new ExecutionError('process_arguments_unknown');
    const key = `term:${contract.slot}`;
    if (!cleanup.steps[key]) {
      cleanup.steps[key] = 'sent';
      persist();
      // This is a rechecked PID signal, not an atomic OS handle. Never SIGKILL a pi workload.
      const now = readProcess(owner.process.pid);
      if (!now || !sameStamp(now.stamp, owner.process)) throw new ExecutionError('process_changed');
      process.kill(owner.process.pid, 'SIGTERM');
      cleanup.steps[key] = 'acked';
      persist();
    }
  }
  while ([...owners.values()].some((owner) => processState(owner.process) === 'alive')) await runtime.deadline.pause();
  for (const owner of owners.values())
    if (processState(owner.process) !== 'dead') throw new ExecutionError('process_still_running');
}
export async function cleanupHelper(runtime: Runtime, contract: SlotContract, journal: Journal): Promise<void> {
  if (contract.slot === 'primary') throw new ExecutionError('helper_ineligible');
  await runtime.admitted(async () => {
    const cleanup: Cleanup = { schema: 1, state: 'close_unresolved', remaining: [], steps: {} };
    const file = runtime.path(contract.slot, 'cleanup.json');
    await detach(
      runtime,
      [{ contract, journal }],
      cleanup,
      () => save(file, cleanup, contract.task_dir),
      DETACH_GRACE_MS
    );
    if ((await runtime.tab(journal)).agents.some((a) => a.pane_id === journal.pane))
      throw new ExecutionError('helper_still_attached');
    if (journal.nested_pane) {
      const inventory = await runtime.tab(journal);
      if (inventory.agents.some((a) => a.pane_id === journal.pane)) throw new ExecutionError('foreign_occupant');
      cleanup.steps.pane_close = 'sent';
      save(file, cleanup, contract.task_dir);
      const out = await runtime.call(['pane', 'close', journal.pane!]);
      if (!out.ok) throw new ExecutionError('pane_close_unknown');
      if ((await runtime.tab(journal)).panes.some((p) => p.pane_id === journal.pane))
        throw new ExecutionError('pane_still_present');
      cleanup.steps.pane_close = 'acked';
    }
    cleanup.state = 'closed';
    save(file, cleanup, contract.task_dir);
  });
}
export async function retireHelper(
  runtime: Runtime,
  contract: SlotContract,
  journal: Journal,
  graceMs = DETACH_GRACE_MS
): Promise<void> {
  if (contract.slot === 'primary') throw new ExecutionError('helper_ineligible');
  const owner = await runtime.owner(contract, journal);
  const inventory = await runtime.tab(journal);
  const agent = inventory.agents.find((a) => a.pane_id === journal.pane);
  if (!runtime.matches(agent, owner, journal) || agent?.agent_status !== 'idle')
    throw new ExecutionError('helper_busy');
  const cleanup: Cleanup = { schema: 1, state: 'close_unresolved', remaining: [], steps: {} };
  const file = runtime.path(contract.slot, 'cleanup.json');
  await detach(runtime, [{ contract, journal }], cleanup, () => save(file, cleanup, contract.task_dir), graceMs);
  if ((await runtime.tab(journal)).agents.some((a) => a.pane_id === journal.pane))
    throw new ExecutionError('helper_still_attached');
  cleanup.state = 'closed';
  save(file, cleanup, contract.task_dir);
}
export async function reapOwned(context: ContractContext, options: ReapOptions): Promise<Cleanup> {
  const runtime = new Runtime(
    context,
    options,
    new Deadline(Math.min(options.budgetMs ?? REAP_BUDGET_MS, REAP_BUDGET_MS), options.signal)
  );
  const file = join(context.jobDirectory, '.dispatch/cleanup.json');
  let cleanup: Cleanup = { schema: 1, state: 'close_unresolved', remaining: [], steps: {} };
  try {
    return await locked(context.jobDirectory, 'resources', runtime.deadline, async () => {
      try {
        const binding = readRuntimeBinding(context.jobDirectory);
        if (
          JSON.stringify(binding.endpoint) !== JSON.stringify(options.endpoint) ||
          binding.callerTabId !== options.callerTabId
        )
          throw new ExecutionError('runtime_binding_changed');
        const control = runtime.control();
        if (!control.closing)
          save(
            join(context.jobDirectory, '.dispatch/control.json'),
            { closing: true, generation: control.generation + 1 },
            context.jobDirectory
          );
        cleanup = optionalJson<Cleanup>(file, context.jobDirectory) ?? cleanup;
        const persist = () => save(file, cleanup, context.jobDirectory);
        const journal = runtime.journal('primary');
        if (!journal) throw new ExecutionError('launch_missing');
        if ((await runtime.instance()) !== journal.instance || journal.tab === options.callerTabId)
          throw new ExecutionError('ownership_unknown');
        if (!journal.steps.tab || journal.steps.tab.state === 'intent') {
          cleanup.state = 'closed';
          cleanup.remaining = [];
          persist();
          return cleanup;
        }
        if (journal.steps.tab.state !== 'acked' || !journal.tab || !journal.left)
          throw new ExecutionError('tab_outcome_unknown');
        const tabs = (await runtime.query(['tab', 'list'])).tabs;
        if (!Array.isArray(tabs)) throw new ExecutionError('inventory_unknown');
        if (!tabs.some((t) => t && typeof t === 'object' && 'tab_id' in t && t.tab_id === journal.tab)) {
          if (
            cleanup.steps.tab_close &&
            cleanup.instance === journal.instance &&
            cleanup.tab === journal.tab &&
            cleanup.label === journal.label
          ) {
            cleanup.state = 'closed';
            cleanup.remaining = [];
            persist();
            return cleanup;
          }
          throw new ExecutionError('missing_tab_without_close_evidence');
        }
        await runtime.tab(journal);
        const slots: { contract: SlotContract; journal: Journal }[] = [];
        for (const name of fs.readdirSync(join(context.jobDirectory, '.dispatch'))) {
          if (!/^(primary|sonic-(?:[1-9]|10)|review-[1-3])$/.test(name)) continue;
          const j = runtime.journal(name);
          if (!j) continue;
          if (j.instance !== journal.instance || j.tab !== journal.tab) throw new ExecutionError('ownership_unknown');
          if (
            Object.entries(j.steps).some(
              ([key, step]) => (key === 'split' || key.startsWith('helper_split_')) && step.state === 'sent'
            )
          )
            throw new ExecutionError('split_outcome_unknown');
          const c = readSlotContract(slotPaths(context.jobDirectory, name).contract, context);
          slots.push({ contract: c, journal: j });
        }
        await detach(runtime, slots, cleanup, persist, Math.min(options.graceMs ?? DETACH_GRACE_MS, DETACH_GRACE_MS));
        const inventory = await runtime.tab(journal);
        const known = new Set(slots.flatMap((s) => [s.journal.left, s.journal.right, s.journal.pane]).filter(Boolean));
        if (inventory.agents.length || inventory.panes.some((p) => !known.has(String(p.pane_id))))
          throw new ExecutionError('foreign_occupant');
        // Fresh identity and complete inventory immediately before close, under the same fence/lock.
        const last = await runtime.tab(journal);
        if (last.agents.length || last.panes.some((p) => !known.has(String(p.pane_id))))
          throw new ExecutionError('foreign_occupant');
        cleanup.instance = journal.instance;
        cleanup.tab = journal.tab;
        cleanup.label = journal.label;
        if (!cleanup.steps.tab_close) {
          cleanup.steps.tab_close = 'sent';
          persist();
          const out = await runtime.call(['tab', 'close', journal.tab]);
          if (out.ok) {
            cleanup.steps.tab_close = 'acked';
            persist();
          }
        }
        const after = (await runtime.query(['tab', 'list'])).tabs;
        if (
          !Array.isArray(after) ||
          after.some((t) => t && typeof t === 'object' && 'tab_id' in t && t.tab_id === journal.tab)
        )
          throw new ExecutionError('tab_still_present');
        cleanup.state = 'closed';
        cleanup.remaining = [];
        persist();
        return cleanup;
      } catch (error) {
        cleanup.state = 'close_unresolved';
        cleanup.remaining = [error instanceof Error ? error.message : 'unknown'];
        save(file, cleanup, context.jobDirectory);
        return cleanup;
      }
    });
  } catch (error) {
    cleanup.state = 'close_unresolved';
    cleanup.remaining = [error instanceof Error ? error.message : 'unknown'];
    // If admission/ownership failed, do not become a competing evidence writer outside the lock.
    return cleanup;
  }
}
