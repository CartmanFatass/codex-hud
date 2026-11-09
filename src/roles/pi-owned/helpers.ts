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
} from './runtime.js';

export const SONIC_BUDGET_MS = 45 * 60_000;
export const REVIEW_BUDGET_MS = 90 * 60_000;
interface Current {
  kind: 'sonic' | 'review';
  n: number;
  slot: string;
  status_file: string;
  state: 'reserved' | 'complete' | 'failed';
}
export interface HelperOptions extends RuntimeOptions {
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
    return await locked(context.jobDirectory, 'helper', runtime.deadline, async () => {
      let published = false;
      try {
        const parent = readSlotContract(slotPaths(context.jobDirectory, 'primary').contract, context);
        if (parent.role !== 'implementer' || parent.slot !== 'primary') throw new ExecutionError('helper_ineligible');
        const primary = runtime.journal('primary');
        if (!primary || primary.steps.prompt?.state !== 'acked') throw new ExecutionError('primary_not_ready');
        await runtime.owner(parent, primary);
        const currentFile = join(context.jobDirectory, '.dispatch/current.json');
        const previous = optionalJson<Current>(currentFile, context.jobDirectory);
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
        } else
          task = `Independently review the task and current changes against ${primary.base ?? 'HEAD'}. Read ${parent.brief_path}, ${parent.output_path}, and ${join(context.jobDirectory, 'impl-notes.md')} if present.${n > 1 ? ` Re-check the previous findings in ${join(context.jobDirectory, `review-${n - 1}.md`)}.` : ''} The first line of your report must be exactly Verdict: accept or Verdict: changes-required.`;
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
        const binding = parent.helpers![request.kind];
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
        };
        delete c.helpers;
        persistContract(c, context);
        const before = signature(paths.output, context.jobDirectory);
        let j: Journal | undefined;
        try {
          const launchRuntime = new Runtime(
            context,
            options,
            new Deadline(Math.min(LAUNCH_BUDGET_MS, runtime.deadline.remaining()), options.signal)
          );
          await preflightOwned(launchRuntime, c, options);
          const pane = await rightPane(launchRuntime, primary);
          j = await newJournal(launchRuntime, c, primary);
          j.pane = pane;
          launchRuntime.writeJournal(j);
          await startSlot(launchRuntime, c, j);
          for (;;) {
            runtime.deadline.remaining();
            if (runtime.control().closing) throw new ExecutionError('closing');
            const raw = optionalJson<unknown>(runtime.path(slot, 'STATUS.json'), context.jobDirectory);
            const status = parseDispatchStatus(raw, context.jobDirectory, slot, c.role, paths.output);
            if (status?.session_id === c.session_id && status.state === 'failed')
              throw new ExecutionError('helper_failed');
            if (status?.session_id === c.session_id && status.state === 'closed') {
              const after = signature(paths.output, context.jobDirectory);
              if (!status.output_written || !status.settled_at || status.error || !after || after === before)
                throw new ExecutionError('artifact_unsettled');
              const text = readOwnedText(paths.output, 1024 * 1024, context.jobDirectory);
              if (request.kind === 'reviewer' && !/^Verdict: (accept|changes-required)\r?$/.test(text.split('\n')[0]!))
                throw new ExecutionError('invalid_verdict');
              current.state = 'complete';
              save(currentFile, current, context.jobDirectory);
              return { ok: true, n, path: paths.output, text: boundedResult(text) };
            }
            await runtime.deadline.pause(50);
          }
        } catch (error) {
          // Separate bounded cleanup phase, including immediate cancellation of an active helper.
          // If ownership cannot be proven, keep the reservation inspect/cleanup-only across restart.
          if (!j?.steps.start) {
            current.state = 'failed';
            save(currentFile, current, context.jobDirectory);
          } else {
            const cleanupRuntime = new Runtime(context, { ...options, signal: undefined }, new Deadline(180_000));
            try {
              await cleanupHelper(cleanupRuntime, c, j);
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
