/** Internal execution primitives. Not part of the passive dispatch import graph. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { CliHerdrTransport } from '../../integrations/herdr/transport.js';
import { processState, readProcess, sameStamp } from '../../core/run/process.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import { runHerdr, herdrResult, type HerdrOutcome } from '../herdr-run.js';
import { writePrivate } from '../job-store.js';
import { assertPath, readOwnedText, record, type ContractContext, type SlotContract } from './contracts.js';

export interface Endpoint {
  socketPath: string;
  server: ProcessStamp;
}
export interface RuntimeOptions {
  endpoint: Endpoint;
  env: NodeJS.ProcessEnv;
  callerTabId: string;
  signal?: AbortSignal;
  /** May shorten, never lengthen, the production operation ceiling. */
  budgetMs?: number;
}
export class ExecutionError extends Error {}
export class Deadline {
  readonly end: number;
  constructor(
    ms: number,
    readonly signal?: AbortSignal
  ) {
    if (!Number.isFinite(ms)) throw new ExecutionError('invalid_budget');
    this.end = performance.now() + Math.max(0, ms);
  }
  remaining(cap = Infinity): number {
    if (this.signal?.aborted) throw new ExecutionError('aborted');
    const ms = Math.min(cap, this.end - performance.now());
    if (ms <= 0) throw new ExecutionError('deadline');
    return ms;
  }
  async pause(ms = 50): Promise<void> {
    await delay(Math.min(ms, this.remaining()), undefined, { signal: this.signal });
  }
}
export function json<T>(file: string, directory: string): T | null {
  try {
    return JSON.parse(readOwnedText(file, 64 * 1024, directory)) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function save(file: string, value: unknown, directory: string): void {
  assertPath(file, directory);
  const text = JSON.stringify(value) + '\n';
  try {
    if (readOwnedText(file, 64 * 1024, directory) === text) return;
  } catch (error) {
    if (!String(error).includes('missing_path') && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writePrivate(file, text);
}
export function optionalJson<T>(file: string, directory: string): T | null {
  assertPath(file, directory);
  return fs.existsSync(file) ? json<T>(file, directory) : null;
}
export function selfStamp(): ProcessStamp {
  const stamp = readProcess(process.pid)?.stamp;
  if (!stamp) throw new ExecutionError('process_identity_unavailable');
  return stamp;
}
/** No age/heartbeat stealing. An unreadable token or invisible domain is not a dead owner. */
export async function locked<T>(
  directory: string,
  name: 'resources' | 'helper',
  deadline: Deadline,
  body: () => Promise<T>
): Promise<T> {
  const file = join(directory, '.dispatch', `${name}.lock`);
  assertPath(file, directory);
  fs.mkdirSync(join(directory, '.dispatch'), { recursive: true, mode: 0o700 });
  const token = JSON.stringify({ process: selfStamp(), nonce: randomUUID() });
  for (;;) {
    deadline.remaining();
    try {
      fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readOwnedText(file, 4096, directory);
    let parsed: { process?: ProcessStamp };
    try {
      parsed = JSON.parse(holder);
    } catch {
      throw new ExecutionError('lock_unknown');
    }
    if (!validStamp(parsed.process)) throw new ExecutionError('lock_unknown');
    const here = selfStamp();
    const previousBoot = parsed.process.pid_domain === here.pid_domain && parsed.process.boot_id !== here.boot_id;
    if (previousBoot || processState(parsed.process) === 'dead') {
      // One reclaimer per dead token. Keep the claim: a delayed contender must not
      // unlink a subsequent live lock after comparing the old holder. A crashed
      // reclaimer is inspect-only rather than permission to guess at another CAS.
      const claim = `${file}.reclaim-${createHash('sha256').update(holder).digest('hex')}`;
      try {
        fs.writeFileSync(claim, token, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (readOwnedText(file, 4096, directory) === holder) throw new ExecutionError('lock_reclaim_unknown');
        continue;
      }
      if (readOwnedText(file, 4096, directory) === holder) fs.unlinkSync(file);
      continue;
    }
    if (name === 'helper') throw new ExecutionError('helper_busy');
    await deadline.pause(20);
  }
  try {
    return await body();
  } finally {
    if (fs.existsSync(file) && readOwnedText(file, 4096, directory) === token) fs.unlinkSync(file);
  }
}
export function validStamp(raw: unknown): raw is ProcessStamp {
  return (
    record(raw) &&
    Number.isSafeInteger(raw.pid) &&
    Number(raw.pid) > 1 &&
    ['proc_start', 'boot_id', 'pid_domain'].every((k) => typeof raw[k] === 'string' && raw[k] !== '')
  );
}
export interface Step {
  state: 'intent' | 'sent' | 'acked';
  result?: Record<string, unknown>;
}
export interface Journal {
  schema: 1;
  job: string;
  slot: string;
  session_id: string;
  instance: string;
  launcher: ProcessStamp;
  label: string;
  name: string;
  tab?: string;
  left?: string;
  right?: string;
  pane?: string;
  base?: string;
  terminals: Record<string, string>;
  steps: Record<string, Step>;
  error?: string;
}
export interface Owner {
  schema: 1;
  job: string;
  slot: string;
  session_id: string;
  session_file: string;
  instance: string;
  tab_id: string;
  pane_id: string;
  agent_name: string;
  process: ProcessStamp;
  model: string;
  effort: string;
  ready: true;
}
export class Runtime {
  readonly env: NodeJS.ProcessEnv;
  private readonly transport: CliHerdrTransport;
  constructor(
    readonly context: ContractContext,
    readonly options: RuntimeOptions,
    readonly deadline: Deadline
  ) {
    this.env = { ...options.env, HERDR_SOCKET_PATH: options.endpoint.socketPath };
    delete this.env.HERDR_SOCKET;
    this.transport = new CliHerdrTransport(
      options.endpoint.socketPath,
      this.env,
      'herdr',
      1500,
      options.endpoint.server
    );
  }
  async instance(): Promise<string> {
    this.deadline.remaining();
    const instance = await this.transport.instance();
    this.deadline.remaining();
    if (!instance) throw new ExecutionError('endpoint_unknown');
    return instance;
  }
  async call(argv: readonly string[], cap = 15_000): Promise<HerdrOutcome> {
    return runHerdr(argv, this.env, { budgetMs: this.deadline.remaining(cap), signal: this.deadline.signal });
  }
  async query(argv: readonly string[]): Promise<Record<string, unknown>> {
    const outcome = await this.call(argv);
    const result = outcome.ok && herdrResult(outcome.stdout);
    if (!result || record(result.error)) throw new ExecutionError('inventory_unknown');
    return result;
  }
  path(slot: string, file: string): string {
    return join(this.context.jobDirectory, '.dispatch', slot, file);
  }
  journal(slot: string): Journal | null {
    return optionalJson(this.path(slot, 'launch.json'), this.context.jobDirectory);
  }
  writeJournal(j: Journal): void {
    save(this.path(j.slot, 'launch.json'), j, this.context.jobDirectory);
  }
  control(): { closing: boolean; generation: number } {
    const value = optionalJson<{ closing: boolean; generation: number }>(
      join(this.context.jobDirectory, '.dispatch/control.json'),
      this.context.jobDirectory
    );
    if (!value) return { closing: false, generation: 0 };
    if (typeof value.closing !== 'boolean' || !Number.isSafeInteger(value.generation))
      throw new ExecutionError('control_unknown');
    return value;
  }
  async admitted<T>(body: () => Promise<T>): Promise<T> {
    return locked(this.context.jobDirectory, 'resources', this.deadline, async () => {
      if (this.control().closing) throw new ExecutionError('closing');
      await this.instance();
      return body();
    });
  }
  /** Sent is durable BEFORE dispatch. Unacknowledged sent steps are never a retry queue. */
  async effect(
    j: Journal,
    key: string,
    argv: readonly string[],
    cap = 15_000,
    verify?: () => Promise<void>
  ): Promise<Record<string, unknown>> {
    return this.admitted(async () => {
      const latest = this.journal(j.slot);
      if (!latest || latest.session_id !== j.session_id) throw new ExecutionError('launch_unknown');
      Object.assign(j, latest);
      if ((await this.instance()) !== j.instance) throw new ExecutionError('endpoint_changed');
      const step = j.steps[key];
      if (step?.state === 'acked') return step.result ?? {};
      if (step?.state === 'sent') throw new ExecutionError('launch_unknown');
      await verify?.();
      j.steps[key] = { state: 'intent' };
      this.writeJournal(j);
      j.steps[key] = { state: 'sent' };
      this.writeJournal(j);
      const out = await this.call(argv, cap);
      const result = out.ok && herdrResult(out.stdout);
      if (!result) throw new ExecutionError('launch_unknown');
      j.steps[key] = { state: 'acked', result };
      this.writeJournal(j);
      return result;
    });
  }
  async rememberPane(j: Journal, pane: string): Promise<void> {
    if (j.terminals[pane]) return;
    const raw = (await this.query(['pane', 'get', pane])).pane;
    if (
      !record(raw) ||
      raw.pane_id !== pane ||
      raw.tab_id !== j.tab ||
      typeof raw.terminal_id !== 'string' ||
      !raw.terminal_id
    )
      throw new ExecutionError('terminal_unknown');
    j.terminals[pane] = raw.terminal_id;
    this.writeJournal(j);
  }
  async tab(j: Journal): Promise<{ panes: Record<string, unknown>[]; agents: Record<string, unknown>[] }> {
    if (!j.tab || j.tab === this.options.callerTabId || (await this.instance()) !== j.instance)
      throw new ExecutionError('ownership_unknown');
    const tabs = await this.query(['tab', 'list']);
    if (!Array.isArray(tabs.tabs)) throw new ExecutionError('inventory_unknown');
    const matches = tabs.tabs.filter((t) => record(t) && t.tab_id === j.tab);
    if (matches.length !== 1 || !record(matches[0]) || matches[0].label !== j.label)
      throw new ExecutionError('ownership_unknown');
    const panes = (await this.query(['pane', 'list'])).panes;
    const agents = (await this.query(['agent', 'list'])).agents;
    if (
      !Array.isArray(panes) ||
      !panes.every((p) => record(p) && typeof p.pane_id === 'string' && typeof p.tab_id === 'string') ||
      !Array.isArray(agents) ||
      !agents.every((a) => record(a) && typeof a.pane_id === 'string' && typeof a.tab_id === 'string')
    )
      throw new ExecutionError('inventory_unknown');
    for (const pane of panes.filter((p) => p.tab_id === j.tab)) {
      const raw =
        typeof pane.terminal_id === 'string' ? pane : (await this.query(['pane', 'get', String(pane.pane_id)])).pane;
      const terminals = { ...this.journal('primary')?.terminals, ...j.terminals };
      if (
        !record(raw) ||
        raw.pane_id !== pane.pane_id ||
        raw.tab_id !== j.tab ||
        !terminals[String(pane.pane_id)] ||
        raw.terminal_id !== terminals[String(pane.pane_id)]
      )
        throw new ExecutionError('terminal_changed');
    }
    return { panes: panes.filter((p) => p.tab_id === j.tab), agents: agents.filter((a) => a.tab_id === j.tab) };
  }
  async owner(c: SlotContract, j: Journal): Promise<Owner> {
    const raw = optionalJson<Owner>(this.path(c.slot, 'owner.json'), c.task_dir);
    if (
      !raw ||
      raw.schema !== 1 ||
      raw.ready !== true ||
      raw.job !== c.job ||
      raw.slot !== c.slot ||
      raw.session_id !== c.session_id ||
      raw.instance !== j.instance ||
      raw.tab_id !== j.tab ||
      raw.pane_id !== j.pane ||
      raw.agent_name !== j.name ||
      raw.model !== c.model ||
      raw.effort !== c.effort ||
      !validStamp(raw.process) ||
      typeof raw.session_file !== 'string' ||
      !raw.session_file.startsWith(c.session_dir + '/') ||
      !raw.session_file.endsWith(`_${c.session_id}.jsonl`)
    )
      throw new ExecutionError('startup_unknown');
    const header = readOwnedText(raw.session_file, 1024 * 1024, c.task_dir).split('\n')[0]!;
    let session: unknown;
    try {
      session = JSON.parse(header);
    } catch {
      throw new ExecutionError('session_unknown');
    }
    if (
      !record(session) ||
      session.type !== 'session' ||
      session.id !== c.session_id ||
      processState(raw.process) !== 'alive'
    )
      throw new ExecutionError('ownership_unknown');
    const agent = (await this.query(['agent', 'get', j.name])).agent;
    if (!this.matches(agent, raw, j)) throw new ExecutionError('ownership_unknown');
    return raw;
  }
  matches(agent: unknown, owner: Owner, j: Journal): boolean {
    return (
      record(agent) &&
      agent.name === j.name &&
      agent.agent === 'pi' &&
      agent.pane_id === j.pane &&
      agent.tab_id === j.tab &&
      record(agent.agent_session) &&
      agent.agent_session.agent === 'pi' &&
      agent.agent_session.kind === 'path' &&
      agent.agent_session.source === 'herdr:pi' &&
      agent.agent_session.value === owner.session_file
    );
  }
}
export { processState, readProcess, sameStamp };
