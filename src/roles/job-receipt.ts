/** Receipt reads shared by the facade and the lightweight local waiter. No runtime adapters. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { JevJobInput } from '../jev/runtime/types.js';
import type { backendJson } from './routing.js';
import type { OraclePhase, RoleName } from './roles.js';
import { isRecord } from './herdr-run.js';
import { validDispatch, type PiDispatch } from './pi-dispatch.js';

export type Result = { ok: true; [key: string]: unknown } | { ok: false; code: string; [key: string]: unknown };
export interface HerdrExecutor {
  kind: 'herdr';
  tab_id: string | null;
  pane_id: string | null;
  agent: string;
  workspace_id: string | null;
}
interface JevBoundExecutor {
  kind: 'jev';
  job: string | null;
}
export type ExecutorIds = HerdrExecutor | JevBoundExecutor;
type StepState = 'unsent' | 'sent' | 'acked';
interface JobSteps {
  tab_create: StepState;
  launch: StepState;
  rename: StepState;
  prompt: StepState;
  tab_closed: boolean;
}
export interface JobReceipt {
  pi_dispatch?: PiDispatch;
  schema: 1;
  job: string;
  parent: string;
  request_key: string;
  fingerprint: string;
  role: RoleName;
  phase: OraclePhase | null;
  routing_revision: string;
  preset: string;
  jev_decisions: { id: string; provider: 'typesafe' | 'openai'; model: string | null };
  binding: ReturnType<typeof backendJson>;
  cwd: string;
  task_label: string;
  label: string;
  state: 'launching' | 'open' | 'done' | 'error' | 'closed' | 'launch_unknown' | 'failed';
  launch_error: string | null;
  prompted: boolean;
  steps: JobSteps;
  /** Account variables pinned at launch. Older receipts may omit them. */
  env?: Record<string, string>;
  executor: ExecutorIds;
  closed_observation: string | null;
  jev_tag?: 'ask' | 'browse' | 'judge';
  runtime_request_key?: string;
  jev_seq?: number;
  /** A retry sends this stored input, not the current routing. */
  jev_input?: JevJobInput;
}
/** Private regular JSON file; shared with the mutation store without importing locks/crypto. */
export function readPrivateJson(file: string, maxBytes: number): unknown | undefined {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) throw new Error('unsafe_path');
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error('invalid_json', { cause });
  }
}
export const JOB_ID = /^j[a-f0-9]{16}$/;
export function fail(code: string, extra: Record<string, unknown> = {}): Result {
  return { ok: false, code, ...extra };
}
export function jobDirectory(home: string, job: string): string {
  return join(home, 'jobs', job);
}
export function receiptPath(home: string, job: string): string {
  return join(jobDirectory(home, job), 'receipt.json');
}
function stepState(value: unknown, fallback: StepState): StepState {
  return value === 'unsent' || value === 'sent' || value === 'acked' ? value : fallback;
}
export function requireHerdr(receipt: JobReceipt): asserts receipt is JobReceipt & { executor: HerdrExecutor } {
  if (receipt.executor.kind !== 'herdr') throw new Error('internal_error');
}
export function loadReceipt(home: string, job: string): JobReceipt | undefined {
  if (!JOB_ID.test(job)) return undefined;
  let parsed: unknown;
  try {
    parsed = readPrivateJson(receiptPath(home, job), 64 * 1024);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.schema !== 1 || parsed.job !== job) return undefined;
  // SAFETY: preserve the legacy receipt envelope; executor, steps and optional inputs
  // are normalized below before any caller uses those fields.
  const receipt = parsed as unknown as JobReceipt;
  if (!isRecord(parsed.executor)) return undefined;
  if (Object.hasOwn(parsed, 'pi_dispatch')) {
    if (
      parsed.executor.kind !== 'herdr' ||
      !isRecord(parsed.binding) ||
      parsed.binding.executor !== 'herdr' ||
      parsed.binding.harness !== 'pi' ||
      !validDispatch(parsed.pi_dispatch, receipt.role, jobDirectory(home, job))
    )
      return undefined;
  }
  const stored = isRecord(parsed.steps) ? parsed.steps : {};
  receipt.prompted = receipt.prompted === true;
  if (parsed.executor.kind === 'jev') {
    const jobId = parsed.executor.job;
    receipt.executor = { kind: 'jev', job: typeof jobId === 'string' && jobId.length > 0 ? jobId : null };
    if (receipt.jev_tag !== 'ask' && receipt.jev_tag !== 'browse' && receipt.jev_tag !== 'judge')
      delete receipt.jev_tag;
    if (typeof receipt.runtime_request_key !== 'string') delete receipt.runtime_request_key;
    if (typeof receipt.jev_seq !== 'number') delete receipt.jev_seq;
    const storedInput = readStoredJevInput(parsed.jev_input);
    if (storedInput) receipt.jev_input = storedInput;
    else delete receipt.jev_input;
    receipt.steps = {
      tab_create: 'unsent',
      launch: 'unsent',
      rename: 'unsent',
      prompt: 'unsent',
      tab_closed: stored.tab_closed === true || receipt.state === 'closed',
    };
    return receipt;
  }
  const herdr = parsed.executor;
  receipt.executor = {
    kind: 'herdr',
    tab_id: typeof herdr.tab_id === 'string' ? herdr.tab_id : null,
    pane_id: typeof herdr.pane_id === 'string' ? herdr.pane_id : null,
    agent: typeof herdr.agent === 'string' ? herdr.agent : '',
    workspace_id: typeof herdr.workspace_id === 'string' ? herdr.workspace_id : null,
  };
  const tabKnown = receipt.executor.tab_id !== null && receipt.executor.tab_id.length > 0;
  receipt.steps = {
    tab_create: stepState(stored.tab_create, tabKnown ? 'acked' : 'unsent'),
    launch: stepState(stored.launch, receipt.state === 'open' || receipt.prompted ? 'acked' : 'unsent'),
    rename: stepState(
      stored.rename,
      receipt.binding?.recipe === 'codex-zsh' && receipt.state === 'open' ? 'acked' : 'unsent'
    ),
    prompt: stepState(stored.prompt, receipt.prompted ? 'acked' : 'unsent'),
    tab_closed: stored.tab_closed === true || receipt.state === 'closed',
  };
  return receipt;
}
/** The runtime body stored on a receipt. A retry sends this object again. */
export function readStoredJevInput(value: unknown): JevJobInput | null {
  if (!isRecord(value)) return null;
  if (value.tag === 'ask') {
    if (
      (value.target !== 'chatgpt-pro' && value.target !== 'aistudio') ||
      typeof value.label !== 'string' ||
      typeof value.prompt !== 'string'
    )
      return null;
    const optional: Partial<Extract<JevJobInput, { tag: 'ask' }>> = {};
    for (const name of ['model', 'thinking', 'effortWord', 'conversation', 'attach'] as const) {
      if (typeof value[name] === 'string') optional[name] = value[name];
    }
    if (typeof value.maxWaitMs === 'number') optional.maxWaitMs = value.maxWaitMs;
    if (value.dryRun === true) optional.dryRun = true;
    if (value.confirmResend === true) optional.confirmResend = true;
    return { tag: 'ask', target: value.target, label: value.label, prompt: value.prompt, ...optional };
  }
  if (value.tag === 'browse') {
    if (typeof value.goal !== 'string' || typeof value.url !== 'string') return null;
    return { tag: 'browse', goal: value.goal, url: value.url };
  }
  if (value.tag !== 'judge' || typeof value.url !== 'string' || !Array.isArray(value.statements)) return null;
  const statements: Array<{ name: string; statement: string }> = [];
  for (const item of value.statements) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.statement !== 'string') return null;
    statements.push({ name: item.name, statement: item.statement });
  }
  return { tag: 'judge', url: value.url, statements };
}
