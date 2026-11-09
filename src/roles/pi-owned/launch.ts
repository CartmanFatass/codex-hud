/** Owned launch transaction. Journals record uncertainty; they are never retry queues. */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readProcess, processState } from '../../core/run/process.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import { writePrivate } from '../job-store.js';
import {
  herdrResult,
  listedAgents,
  listedPanes,
  listedTabs,
  runHerdr,
  runCommand,
  tabIds,
  type HerdrOutcome,
} from '../herdr-run.js';
import { buildWorkerArgv } from './argv.js';
import {
  assertPath,
  CONTRACT_MAX_BYTES,
  readOwnedText,
  readSlotContract,
  record,
  singleLine,
  slotPaths,
  type ContractContext,
  type SlotContract,
} from './contracts.js';
import { submitPrompt } from './prompt.js';
import { DatabaseSync } from 'node:sqlite';
import { CliHerdrTransport } from '../../integrations/herdr/transport.js';

export const LAUNCH_BUDGET_MS = 300_000;
export const REAP_BUDGET_MS = 180_000;
export const METADATA_BUDGET_MS = 15_000;
export type StepName = 'tab' | 'split' | 'start' | 'prompt' | 'enter';
export interface LaunchJournal {
  schema: 1;
  job: string;
  slot: string;
  session_id: string;
  instance: string;
  caller_tab: string;
  label: string;
  agent: string;
  launcher: ProcessStamp;
  tab: string | null;
  left: string | null;
  right: string | null;
  pane: string | null;
  prompt: string;
  base?: string;
  steps: Partial<Record<StepName, { state: 'sent' | 'acked'; outcome?: string }>>;
}
/** PR3 writes this before admitting a provider turn. The launcher never writes it. */
export interface WorkerOwner {
  schema: 1;
  ready: true;
  job: string;
  slot: string;
  role: string;
  session_id: string;
  session_file: string;
  model: string;
  effort: string;
  herdr_instance: string;
  agent: string;
  tab: string;
  pane: string;
  process: ProcessStamp;
}
export interface OwnedRuntime {
  context: ContractContext;
  endpoint: { socketPath: string; server: ProcessStamp };
  env: NodeJS.ProcessEnv;
  /** Validated outer facade request index; required before the first effect. */
  indexPath: string;
  /** Caller tab is protected even if herdr returns it from a create. */
  callerTab: string;
  signal?: AbortSignal;
  /** Shorter budgets are useful for callers and synthetic tests; never extend ceilings. */
  budgetMs?: number;
}
export class OwnedOperationError extends Error {
  constructor(
    readonly code:
      'launch_unknown' | 'close_unresolved' | 'closing' | 'aborted' | 'deadline' | 'helper_busy' | 'helper_failed',
    detail = ''
  ) {
    super(`${code}${detail ? ': ' + detail : ''}`);
  }
}
export class Deadline {
  readonly end: number;
  constructor(ceiling: number, requested = ceiling) {
    this.end = performance.now() + Math.max(0, Math.min(ceiling, requested));
  }
  remaining(cap = Infinity): number {
    return Math.max(0, Math.min(cap, this.end - performance.now()));
  }
  check(signal?: AbortSignal): void {
    if (signal?.aborted) throw new OwnedOperationError('aborted');
    if (this.remaining() <= 0) throw new OwnedOperationError('deadline');
  }
}
/** Bound injected/metadata promises too; always dispose the race's timer and abort listener. */
export async function bounded<T>(
  promise: Promise<T>,
  deadline: Deadline,
  signal?: AbortSignal,
  cap = METADATA_BUDGET_MS
): Promise<T> {
  deadline.check(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(new OwnedOperationError('aborted'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new OwnedOperationError('deadline')), deadline.remaining(cap));
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
export function dispatchPath(directory: string, ...parts: string[]): string {
  return join(directory, '.dispatch', ...parts);
}
export function jsonRead(file: string, directory: string): any {
  return JSON.parse(readOwnedText(file, CONTRACT_MAX_BYTES, directory));
}
export function jsonWrite(file: string, value: unknown, directory: string): void {
  assertPath(file, directory);
  writePrivate(file, JSON.stringify(value) + '\n');
}
export function readJournal(contract: SlotContract): LaunchJournal | null {
  const file = dispatchPath(contract.task_dir, contract.slot, 'launch.json');
  if (!fs.existsSync(file)) return null;
  const j = jsonRead(file, contract.task_dir) as LaunchJournal;
  if (
    j.schema !== 1 ||
    j.job !== contract.job ||
    j.slot !== contract.slot ||
    j.session_id !== contract.session_id ||
    !singleLine(j.instance) ||
    !singleLine(j.label) ||
    !singleLine(j.agent) ||
    !singleLine(j.caller_tab) ||
    !record(j.steps)
  )
    throw new OwnedOperationError('launch_unknown', 'journal identity');
  return j;
}
export function saveJournal(contract: SlotContract, journal: LaunchJournal): void {
  jsonWrite(dispatchPath(contract.task_dir, contract.slot, 'launch.json'), journal, contract.task_dir);
}
export function closing(directory: string): boolean {
  const file = dispatchPath(directory, 'control.json');
  if (!fs.existsSync(file)) return false;
  const control = jsonRead(file, directory);
  if (control.schema !== 1 || typeof control.closing !== 'boolean' || !Number.isSafeInteger(control.generation))
    throw new OwnedOperationError('close_unresolved', 'control');
  return control.closing;
}
function stamp(value: unknown): value is ProcessStamp {
  return (
    record(value) &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 1 &&
    ['proc_start', 'boot_id', 'pid_domain'].every((k) => singleLine(value[k]))
  );
}
// Keep native lock handles rooted even if a caller awaits a promise whose resolver is lost.
const activeLocks = new Set<DatabaseSync>();
/** OS-backed process lock: crashed holders release it; no timestamp expiry or token unlink. */
export async function resourceLock<T>(
  directory: string,
  name: 'resource' | 'helper' | 'cleanup',
  deadline: Deadline,
  signal: AbortSignal | undefined,
  body: () => Promise<T>
): Promise<T> {
  const path = dispatchPath(directory, `${name}.lock`);
  assertPath(path, directory);
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(path, 'wx', 0o600);
    fs.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertPath(path, directory, true);
  const database = new DatabaseSync(path);
  activeLocks.add(database);
  let acquired = false;
  try {
    database.exec('PRAGMA busy_timeout=0');
    for (;;) {
      deadline.check(signal);
      try {
        database.exec('BEGIN EXCLUSIVE');
        acquired = true;
        break;
      } catch (error) {
        if (![5, 6].includes((error as { errcode: number }).errcode)) throw error;
      }
      await delay(Math.min(20, deadline.remaining()), undefined, { signal });
    }
    return await body();
  } finally {
    try {
      if (acquired) database.exec('ROLLBACK');
    } finally {
      database.close();
      activeLocks.delete(database);
    }
  }
}
export async function callHerdr(
  runtime: OwnedRuntime,
  deadline: Deadline,
  argv: readonly string[],
  cap = METADATA_BUDGET_MS
): Promise<HerdrOutcome> {
  deadline.check(runtime.signal);
  const env = { ...runtime.env, HERDR_SOCKET_PATH: runtime.endpoint.socketPath };
  delete (env as NodeJS.ProcessEnv).HERDR_SOCKET;
  return runHerdr(argv, env, { budgetMs: deadline.remaining(cap), signal: runtime.signal });
}
export async function instanceIdentity(runtime: OwnedRuntime, deadline: Deadline): Promise<string> {
  deadline.check(runtime.signal);
  const identity = await bounded(
    new CliHerdrTransport(runtime.endpoint.socketPath, runtime.env, 'herdr', 1500, runtime.endpoint.server).instance(),
    deadline,
    runtime.signal
  );
  deadline.check(runtime.signal);
  if (!identity) throw new OwnedOperationError('launch_unknown', 'herdr endpoint identity unavailable');
  return identity;
}
export async function inventory(runtime: OwnedRuntime, deadline: Deadline, journal: LaunchJournal) {
  if ((await instanceIdentity(runtime, deadline)) !== journal.instance)
    throw new OwnedOperationError('launch_unknown', 'herdr instance changed');
  // Sequential calls spend one deadline; unknown inventory never means empty.
  const tabsOut = await callHerdr(runtime, deadline, ['tab', 'list']);
  const panesOut = await callHerdr(runtime, deadline, ['pane', 'list']);
  const agentsOut = await callHerdr(runtime, deadline, ['agent', 'list']);
  const tabs = tabsOut.ok ? listedTabs(tabsOut.stdout) : null;
  const panes = panesOut.ok ? listedPanes(panesOut.stdout) : null;
  const raw = agentsOut.ok ? herdrResult(agentsOut.stdout) : null;
  const agents = agentsOut.ok ? listedAgents(agentsOut.stdout) : null;
  if (panes?.some((p) => !p.tabId)) throw new OwnedOperationError('launch_unknown', 'inventory unreadable');
  if (
    !tabs ||
    !panes ||
    !agents ||
    !raw ||
    !Array.isArray(raw.agents) ||
    raw.agents.some((a) => !record(a) || typeof a.pane_id !== 'string' || typeof a.tab_id !== 'string')
  )
    throw new OwnedOperationError('launch_unknown', 'inventory unreadable');
  return { tabs, panes, agents: raw.agents as Record<string, unknown>[] };
}
export function ownedTab(j: LaunchJournal, tabs: { tabId: string; label: string | null }[]): boolean {
  return (
    !!j.tab &&
    j.tab !== j.caller_tab &&
    tabs.filter((t) => t.tabId === j.tab && t.label === j.label).length === 1 &&
    tabs.filter((t) => t.label === j.label).length === 1
  );
}
function sessionHeader(file: string, directory: string): unknown {
  assertPath(file, directory, true);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) return null;
    const buffer = Buffer.alloc(CONTRACT_MAX_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytes).indexOf(10);
    if (newline < 0) return null;
    return JSON.parse(buffer.subarray(0, newline).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}
export function readOwner(contract: SlotContract, j: LaunchJournal): WorkerOwner | null {
  try {
    const o = jsonRead(dispatchPath(contract.task_dir, contract.slot, 'owner.json'), contract.task_dir);
    if (
      o.schema !== 1 ||
      o.ready !== true ||
      o.job !== contract.job ||
      o.slot !== contract.slot ||
      o.role !== contract.role ||
      o.session_id !== contract.session_id ||
      o.model !== contract.model ||
      o.effort !== contract.effort ||
      o.herdr_instance !== j.instance ||
      o.agent !== j.agent ||
      o.tab !== j.tab ||
      o.pane !== j.pane ||
      !stamp(o.process) ||
      !singleLine(o.session_file)
    )
      return null;
    assertPath(o.session_file, contract.task_dir, true);
    if (!o.session_file.startsWith(contract.session_dir + '/')) return null;
    const header = sessionHeader(o.session_file, contract.task_dir);
    if (!record(header) || header.type !== 'session' || header.id !== contract.session_id) return null;
    return o as WorkerOwner;
  } catch {
    return null;
  }
}
export function matchesAgent(agent: Record<string, unknown>, o: WorkerOwner): boolean {
  const session = agent.agent_session;
  return (
    agent.name === o.agent &&
    agent.agent === 'pi' &&
    agent.tab_id === o.tab &&
    agent.pane_id === o.pane &&
    record(session) &&
    session.agent === 'pi' &&
    session.source === 'herdr:pi' &&
    ((session.kind === 'path' && session.value === o.session_file) ||
      (session.kind === 'id' && session.value === o.session_id)) &&
    (agent.pid === undefined || agent.pid === o.process.pid)
  );
}
export async function verifyWorker(
  runtime: OwnedRuntime,
  deadline: Deadline,
  c: SlotContract,
  j: LaunchJournal,
  requireAlive = true
): Promise<WorkerOwner> {
  const o = readOwner(c, j);
  if (!o || (requireAlive && processState(o.process) !== 'alive'))
    throw new OwnedOperationError('launch_unknown', 'startup owner');
  const list = await inventory(runtime, deadline, j);
  if (
    !ownedTab(j, list.tabs) ||
    !list.panes.some((p) => p.paneId === j.pane && p.tabId === j.tab) ||
    list.agents.filter((a) => a.pane_id === j.pane).length !== 1 ||
    !list.agents.some((a) => matchesAgent(a, o))
  )
    throw new OwnedOperationError('launch_unknown', 'worker identity');
  return o;
}
/** Run a single bounded side effect under the same lock as the durable close fence. */
export async function launchStep(
  runtime: OwnedRuntime,
  deadline: Deadline,
  c: SlotContract,
  name: StepName,
  argv: readonly string[],
  cap: number,
  acknowledge: (out: HerdrOutcome, j: LaunchJournal) => boolean,
  before?: (j: LaunchJournal) => Promise<void>
): Promise<HerdrOutcome | null> {
  return resourceLock(c.task_dir, 'resource', deadline, runtime.signal, async () => {
    if (closing(c.task_dir)) throw new OwnedOperationError('closing');
    const j = readJournal(c)!;
    if (j.steps[name]?.state === 'acked') return null;
    if (j.steps[name]) throw new OwnedOperationError('launch_unknown', `${name} already submitted`);
    if ((await instanceIdentity(runtime, deadline)) !== j.instance)
      throw new OwnedOperationError('launch_unknown', 'instance');
    await before?.(j);
    deadline.check(runtime.signal);
    j.steps[name] = { state: 'sent' };
    saveJournal(c, j);
    const out = await callHerdr(runtime, deadline, argv, cap);
    if (acknowledge(out, j)) j.steps[name] = { state: 'acked' };
    else j.steps[name]!.outcome ??= out.reason;
    saveJournal(c, j);
    return out;
  });
}
export function writeSession(c: SlotContract, j: LaunchJournal): void {
  if (c.slot !== 'primary') return;
  writePrivate(
    join(c.task_dir, 'SESSION.txt'),
    `TASK=${basename(c.task_dir)}\nTAB=${j.tab ?? ''}\nTAB_NAME=${j.label}\nLEFT=${j.left ?? ''}\nRIGHT=${j.right ?? ''}\nORCH=\nBASE=${j.base ?? 'HEAD'}\nPRIMARY=${j.agent}\n`
  );
}
function assertAdmission(runtime: OwnedRuntime, c: SlotContract): void {
  const home = dirname(dirname(c.task_dir));
  if (basename(dirname(c.task_dir)) !== 'jobs' || !singleLine(runtime.callerTab))
    throw new OwnedOperationError('launch_unknown', 'job root/caller');
  const receipt = jsonRead(join(c.task_dir, 'receipt.json'), c.task_dir);
  const index = jsonRead(runtime.indexPath, home);
  const association = jsonRead(join(home, 'assoc', `${c.job}.json`), home);
  if (receipt.job !== c.job || index.job !== c.job || association.job !== c.job || receipt.binding?.env_profile)
    throw new OwnedOperationError('launch_unknown', 'facade admission');
  if (!runtime.indexPath.startsWith(join(home, 'jobs', 'index') + '/'))
    throw new OwnedOperationError('launch_unknown', 'index path');
}
function requireExecutables(runtime: OwnedRuntime): void {
  for (const executable of ['herdr', 'pi']) {
    if (
      !(runtime.env.PATH ?? '')
        .split(':')
        .filter(Boolean)
        .some((directory) => {
          try {
            const path = join(directory, executable);
            fs.accessSync(path, fs.constants.X_OK);
            return fs.statSync(path).isFile();
          } catch {
            return false;
          }
        })
    )
      throw new OwnedOperationError('launch_unknown', `${executable} unavailable`);
  }
}
const integrationCache = new Map<string, { path: string; version: number }>();
export async function discoverIntegration(
  runtime: OwnedRuntime,
  deadline: Deadline
): Promise<{ path: string; version: number }> {
  const key = JSON.stringify([runtime.env.PATH, runtime.env.HOME, runtime.endpoint.socketPath]);
  let value = integrationCache.get(key);
  if (!value) {
    const out = await callHerdr(runtime, deadline, ['integration', 'status']);
    const parsed = out.ok ? herdrResult(out.stdout) : null;
    const rows = parsed?.integrations;
    const row = Array.isArray(rows) ? rows.find((r) => record(r) && r.id === 'pi' && r.status === 'current') : null;
    const match = out.ok ? /^\s*pi:\s*current\s*\(v(\d+)\)\s*\((.+)\)\s*$/m.exec(out.stdout) : null;
    if (record(row) && singleLine(row.path) && Number.isSafeInteger(row.version) && Number(row.version) > 0)
      value = { path: row.path, version: Number(row.version) };
    else if (match) value = { path: match[2], version: Number(match[1]) };
    if (!value) throw new Error('herdr_pi_integration_missing: herdr integration install pi');
    integrationCache.set(key, value);
  }
  const header = readOwnedText(value.path, 256 * 1024);
  if (
    !/HERDR_INTEGRATION_ID=pi\b/.test(header) ||
    !new RegExp(`HERDR_INTEGRATION_VERSION=${value.version}\\b`).test(header)
  )
    throw new Error('herdr_pi_integration_missing: herdr integration install pi');
  return { ...value };
}
export async function startSlot(runtime: OwnedRuntime, deadline: Deadline, c: SlotContract): Promise<WorkerOwner> {
  let j = readJournal(c)!;
  if (!j.pane) throw new OwnedOperationError('launch_unknown', 'missing pane');
  if (!j.steps.start) {
    if (
      fs.existsSync(dispatchPath(c.task_dir, c.slot, 'owner.json')) ||
      fs.readdirSync(c.session_dir).some((n) => n.includes(c.session_id))
    )
      throw new OwnedOperationError('launch_unknown', 'session collision');
    await launchStep(
      runtime,
      deadline,
      c,
      'start',
      buildWorkerArgv(c, j.agent, j.pane),
      30_000,
      (out) => out.ok,
      async (current) => {
        const list = await inventory(runtime, deadline, current);
        if (
          !ownedTab(current, list.tabs) ||
          !list.panes.some((p) => p.paneId === current.pane && p.tabId === current.tab) ||
          list.agents.some((a) => a.pane_id === current.pane || a.name === current.agent)
        )
          throw new OwnedOperationError('launch_unknown', 'occupied start pane');
      }
    );
  }
  // A lost start ack is reconciled solely from the exact startup evidence, never another start.
  while (!readOwner(c, readJournal(c)!)) {
    deadline.check(runtime.signal);
    await delay(Math.min(25, deadline.remaining()), undefined, { signal: runtime.signal });
  }
  j = readJournal(c)!;
  const owner = await verifyWorker(runtime, deadline, c, j);
  await resourceLock(c.task_dir, 'resource', deadline, runtime.signal, async () => {
    const current = readJournal(c)!;
    if (closing(c.task_dir)) throw new OwnedOperationError('closing');
    if (current.steps.start?.state !== 'acked') {
      current.steps.start = { state: 'acked' };
      saveJournal(c, current);
    }
  });
  await submitPrompt(runtime, deadline, c);
  return owner;
}
export async function launchOwned(
  runtime: OwnedRuntime
): Promise<{ state: 'acked' | 'launch_unknown'; journal: LaunchJournal | null; error?: string }> {
  const deadline = new Deadline(LAUNCH_BUDGET_MS, runtime.budgetMs);
  const c = readSlotContract(slotPaths(runtime.context.jobDirectory, 'primary').contract, runtime.context);
  try {
    assertAdmission(runtime, c);
    requireExecutables(runtime);
    const integration = await discoverIntegration(runtime, deadline);
    if (integration.path !== c.herdr_integration.path || integration.version !== c.herdr_integration.version)
      throw new Error('herdr_pi_integration_missing: pinned integration changed');
    fs.mkdirSync(c.session_dir, { recursive: true, mode: 0o700 });
    await resourceLock(c.task_dir, 'resource', deadline, runtime.signal, async () => {
      if (closing(c.task_dir)) throw new OwnedOperationError('closing');
      const existing = readJournal(c);
      if (existing) {
        if (existing.caller_tab !== runtime.callerTab)
          throw new OwnedOperationError('launch_unknown', 'caller changed');
        return;
      }
      const instance = await instanceIdentity(runtime, deadline);
      const launcher = readProcess(process.pid)?.stamp;
      if (!launcher) throw new OwnedOperationError('launch_unknown', 'launcher');
      const git = await runCommand('git', ['-C', c.cwd, 'rev-parse', 'HEAD'], runtime.env, {
        budgetMs: deadline.remaining(METADATA_BUDGET_MS),
        signal: runtime.signal,
      });
      const base = git.ok && /^[a-f0-9]{40,64}$/.test(git.stdout.trim()) ? git.stdout.trim() : 'HEAD';
      const nonce = randomUUID().replaceAll('-', '');
      saveJournal(c, {
        schema: 1,
        job: c.job,
        slot: c.slot,
        session_id: c.session_id,
        instance,
        caller_tab: runtime.callerTab,
        base,
        label: `hud-${c.job}-${nonce}`,
        agent: `hud-${c.job}-${nonce}-primary`,
        launcher,
        tab: null,
        left: null,
        right: null,
        pane: null,
        prompt: `Read ${c.brief_path} and do exactly what it asks.`,
        steps: {},
      });
    });
    let j = readJournal(c)!;
    await launchStep(
      runtime,
      deadline,
      c,
      'tab',
      ['tab', 'create', '--cwd', c.cwd, '--label', j.label, '--no-focus'],
      METADATA_BUDGET_MS,
      (out, current) => {
        const ids = out.ok ? tabIds(out.stdout) : null;
        if (!ids || ids.tabId === current.caller_tab) return false;
        current.tab = ids.tabId;
        current.left = ids.paneId;
        current.pane = ids.paneId;
        writeSession(c, current);
        return true;
      }
    );
    j = readJournal(c)!;
    if (j.steps.tab?.state !== 'acked') throw new OwnedOperationError('launch_unknown', 'tab unconfirmed');
    if (c.role === 'implementer')
      await launchStep(
        runtime,
        deadline,
        c,
        'split',
        ['pane', 'split', j.left!, '--direction', 'right', '--ratio', '0.5', '--cwd', c.cwd, '--no-focus'],
        METADATA_BUDGET_MS,
        (out, current) => {
          const r = out.ok ? herdrResult(out.stdout) : null;
          const pane = r && record(r.pane) ? r.pane : null;
          if (!pane || !singleLine(pane.pane_id) || pane.tab_id !== current.tab || pane.pane_id === current.left)
            return false;
          current.right = pane.pane_id;
          writeSession(c, current);
          return true;
        },
        async (current) => {
          const list = await inventory(runtime, deadline, current);
          if (!ownedTab(current, list.tabs)) throw new OwnedOperationError('launch_unknown', 'tab identity');
        }
      );
    if (c.role === 'implementer' && readJournal(c)!.steps.split?.state !== 'acked')
      throw new OwnedOperationError('launch_unknown', 'split unconfirmed');
    await startSlot(runtime, deadline, c);
    return { state: 'acked', journal: readJournal(c) };
  } catch (error) {
    return {
      state: 'launch_unknown',
      journal: readJournal(c),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
