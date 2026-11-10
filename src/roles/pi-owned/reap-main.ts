/** One finite post-exit adapter. Never a daemon, retry loop, or helper tab owner. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDispatchStatus, type DispatchStatus } from '../pi-dispatch-status.js';
import { readOwnedText, readSlotContract, slotPaths, type ContractContext, type SlotContract } from './contracts.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import {
  Deadline,
  Runtime,
  locked,
  optionalJson,
  processState,
  sameStamp,
  save,
  type Owner,
  type RuntimeOptions,
} from './runtime.js';
import { reapOwned, REAP_BUDGET_MS, type Cleanup } from './reap.js';
import { loadWorkerRelease } from './release.js';
import { readRuntimeBinding } from './runtime.js';

export interface ReaperRequest {
  context: Omit<ContractContext, 'release'> & { release: { id: string; root: string } };
  endpoint: RuntimeOptions['endpoint'];
  callerTabId: string;
  primary: ProcessStamp;
  /** Test/embedding may shorten the finite ceilings only. */
  waitMs?: number;
  budgetMs?: number;
}
export function autocloseEligible(
  c: Pick<SlotContract, 'slot' | 'role' | 'session_id'>,
  status: DispatchStatus | null
): boolean {
  return (
    c.slot === 'primary' &&
    status?.session_id === c.session_id &&
    status.state === 'closed' &&
    status.output_written &&
    !!status.settled_at &&
    !status.error &&
    (c.role !== 'implementer' || status.exit_reason === 'idle_grace_expired')
  );
}
export async function runPostExitReaper(request: ReaperRequest, env: NodeJS.ProcessEnv): Promise<Cleanup> {
  const deadline = new Deadline(Math.min(request.budgetMs ?? REAP_BUDGET_MS, REAP_BUDGET_MS));
  const unresolved = (reason: string): Cleanup => ({
    schema: 1,
    state: 'close_unresolved',
    remaining: [reason],
    steps: {},
  });
  try {
    const release = await loadWorkerRelease();
    if (request.context.release.id !== release.id || request.context.release.root !== release.root)
      return unresolved('release_unavailable');
    const context: ContractContext = { ...request.context, release };
    const options = { ...readRuntimeBinding(context.jobDirectory), env };
    const runtime = new Runtime(context, options, deadline);
    const c = readSlotContract(slotPaths(context.jobDirectory, 'primary').contract, context);
    if (c.slot !== 'primary') return unresolved('autoclose_ineligible');
    const owner = optionalJson<Owner>(runtime.path('primary', 'owner.json'), c.task_dir);
    if (!owner || !sameStamp(owner.process, request.primary)) return unresolved('primary_changed');
    const raw = optionalJson<unknown>(join(c.task_dir, 'STATUS.json'), c.task_dir);
    const status = parseDispatchStatus(raw, c.task_dir, c.slot, c.role, c.output_path);
    if (!autocloseEligible(c, status)) return unresolved('autoclose_ineligible');
    const waitEnd = performance.now() + Math.min(30_000, request.waitMs ?? 30_000, deadline.remaining());
    while (processState(request.primary) === 'alive' && performance.now() < waitEnd)
      await deadline.pause(Math.min(50, Math.max(1, waitEnd - performance.now())));
    if (processState(request.primary) !== 'dead') return unresolved('primary_not_exited');
    return reapOwned(context, { ...options, budgetMs: deadline.remaining() });
  } catch (error) {
    return unresolved(error instanceof Error ? error.message : 'unknown');
  }
}
/** PR3 calls only after successful settlement of a one-shot primary. At most one detached attempt. */
export async function spawnPostExitReaper(
  context: ContractContext,
  options: RuntimeOptions & { keepTab?: boolean }
): Promise<boolean> {
  if (options.keepTab) return false;
  const release = await loadWorkerRelease();
  if (context.release.id !== release.id || context.release.root !== release.root)
    throw new Error('release_unavailable');
  context = { ...context, release };
  options = { ...options, ...readRuntimeBinding(context.jobDirectory) };
  const runtime = new Runtime(context, options, new Deadline(15_000, options.signal));
  return locked(context.jobDirectory, 'resources', runtime.deadline, async () => {
    if (runtime.control().closing) return false;
    const c = readSlotContract(slotPaths(context.jobDirectory, 'primary').contract, context);
    if (c.slot !== 'primary') return false;
    const rawStatus = optionalJson<unknown>(join(c.task_dir, 'STATUS.json'), c.task_dir);
    const status = parseDispatchStatus(rawStatus, c.task_dir, c.slot, c.role, c.output_path);
    if (!autocloseEligible(c, status)) return false;
    const j = runtime.journal('primary');
    if (!j) return false;
    const owner = await runtime.owner(c, j);
    const relativeEntry = 'dist/roles/pi-owned/reap-main.js';
    const entry = join(c.release.root, relativeEntry);
    const hash = context.release.resources[relativeEntry];
    if (
      !hash ||
      createHash('sha256')
        .update(readOwnedText(entry, 256 * 1024))
        .digest('hex') !== hash
    )
      throw new Error('release_unavailable');
    const marker = runtime.path('primary', 'autoclose.json');
    if (optionalJson(marker, c.task_dir)) return false;
    const request: ReaperRequest = {
      context: {
        jobDirectory: context.jobDirectory,
        cwd: context.cwd,
        release: { id: release.id, root: release.root },
      },
      endpoint: options.endpoint,
      callerTabId: options.callerTabId,
      primary: owner.process,
    };
    // Intent precedes spawn; a lost spawn outcome never causes a second process.
    save(marker, { attempted: true, primary: owner.process }, c.task_dir);
    const child = spawn(
      process.execPath,
      [entry, '--owned-reap', Buffer.from(JSON.stringify(request)).toString('base64url')],
      {
        detached: true,
        stdio: 'ignore',
        env: runtime.env,
      }
    );
    child.once('error', () => {
      /* Intent remains: finite best effort, no retry. */
    });
    child.unref();
    return true;
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let request: ReaperRequest | undefined;
  try {
    if (process.argv[2] === '--owned-reap')
      request = JSON.parse(Buffer.from(process.argv[3] ?? '', 'base64url').toString('utf8')) as ReaperRequest;
  } catch {
    /* invalid invocation */
  }
  if (!request) process.exitCode = 2;
  else {
    const result = await runPostExitReaper(request, process.env);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.state === 'closed' ? 0 : 1;
  }
}
