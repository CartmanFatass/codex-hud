/** In-process helper calls; the worker adapter owns STATUS, not this controller. */
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseDispatchStatus } from '../pi-dispatch-status.js';
import { writePrivate } from '../job-store.js';
import {
  CONTRACT_MAX_BYTES,
  readOwnedText,
  readSlotContract,
  roleResource,
  slotPaths,
  type ContractContext,
  type SlotContract,
} from './contracts.js';
import { reserveHelper } from './lifecycle.js';
import { LAUNCH_BUDGET_MS, newJournal, persistContract, preflightOwned, projectSession, startSlot } from './launch.js';
import { cleanupHelper, retireHelper } from './reap.js';
import {
  Deadline,
  ExecutionError,
  Runtime,
  locked,
  optionalJson,
  save,
  type Journal,
  type RuntimeOptions,
  type Owner,
  sameStamp,
  readRuntimeBinding,
} from './runtime.js';

export const SONIC_BUDGET_MS = 45 * 60_000;
export const REVIEW_BUDGET_MS = 90 * 60_000;
interface Current {
  kind: 'sonic' | 'review';
  n: number;
  slot: string;
  status_file: string;
  state: 'reserved' | 'complete' | 'failed';
  unresolved_child?: string;
}
export interface HelperOptions extends RuntimeOptions {
  callerSlot?: string;
  /** PR3 writes waiting_helper via its single-writer STATUS publisher, before any reservation effect. */
  waitingHelper(pending: { kind: string; n: number; status_file: string } | null): Promise<void>;
}
export interface HelperRequest {
  kind: 'sonic' | 'reviewer';
  brief_path?: string;
  thinking?: 'low' | 'high';
}
export interface HelperResult {
  ok: boolean;
  path?: string;
  text?: string;
  reason?: string;
  n?: number;
}
function boundedResult(text: string): string {
  const bytes = Buffer.from(text.split('\n').slice(0, 2000).join('\n')).subarray(0, 50 * 1024);
  // Do not turn a truncated UTF-8 code point into a replacement character that exceeds the byte cap.
  for (let end = bytes.length; end >= Math.max(0, bytes.length - 3); end--) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      /* incomplete trailing code point */
    }
  }
  return '';
}
function signature(path: string, directory: string): string | null {
  if (!fs.existsSync(path)) return null;
  const text = readOwnedText(path, 1024 * 1024, directory);
  return text.trim() ? createHash('sha256').update(text).digest('hex') : null;
}
function counts(directory: string) {
  let sonicCalls = 0;
  let reviewRounds = 0;
  for (const name of fs.readdirSync(directory)) {
    const sonic = /^(?:sonic_brief-|sonic-)([1-9][0-9]*)\.md$/.exec(name);
    const review = /^(?:review_brief-|review-)([1-9][0-9]*)\.md$/.exec(name);
    if (sonic) sonicCalls = Math.max(sonicCalls, Number(sonic[1]));
    if (review) reviewRounds = Math.max(reviewRounds, Number(review[1]));
  }
  return { sonicCalls, reviewRounds };
}
async function rightPane(runtime: Runtime, parent: Journal): Promise<string> {
  return runtime
    .admitted(async () => {
      const inventory = await runtime.tab(parent);
      if (parent.right && inventory.panes.some((p) => p.pane_id === parent.right)) {
        const occupants = inventory.agents.filter((a) => a.pane_id === parent.right);
        if (!occupants.length) return parent.right;
        if (occupants.length !== 1) throw new ExecutionError('foreign_occupant');
        // Only an exact previously recorded own idle helper can be retired.
        for (const name of fs.readdirSync(join(runtime.context.jobDirectory, '.dispatch'))) {
          if (!/^(sonic-(?:[1-9]|10)|review-[1-3])$/.test(name)) continue;
          const j = runtime.journal(name);
          if (!j || j.pane !== parent.right || j.name !== occupants[0]!.name) continue;
          const c = readSlotContract(slotPaths(runtime.context.jobDirectory, name).contract, runtime.context);
          await retireHelper(runtime, c, j);
          return parent.right;
        }
        throw new ExecutionError('foreign_occupant');
      }
      return ''; // Split below, outside this lock's scope (effect reacquires it).
    })
    .then(async (pane) => {
      if (pane) return pane;
      const key = `helper_split_${Object.keys(parent.steps).filter((k) => k.startsWith('helper_split_')).length + 1}`;
      // A lost prior split reply must not allocate another one.
      if (Object.entries(parent.steps).some(([k, step]) => k.startsWith('helper_split_') && step.state !== 'acked'))
        throw new ExecutionError('split_outcome_unknown');
      const split = await runtime.effect(
        parent,
        key,
        [
          'pane',
          'split',
          parent.left!,
          '--direction',
          'right',
          '--ratio',
          '0.5',
          '--cwd',
          runtime.context.cwd,
          '--no-focus',
        ],
        15_000,
        async () => {
          await runtime.tab(parent);
        }
      );
      const raw = split.pane as { pane_id?: unknown } | undefined;
      if (typeof raw?.pane_id !== 'string') throw new ExecutionError('split_outcome_unknown');
      parent.right = raw.pane_id;
      await runtime.rememberPane(parent, parent.right);
      runtime.writeJournal(parent);
      projectSession(runtime, parent);
      return parent.right;
    });
}
export function reviewTaskText(directory: string, parent: SlotContract, base: string, n: number): string {
  return `Independently review the task and current changes against ${base}. Read ${parent.brief_path}, ${parent.output_path}, and ${join(directory, 'impl-notes.md')} if present.
Checks: do not rerun the full suites in any round; the orchestrator reruns the full gate at acceptance. Verify the implementer's logs in ${join(directory, 'checks')}/, each ending with exit=<code>.
Focused-check logs: a missing, failing, or older-than-the-newest-changed-file focused log counts as not run; rerun that focused check yourself.
${n === 1 ? 'Round 1: report missing, failing or stale full-suite evidence as a finding; never rerun those full suites. Run the focused tests for the changed code.' : `Round ${n}: stale full-suite logs after fixes are expected; note them, never rerun full suites. Re-check the previous findings in ${join(directory, `review-${n - 1}.md`)}. Run regression tests for earlier findings plus focused tests for files changed since the previous review.`}
Either round may run other focused or diagnostic checks needed to confirm or rule out a suspected defect, never full suites. Quote actual results. The first line of your report must be exactly Verdict: accept or Verdict: changes-required.`;
}
async function nestedPane(runtime: Runtime, caller: Journal, journal: Journal): Promise<string> {
  journal.nested_pane = true;
  journal.parent_slot = caller.slot;
  delete journal.pane;
  runtime.writeJournal(journal); // Own journal exists before split intent, including a lost reply.
  const split = await runtime.effect(
    journal,
    'split',
    [
      'pane',
      'split',
      caller.pane!,
      '--direction',
      'down',
      '--ratio',
      '0.5',
      '--cwd',
      runtime.context.cwd,
      '--no-focus',
    ],
    15_000,
    async () => {
      await runtime.tab(caller);
    }
  );
  if (!split.pane || typeof (split.pane as Record<string, unknown>).pane_id !== 'string')
    throw new ExecutionError('split_outcome_unknown');
  journal.pane = (split.pane as { pane_id: string }).pane_id;
  await runtime.rememberPane(journal, journal.pane);
  runtime.writeJournal(journal);
  return journal.pane;
}
/** A helper reviewer borrows only its verified, still-held primary reservation. */
async function verifyBorrow(runtime: Runtime, caller: SlotContract, primary: Journal): Promise<void> {
  const outer = optionalJson<Current>(join(caller.task_dir, '.dispatch/current.json'), caller.task_dir);
  const lock = optionalJson<{ process: Owner['process'] }>(
    join(caller.task_dir, '.dispatch/helper.lock'),
    caller.task_dir
  );
  const primaryContract = readSlotContract(slotPaths(caller.task_dir, 'primary').contract, runtime.context);
  const owner = await runtime.owner(primaryContract, primary);
  if (
    caller.role !== 'reviewer' ||
    outer?.state !== 'reserved' ||
    outer.slot !== caller.slot ||
    outer.kind !== 'review' ||
    !lock ||
    !sameStamp(lock.process, owner.process)
  )
    throw new ExecutionError('helper_reservation_invalid');
}
/** A returning/crashed reviewer may not release its borrowed child lane first. */
async function cleanupBorrowedChild(
  runtime: Runtime,
  parent: SlotContract,
  outer: Current,
  outerFile: string
): Promise<void> {
  if (parent.role !== 'reviewer' || !/^review-[1-3]$/.test(parent.slot)) return;
  let childSlot = `${parent.slot}/unknown`;
  try {
    const file = runtime.path(parent.slot, 'current.json');
    const child = optionalJson<Current>(file, parent.task_dir);
    if (!child) {
      // A missing marker with a recorded child is unknown, not permission to release.
      for (const name of fs.readdirSync(join(parent.task_dir, '.dispatch'))) {
        if (/^sonic-(?:[1-9]|10)$/.test(name) && runtime.journal(name)?.parent_slot === parent.slot) {
          childSlot = name;
          throw new ExecutionError('child_reservation_unknown');
        }
      }
      return;
    }
    if (typeof child.slot !== 'string' || !/^sonic-(?:[1-9]|10)$/.test(child.slot))
      throw new ExecutionError('child_reservation_unknown');
    childSlot = child.slot;
    if (
      child.kind !== 'sonic' ||
      !Number.isSafeInteger(child.n) ||
      child.n < 1 ||
      child.n > 10 ||
      child.slot !== `sonic-${child.n}` ||
      child.status_file !== runtime.path(child.slot, 'STATUS.json') ||
      !['reserved', 'complete', 'failed'].includes(child.state)
    )
      throw new ExecutionError('child_reservation_unknown');
    if (child.state !== 'reserved') return;
    const journal = runtime.journal(child.slot);
    const contract = readSlotContract(slotPaths(parent.task_dir, child.slot).contract, runtime.context);
    if (
      !journal ||
      journal.slot !== child.slot ||
      typeof journal.pane !== 'string' ||
      journal.steps.split?.state !== 'acked' ||
      journal.parent_slot !== parent.slot ||
      contract.parent_slot !== parent.slot ||
      contract.role !== 'sonic' ||
      !journal.nested_pane
    )
      throw new ExecutionError('child_reservation_unknown');
    await cleanupHelper(runtime, contract, journal);
    child.state = 'failed';
    save(file, child, parent.task_dir);
  } catch {
    outer.unresolved_child = childSlot;
    save(outerFile, outer, parent.task_dir);
    throw new ExecutionError(`helper_unresolved:${childSlot}`);
  }
}
export async function callHelper(
  context: ContractContext,
  options: HelperOptions,
  request: HelperRequest
): Promise<HelperResult> {
  const ceiling = request.kind === 'sonic' ? SONIC_BUDGET_MS : REVIEW_BUDGET_MS;
  const runtime = new Runtime(
    context,
    options,
    new Deadline(Math.min(options.budgetMs ?? ceiling, ceiling), options.signal)
  );
  let n: number | undefined;
  try {
    const binding = readRuntimeBinding(context.jobDirectory);
    if (
      JSON.stringify(binding.endpoint) !== JSON.stringify(options.endpoint) ||
      binding.callerTabId !== options.callerTabId
    )
      throw new ExecutionError('runtime_binding_changed');
    const callerSlot = options.callerSlot ?? 'primary';
    const borrowed = /^review-[1-3]$/.test(callerSlot) && request.kind === 'sonic';
    return await locked(context.jobDirectory, borrowed ? 'child-helper' : 'helper', runtime.deadline, async () => {
      let published = false;
      try {
        const parent = readSlotContract(slotPaths(context.jobDirectory, callerSlot).contract, context);
        if (
          parent.role === 'sonic' ||
          (request.kind === 'reviewer' && (parent.role !== 'implementer' || parent.slot !== 'primary'))
        )
          throw new ExecutionError('helper_ineligible');
        const rootContract = readSlotContract(slotPaths(context.jobDirectory, 'primary').contract, context);
        const primary = runtime.journal('primary');
        if (!primary || primary.steps.prompt?.state !== 'acked') throw new ExecutionError('primary_not_ready');
        const caller = runtime.journal(callerSlot);
        if (!caller || caller.steps.prompt?.state !== 'acked') throw new ExecutionError('caller_not_ready');
        await runtime.owner(parent, caller);
        if (borrowed) await verifyBorrow(runtime, parent, primary);
        const currentFile = borrowed
          ? runtime.path(callerSlot, 'current.json')
          : join(context.jobDirectory, '.dispatch/current.json');
        const previous = optionalJson<Current>(currentFile, context.jobDirectory);
        if (previous?.state === 'reserved' && previous.unresolved_child)
          throw new ExecutionError(`helper_unresolved:${previous.unresolved_child}`);
        const state = reserveHelper(parent.role, parent.slot, request.kind, {
          ...counts(context.jobDirectory),
          active: previous?.state === 'reserved',
        });
        n = request.kind === 'sonic' ? state.sonicCalls : state.reviewRounds;
        const kind = request.kind === 'sonic' ? 'sonic' : 'review';
        const slot = `${kind}-${n}`;
        const paths = slotPaths(context.jobDirectory, slot);
        let task: string;
        if (request.kind === 'sonic') {
          if (!request.brief_path || (request.thinking !== undefined && !['low', 'high'].includes(request.thinking)))
            throw new ExecutionError('invalid_request');
          task = readOwnedText(request.brief_path, CONTRACT_MAX_BYTES);
        } else task = reviewTaskText(context.jobDirectory, parent, primary.base ?? 'HEAD', n);
        published = true;
        await options.waitingHelper({ kind, n, status_file: runtime.path(slot, 'STATUS.json') });
        const current: Current = { kind, n, slot, status_file: runtime.path(slot, 'STATUS.json'), state: 'reserved' };
        // Exclusive reservation consumes the number even if any later stage fails.
        fs.writeFileSync(
          paths.brief,
          `# ${request.kind} ${n}\n\n${task}\n\nAuthoritative artifact: ${paths.output}\nWrite only that report path for your result.\n`,
          { flag: 'wx', mode: 0o600 }
        );
        save(currentFile, current, context.jobDirectory);
        if (request.kind === 'sonic') writePrivate(join(context.jobDirectory, `sonic-q-${n}.md`), task);
        const binding = rootContract.helpers![request.kind];
        const c: SlotContract = {
          ...parent,
          slot,
          role: request.kind,
          brief_path: paths.brief,
          output_path: paths.output,
          session_id: randomUUID(),
          model: binding.model,
          effort: request.thinking ?? binding.effort,
          role_resource: {
            path: join(context.release.root, roleResource(request.kind)),
            sha256: context.release.resources[roleResource(request.kind)]!,
          },
          allowed_write_paths: [paths.output],
          parent_slot: parent.slot,
          ...(request.kind === 'sonic' ? { read_only: parent.role === 'reviewer' || parent.role === 'architect' } : {}),
        };
        delete c.helpers;
        persistContract(c, context);
        const before = signature(paths.output, context.jobDirectory);
        let j: Journal | undefined;
        let cleanupRuntime: Runtime | undefined;
        const cleanup = () =>
          (cleanupRuntime ??= new Runtime(context, { ...options, signal: undefined }, new Deadline(180_000)));
        let childCleanup: Promise<void> | undefined;
        // One shared bounded cleanup phase; a lost child outcome is never retried here.
        const drainChild = () => (childCleanup ??= cleanupBorrowedChild(cleanup(), c, current, currentFile));
        try {
          const launchRuntime = new Runtime(
            context,
            options,
            new Deadline(Math.min(LAUNCH_BUDGET_MS, runtime.deadline.remaining()), options.signal)
          );
          await preflightOwned(launchRuntime, c, options);
          j = await newJournal(launchRuntime, c, primary);
          j.parent_slot = parent.slot;
          const pane =
            parent.role === 'implementer'
              ? await rightPane(launchRuntime, primary)
              : await nestedPane(launchRuntime, caller, j);
          j.pane = pane;
          launchRuntime.writeJournal(j);
          await startSlot(launchRuntime, c, j);
          for (;;) {
            runtime.deadline.remaining();
            if (runtime.control().closing) throw new ExecutionError('closing');
            const raw = optionalJson<unknown>(runtime.path(slot, 'STATUS.json'), context.jobDirectory);
            const status = parseDispatchStatus(raw, context.jobDirectory, slot, c.role, paths.output);
            if (status?.session_id === c.session_id && (status.model !== c.model || status.thinking !== c.effort))
              throw new ExecutionError('helper_binding_mismatch');
            if (status?.session_id === c.session_id && status.state === 'failed')
              throw new ExecutionError('helper_failed');
            if (status?.session_id === c.session_id && status.state === 'closed') {
              await drainChild();
              const after = signature(paths.output, context.jobDirectory);
              if (!status.output_written || !status.settled_at || status.error || !after || after === before)
                throw new ExecutionError('artifact_unsettled');
              const text = readOwnedText(paths.output, 1024 * 1024, context.jobDirectory);
              if (request.kind === 'reviewer' && !/^Verdict: (accept|changes-required)\r?$/.test(text.split('\n')[0]!))
                throw new ExecutionError('invalid_verdict');
              if (j.nested_pane) await cleanupHelper(cleanup(), c, j);
              current.state = 'complete';
              save(currentFile, current, context.jobDirectory);
              return { ok: true, n, path: paths.output, text: boundedResult(text) };
            }
            await runtime.deadline.pause(50);
          }
        } catch (error) {
          await drainChild(); // A rejection keeps the outer reservation inspect/reap-only.
          // Separate bounded cleanup phase, including immediate cancellation of an active helper.
          // If ownership cannot be proven, keep the reservation inspect/cleanup-only across restart.
          const ambiguousSplit =
            j && Object.entries(j.steps).some(([key, step]) => key === 'split' && step.state === 'sent');
          if (ambiguousSplit) {
            // Keep the reservation inspect-only. A lost nested split is never replaced.
          } else if (!j || (!j.steps.start && !j.nested_pane)) {
            current.state = 'failed';
            save(currentFile, current, context.jobDirectory);
          } else {
            try {
              await cleanupHelper(cleanup(), c, j);
              current.state = 'failed';
              save(currentFile, current, context.jobDirectory);
            } catch {
              /* Closing/ambiguous resources remain for the shared explicit reaper. */
            }
          }
          throw error;
        }
      } finally {
        if (published) await options.waitingHelper(null);
      }
    });
  } catch (error) {
    return { ok: false, n, reason: error instanceof Error ? error.message : 'unknown' };
  }
}
