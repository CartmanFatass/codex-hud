/** Single-helper worker API. The primary extension remains the sole primary STATUS writer. */
import * as fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseDispatchStatus } from '../pi-dispatch-status.js';
import {
  readSlotContract,
  readOwnedText,
  roleResource,
  slotPaths,
  validateSlotContract,
  type SlotContract,
} from './contracts.js';
import { reserveHelper } from './lifecycle.js';
import {
  callHerdr,
  closing,
  Deadline,
  dispatchPath,
  inventory,
  jsonRead,
  jsonWrite,
  launchStep,
  METADATA_BUDGET_MS,
  LAUNCH_BUDGET_MS,
  matchesAgent,
  OwnedOperationError,
  ownedTab,
  readJournal,
  readOwner,
  resourceLock,
  saveJournal,
  startSlot,
  writeSession,
  type LaunchJournal,
  type OwnedRuntime,
} from './launch.js';
import { retireHelper } from './reap.js';
import { herdrResult, isRecord } from '../herdr-run.js';

export interface HelperPending {
  kind: 'sonic' | 'review';
  n: number;
  status_file: string;
}
export interface HelperRuntime extends OwnedRuntime {
  /** Supplied by the active primary extension, never by model tool arguments. */
  primarySlot: string;
  onPending: (pending: HelperPending | null) => Promise<void>;
  helperBudgetMs?: number;
  cleanupBudgetMs?: number;
}
export type HelperRequest = { kind: 'sonic'; brief_path: string; thinking?: 'low' | 'high' } | { kind: 'reviewer' };
export interface HelperResult {
  slot: string;
  artifact_path: string;
  text: string;
  truncated: boolean;
  verdict?: 'accept' | 'changes-required';
}
function signature(file: string, directory: string): string | null {
  if (!fs.existsSync(file)) return null;
  const text = readOwnedText(file, 4 * 1024 * 1024, directory);
  return text.trim() ? createHash('sha256').update(text).digest('hex') : null;
}
function counts(directory: string): { sonicCalls: number; reviewRounds: number; active: boolean } {
  let sonicCalls = 0,
    reviewRounds = 0;
  for (const n of [...fs.readdirSync(directory), ...fs.readdirSync(dispatchPath(directory))]) {
    const sonic = /^sonic(?:_brief|-q)?-([1-9][0-9]*)(?:\.md)?$/.exec(n);
    const review = /^review(?:_brief)?-([1-9][0-9]*)(?:\.md)?$/.exec(n);
    if (sonic) sonicCalls = Math.max(sonicCalls, Number(sonic[1]));
    if (review) reviewRounds = Math.max(reviewRounds, Number(review[1]));
  }
  const currentPath = dispatchPath(directory, 'current.json');
  const current = fs.existsSync(currentPath) ? jsonRead(currentPath, directory) : null;
  return { sonicCalls, reviewRounds, active: !!current && current.state !== 'closed' };
}
async function rightPane(
  runtime: HelperRuntime,
  deadline: Deadline,
  c: SlotContract,
  primary: SlotContract
): Promise<void> {
  let parent = readJournal(primary)!;
  let list = await inventory(runtime, deadline, parent);
  if (!ownedTab(parent, list.tabs)) throw new OwnedOperationError('launch_unknown', 'helper tab');
  const pane = parent.right && list.panes.find((p) => p.paneId === parent.right && p.tabId === parent.tab);
  if (pane) {
    const occupants = list.agents.filter((a) => a.pane_id === parent.right);
    if (occupants.length) {
      if (occupants.length !== 1 || occupants[0].agent_status !== 'idle')
        throw new OwnedOperationError('helper_busy', 'right pane occupied');
      let previous: SlotContract | null = null;
      for (const slot of fs
        .readdirSync(dispatchPath(c.task_dir))
        .filter((n) => /^(?:sonic-(?:[1-9]|10)|review-[1-3])$/.test(n) && n !== c.slot)) {
        const candidate = readSlotContract(slotPaths(c.task_dir, slot).contract, runtime.context);
        const j = readJournal(candidate);
        const o = j && readOwner(candidate, j);
        if (o && o.pane === parent.right && o.agent === occupants[0].name && matchesAgent(occupants[0], o))
          previous = candidate;
      }
      if (!previous || !(await retireHelper(runtime, previous, Math.min(30_000, deadline.remaining()))))
        throw new OwnedOperationError('helper_busy', 'foreign helper');
    }
    await resourceLock(c.task_dir, 'resource', deadline, runtime.signal, async () => {
      if (closing(c.task_dir)) throw new OwnedOperationError('closing');
      const current = readJournal(c)!;
      current.pane = parent.right;
      current.right = parent.right;
      saveJournal(c, current);
    });
    return;
  }
  // An absent recorded pane allows one new split, recorded in this helper's own journal.
  await launchStep(
    runtime,
    deadline,
    c,
    'split',
    ['pane', 'split', parent.left!, '--direction', 'right', '--ratio', '0.5', '--cwd', c.cwd, '--no-focus'],
    METADATA_BUDGET_MS,
    (out, current) => {
      const r = out.ok ? herdrResult(out.stdout) : null;
      const pane = r && isRecord(r.pane) ? r.pane : null;
      if (!pane || typeof pane.pane_id !== 'string' || pane.tab_id !== current.tab) return false;
      current.pane = pane.pane_id;
      current.right = pane.pane_id;
      parent = readJournal(primary)!;
      parent.right = pane.pane_id;
      saveJournal(primary, parent);
      writeSession(primary, parent);
      return true;
    },
    async (current) => {
      list = await inventory(runtime, deadline, current);
      if (!ownedTab(current, list.tabs) || !list.panes.some((p) => p.paneId === parent.left && p.tabId === parent.tab))
        throw new OwnedOperationError('launch_unknown', 'split ownership');
    }
  );
}
export async function runHelper(runtime: HelperRuntime, request: HelperRequest): Promise<HelperResult> {
  const parent = readSlotContract(slotPaths(runtime.context.jobDirectory, 'primary').contract, runtime.context);
  // A helper cannot gain eligibility just because it received an implementer's contract path.
  if (runtime.primarySlot !== 'primary' || parent.role !== 'implementer') throw new Error('helper_ineligible');
  if (request.kind !== 'sonic' && request.kind !== 'reviewer') throw new Error('helper_ineligible');
  if (request.kind === 'sonic' && request.thinking !== undefined && !['low', 'high'].includes(request.thinking))
    throw new Error('invalid_contract: thinking');
  const deadline = new Deadline(request.kind === 'sonic' ? 45 * 60_000 : 90 * 60_000, runtime.helperBudgetMs);
  return resourceLock(parent.task_dir, 'helper', deadline, runtime.signal, async () => {
    let c: SlotContract | undefined;
    let complete = false;
    try {
      await resourceLock(parent.task_dir, 'resource', deadline, runtime.signal, async () => {
        if (closing(parent.task_dir)) throw new OwnedOperationError('closing');
        const state = reserveHelper(parent.role, runtime.primarySlot, request.kind, counts(parent.task_dir));
        const n = request.kind === 'sonic' ? state.sonicCalls : state.reviewRounds;
        const slot = `${request.kind === 'sonic' ? 'sonic' : 'review'}-${n}`;
        const paths = slotPaths(parent.task_dir, slot);
        const role = request.kind === 'sonic' ? 'sonic' : 'reviewer';
        const binding = parent.helpers![request.kind];
        const source = request.kind === 'sonic' ? readOwnedText(request.brief_path, 64 * 1024) : '';
        const wrapper =
          request.kind === 'sonic'
            ? `Read the request below and carry it out within the parent task's scope. Write your report only to ${paths.output}.\n\n${source}\n`
            : `Independently review the task changes against ${parent.brief_path}, implementation notes ${join(parent.task_dir, 'impl-notes.md')}, and prior numbered reviews in this job. Write only ${paths.output}. First line must be exactly Verdict: accept or Verdict: changes-required.\n`;
        fs.writeFileSync(paths.brief, wrapper, { flag: 'wx', mode: 0o600 });
        if (request.kind === 'sonic')
          fs.writeFileSync(join(parent.task_dir, `sonic-q-${n}.md`), source, { flag: 'wx', mode: 0o600 });
        const raw: SlotContract = {
          ...parent,
          slot,
          role,
          brief_path: paths.brief,
          output_path: paths.output,
          qa_dir: paths.qa,
          session_dir: paths.sessions,
          session_id: randomUUID(),
          role_resource: {
            path: join(parent.release.root, roleResource(role)),
            sha256: runtime.context.release.resources[roleResource(role)],
          },
          model: binding.model,
          effort: request.kind === 'sonic' ? (request.thinking ?? binding.effort) : binding.effort,
          allowed_write_paths: [paths.output],
        };
        delete raw.helpers;
        c = validateSlotContract(raw, runtime.context);
        jsonWrite(paths.contract, c, parent.task_dir);
        const primaryJournal = readJournal(parent);
        if (!primaryJournal || primaryJournal.steps.prompt?.state !== 'acked')
          throw new OwnedOperationError('launch_unknown', 'primary not ready');
        const journal: LaunchJournal = {
          ...primaryJournal,
          slot,
          session_id: c.session_id,
          agent: `hud-${c.job}-${randomUUID().replaceAll('-', '')}-${slot}`,
          pane: null,
          steps: {},
          prompt: `Read ${paths.brief} and do exactly what it asks.`,
        };
        saveJournal(c, journal);
        await runtime.onPending({
          kind: request.kind === 'sonic' ? 'sonic' : 'review',
          n,
          status_file: dispatchPath(parent.task_dir, slot, 'STATUS.json'),
        });
        jsonWrite(
          dispatchPath(parent.task_dir, 'current.json'),
          {
            schema: 1,
            slot,
            kind: request.kind,
            n,
            state: 'reserved',
            status_file: dispatchPath(parent.task_dir, slot, 'STATUS.json'),
          },
          parent.task_dir
        );
      });
      if (!c) throw new OwnedOperationError('helper_failed', 'reservation');
      const before = signature(c.output_path, c.task_dir);
      const launchDeadline = new Deadline(LAUNCH_BUDGET_MS, deadline.remaining());
      await rightPane(runtime, launchDeadline, c, parent);
      await startSlot(runtime, launchDeadline, c);
      for (;;) {
        deadline.check(runtime.signal);
        if (closing(c.task_dir)) throw new OwnedOperationError('closing');
        const path = dispatchPath(c.task_dir, c.slot, 'STATUS.json');
        if (fs.existsSync(path)) {
          const status = parseDispatchStatus(jsonRead(path, c.task_dir), c.task_dir, c.slot, c.role, c.output_path);
          if (!status || status.session_id !== c.session_id || status.model !== c.model || status.thinking !== c.effort)
            throw new OwnedOperationError('helper_failed', 'STATUS mismatch');
          if (status.state === 'failed')
            throw new OwnedOperationError('helper_failed', status.error ?? 'worker failed');
          if (status.state === 'closed') {
            const after = signature(c.output_path, c.task_dir);
            if (
              !status.output_written ||
              !after ||
              before === after ||
              !status.settled_at ||
              !status.ended_at ||
              status.error
            )
              throw new OwnedOperationError('helper_failed', 'artifact not settled/changed');
            const text = readOwnedText(c.output_path, 4 * 1024 * 1024, c.task_dir);
            const first = text.split(/\r?\n/)[0];
            const verdict =
              first === 'Verdict: accept'
                ? 'accept'
                : first === 'Verdict: changes-required'
                  ? 'changes-required'
                  : undefined;
            if (request.kind === 'reviewer' && !verdict)
              throw new OwnedOperationError('helper_failed', 'review verdict');
            const lines = text.split('\n').slice(0, 2000).join('\n');
            const bytes = Buffer.from(lines);
            let end = Math.min(bytes.length, 50 * 1024);
            while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
            const bounded = bytes.subarray(0, end).toString('utf8');
            complete = true;
            return {
              slot: c.slot,
              artifact_path: c.output_path,
              text: bounded,
              truncated: bounded !== text,
              ...(verdict ? { verdict } : {}),
            };
          }
        }
        await delay(Math.min(50, deadline.remaining()), undefined, { signal: runtime.signal });
      }
    } finally {
      if (c) {
        // Parent cancellation reaches the transport immediately; cleanup gets its own bounded budget.
        const cleanupRuntime = { ...runtime, signal: undefined };
        const cleaned = await retireHelper(cleanupRuntime, c, runtime.cleanupBudgetMs ?? 30_000);
        const currentPath = dispatchPath(parent.task_dir, 'current.json');
        const current = fs.existsSync(currentPath)
          ? jsonRead(currentPath, parent.task_dir)
          : { schema: 1, slot: c.slot };
        jsonWrite(
          dispatchPath(parent.task_dir, 'current.json'),
          { ...current, state: cleaned ? 'closed' : 'unresolved', success: complete },
          parent.task_dir
        );
        if (cleaned) await runtime.onPending(null);
      }
    }
  });
}
