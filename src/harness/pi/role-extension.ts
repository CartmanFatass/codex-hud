/** Owned pi worker only. No ordinary HUD, footer, panel or general role facade. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setImmediate as deferTurn } from 'node:timers/promises';
import {
  ROLE_TOOLS,
  readOwnedText,
  readSlotContract,
  type ContractContext,
  type SlotContract,
} from '../../roles/pi-owned/contracts.js';
import {
  settlementDecision,
  cacheTtlMs,
  graceDeadline,
  graceExpired,
  warmingDecision,
} from '../../roles/pi-owned/lifecycle.js';
import { guardTool } from '../../roles/pi-owned/guard.js';
import { askQuestion } from '../../roles/pi-owned/qa.js';
import { callHelper, type HelperRequest } from '../../roles/pi-owned/helpers.js';
import { spawnPostExitReaper } from '../../roles/pi-owned/reap-main.js';
import { contextForContract, loadWorkerRelease } from '../../roles/pi-owned/release.js';
import type { DispatchStatus } from '../../roles/pi-dispatch-status.js';
import {
  Runtime,
  Deadline,
  readRuntimeBinding,
  save,
  selfStamp,
  type RuntimeOptions,
  type Owner,
} from '../../roles/pi-owned/runtime.js';

/** Documented host API subset; pi supplies its SDK, never a second installed copy. */
export interface WorkerContext {
  cwd: string;
  model?: { provider: string; id: string; promptCache?: { short?: number; long?: number } };
  thinkingLevel: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getHeader(): { type: string; id: string; cwd: string } | null;
  };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
  shutdown(): void;
}
export interface WorkerParams {
  question?: string;
  options?: string[];
  default?: string;
  context?: string;
  brief_path?: string;
  thinking?: 'low' | 'high';
}
interface WorkerEvent {
  reason: string;
  systemPrompt?: string;
  aborted?: boolean;
  message?: { role: string; stopReason?: string };
  toolName: string;
  input: Record<string, unknown>;
  warmCost: number;
  action: 'warm' | 'stop';
}
type Status = DispatchStatus & {
  version: 1;
  task_dir: string;
  role: string;
  output_path: string;
  parent: string | null;
  pid: number;
  started_at: string;
  effort_source: string;
  session_file?: string;
  warm: { spent_usd: number; action: string };
};
export interface WorkerTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  executionMode: 'sequential';
  execute(
    id: string,
    params: WorkerParams,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: WorkerContext
  ): Promise<unknown>;
}
export interface WorkerAPI {
  registerFlag(name: string, options: { type: 'string'; description: string }): void;
  getFlag(name: string): string | boolean | undefined;
  on(event: string, handler: (event: WorkerEvent, ctx: WorkerContext) => unknown): void;
  registerTool(tool: WorkerTool): void;
  setActiveTools(names: string[]): void;
  getSettings(): { cacheWarming?: string; cacheRetention?: string };
}
export interface WorkerClock {
  now(): number;
  timer(callback: () => void, ms: number): NodeJS.Timeout | number;
  clear(timer: NodeJS.Timeout | number): void;
  defer(): Promise<void>;
}
const clock: WorkerClock = {
  now: Date.now,
  timer: (callback, ms) => setTimeout(callback, Math.min(ms, 2_147_483_647)),
  clear: (timer) => clearTimeout(timer as NodeJS.Timeout),
  defer: async () => {
    await deferTurn();
  },
};
function outputSignature(c: SlotContract): string | null {
  if (!fs.existsSync(c.output_path)) return null;
  const text = readOwnedText(c.output_path, 1024 * 1024, c.task_dir);
  return text.trim() ? createHash('sha256').update(text).digest('hex') : null;
}
function result(details: unknown, text = JSON.stringify(details)) {
  return { content: [{ type: 'text', text }], details };
}
/** Effects remain here; lifecycle.ts retains the pi-free decisions. */
export class WorkerSession {
  private generation = 0;
  private timer: NodeJS.Timeout | number | undefined;
  private outputBefore: string | null = null;
  private settled = false;
  private aborted = false;
  private finalError = false;
  private closing = false;
  private continuationUsed = false;
  private questions = 0;
  private spent = 0;
  private lifetime = new AbortController();
  private helpers = new Set<Promise<unknown>>();
  private published = '';
  readonly status: Status;
  readonly statusFile: string;
  constructor(
    readonly c: SlotContract,
    readonly context: ContractContext,
    readonly options: RuntimeOptions,
    readonly pi: WorkerAPI,
    private readonly time: WorkerClock = clock,
    private readonly autoclose = spawnPostExitReaper
  ) {
    this.statusFile =
      c.slot === 'primary' ? join(c.task_dir, 'STATUS.json') : join(c.task_dir, '.dispatch', c.slot, 'STATUS.json');
    this.status = {
      version: 1,
      task_dir: c.task_dir,
      slot: c.slot,
      role: c.role,
      session_id: c.session_id,
      model: c.model,
      thinking: c.effort,
      output_path: c.output_path,
      output_written: false,
      state: 'working',
      helper_pending: null,
      settled_at: null,
      idle_deadline_at: null,
      ended_at: null,
      exit_reason: null,
      error: null,
      parent: c.parent_slot ?? null,
      pid: process.pid,
      started_at: new Date(time.now()).toISOString(),
      effort_source: 'contract',
      warm: { spent_usd: 0, action: 'stop' },
    };
  }
  publish(): void {
    const text = JSON.stringify(this.status);
    if (text === this.published) return;
    save(this.statusFile, { ...this.status, updated_at: new Date(this.time.now()).toISOString() }, this.c.task_dir);
    this.published = text;
  }
  private cancelTimer(): void {
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
  }
  matches(ctx: WorkerContext): boolean {
    return (
      !this.closing &&
      ctx.cwd === this.c.cwd &&
      ctx.sessionManager.getSessionId() === this.c.session_id &&
      `${ctx.model?.provider}/${ctx.model?.id}` === this.c.model &&
      ctx.thinkingLevel === this.c.effort &&
      ctx.sessionManager.getSessionFile() === this.status.session_file
    );
  }
  fail(ctx: WorkerContext, reason: string): void {
    this.cancelTimer();
    this.generation++;
    this.closing = true;
    this.lifetime.abort();
    Object.assign(this.status, {
      state: 'failed',
      error: reason,
      exit_reason: reason,
      ended_at: new Date(this.time.now()).toISOString(),
    });
    this.publish();
    ctx.abort();
    ctx.shutdown();
  }
  begin(ctx: WorkerContext): void {
    if (this.closing) {
      ctx.abort();
      ctx.shutdown();
      return;
    }
    if (!this.matches(ctx)) {
      this.fail(ctx, 'worker_identity_mismatch');
      return;
    }
    if (this.status.state === 'idle_grace') this.continuationUsed = true;
    this.cancelTimer();
    this.generation++;
    this.settled = false;
    this.aborted = false;
    this.finalError = false;
    try {
      this.outputBefore = outputSignature(this.c);
    } catch {
      this.fail(ctx, 'output_unreadable');
      return;
    }
    Object.assign(this.status, { state: 'working', output_written: false, settled_at: null, idle_deadline_at: null });
    this.publish();
  }
  message(event: Pick<WorkerEvent, 'message'>): void {
    if (event.message?.role === 'assistant') {
      this.finalError = event.message.stopReason === 'error';
      this.aborted = event.message.stopReason === 'aborted';
    }
  }
  private ttl(ctx: WorkerContext): number {
    const retention =
      this.pi.getSettings().cacheRetention ?? (this.options.env.PI_CACHE_RETENTION === 'long' ? 'long' : 'short');
    return cacheTtlMs(
      retention === 'long' ? ctx.model?.promptCache?.long : retention === 'short' ? ctx.model?.promptCache?.short : 0
    );
  }
  async settle(event: { aborted?: boolean }, ctx: WorkerContext): Promise<void> {
    const generation = this.generation;
    this.settled = true;
    this.aborted ||= event.aborted === true;
    await this.time.defer();
    if (this.closing || !this.matches(ctx) || this.status.state === 'idle_grace') return;
    let outputAfter: string | null;
    try {
      outputAfter = outputSignature(this.c);
    } catch {
      this.fail(ctx, 'output_unreadable');
      return;
    }
    const decision = settlementDecision({
      generation: this.generation,
      expectedGeneration: generation,
      settled: this.settled,
      idle: ctx.isIdle(),
      pendingMessages: ctx.hasPendingMessages(),
      helperPending: this.status.helper_pending !== null || this.helpers.size > 0,
      questions: this.questions,
      aborted: this.aborted,
      error: this.finalError,
      outputBefore: this.outputBefore,
      outputAfter,
    });
    if (decision === 'wait') return;
    if (decision === 'failed') {
      this.fail(ctx, 'settlement_failed');
      return;
    }
    const now = this.time.now();
    Object.assign(this.status, { output_written: true, settled_at: new Date(now).toISOString() });
    if (this.c.role === 'implementer') {
      this.status.state = 'idle_grace';
      this.status.idle_deadline_at = new Date(graceDeadline(now, this.ttl(ctx))).toISOString();
      this.publish();
      this.armGrace(ctx, generation);
    } else await this.finish(ctx, 'settled');
  }
  private armGrace(ctx: WorkerContext, generation: number): void {
    this.cancelTimer();
    if (!this.status.idle_deadline_at) return;
    const deadline = Date.parse(this.status.idle_deadline_at);
    this.timer = this.time.timer(
      () => {
        this.timer = undefined;
        if (this.closing || this.status.state !== 'idle_grace' || generation !== this.generation) return;
        if (!graceExpired(this.time.now(), deadline, this.generation, generation)) {
          this.armGrace(ctx, generation);
          return;
        }
        if (!ctx.isIdle() || ctx.hasPendingMessages() || this.questions || this.status.helper_pending) return;
        void this.finish(ctx, this.continuationUsed ? 'idle_grace_expired_used' : 'idle_grace_expired');
      },
      Math.max(0, deadline - this.time.now())
    );
  }
  modelChanged(ctx: WorkerContext): void {
    if (this.status.state === 'idle_grace' && this.status.settled_at && this.status.idle_deadline_at) {
      const next = graceDeadline(
        Date.parse(this.status.settled_at),
        this.ttl(ctx),
        Date.parse(this.status.idle_deadline_at)
      );
      this.status.idle_deadline_at = new Date(next).toISOString();
      this.publish();
      this.armGrace(ctx, this.generation);
    } else if (!this.matches(ctx)) this.fail(ctx, 'worker_identity_mismatch');
  }
  private async finish(ctx: WorkerContext, reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.cancelTimer();
    Object.assign(this.status, {
      state: 'closed',
      ended_at: new Date(this.time.now()).toISOString(),
      exit_reason: reason,
    });
    this.publish();
    if (this.c.slot === 'primary' && (this.c.role !== 'implementer' || reason === 'idle_grace_expired')) {
      try {
        await this.autoclose(this.context, { ...this.options, keepTab: this.options.env.HUD_KEEP_TAB === '1' });
      } catch {
        /* Finite best effort; never invent cleanup evidence or change a valid result. */
      }
    }
    ctx.shutdown();
  }
  warm(event: { warmCost: number; action: 'warm' | 'stop' }): { action: 'warm' | 'stop' } {
    const decision = warmingDecision({
      closing: this.closing,
      failed: this.status.state === 'failed',
      disabled: this.pi.getSettings().cacheWarming === 'off',
      spentUsd: this.spent,
      estimatedUsd: event.warmCost,
      helperPending: !!this.status.helper_pending,
      settled: this.settled,
    });
    const action = decision === 'native' ? event.action : decision === 'warm' ? 'warm' : 'stop';
    if (action === 'warm') this.spent += event.warmCost;
    this.status.warm = { spent_usd: this.spent, action };
    this.publish();
    return { action };
  }
  async ask(params: WorkerParams, signal?: AbortSignal) {
    if (this.closing) throw new Error('closing');
    if (typeof params.question !== 'string' || !params.question.trim()) throw new Error('invalid_question');
    this.questions++;
    this.status.state = 'waiting_orchestrator';
    this.publish();
    try {
      const decision = await askQuestion(
        this.c.task_dir,
        {
          question: params.question,
          options: params.options,
          proposedDefault: params.default,
          context: params.context,
        },
        { signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal }
      );
      return result(
        decision,
        decision.kind === 'timeout'
          ? `${decision.text} (timeout; default instructed, not evidence of action)`
          : decision.kind === 'answered'
            ? decision.text
            : 'Interrupted; no default instruction.'
      );
    } finally {
      this.questions--;
      this.status.state = this.closing
        ? this.status.state
        : this.questions
          ? 'waiting_orchestrator'
          : this.status.helper_pending
            ? 'waiting_helper'
            : 'working';
      this.publish();
    }
  }
  async helper(request: HelperRequest, signal?: AbortSignal) {
    if (this.closing || this.c.role === 'sonic' || (request.kind === 'reviewer' && this.c.role !== 'implementer'))
      throw new Error('helper_ineligible');
    const pending = callHelper(
      this.context,
      {
        ...this.options,
        callerSlot: this.c.slot,
        signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
        waitingHelper: async (value) => {
          this.status.helper_pending = value;
          this.status.state = this.closing
            ? this.status.state
            : value
              ? 'waiting_helper'
              : this.questions
                ? 'waiting_orchestrator'
                : 'working';
          this.publish();
        },
      },
      request
    );
    this.helpers.add(pending);
    try {
      const outcome = await pending;
      return { ...result(outcome, outcome.text ?? outcome.reason), isError: !outcome.ok };
    } finally {
      this.helpers.delete(pending);
    }
  }
  async shutdown(ctx: WorkerContext, reason: string): Promise<void> {
    this.cancelTimer();
    this.generation++;
    this.lifetime.abort();
    await Promise.allSettled(this.helpers);
    if (!this.closing) {
      if (this.status.state === 'idle_grace' && this.status.output_written && !this.status.error) {
        this.closing = true;
        Object.assign(this.status, {
          state: 'closed',
          exit_reason: `shutdown_${reason}`,
          ended_at: new Date(this.time.now()).toISOString(),
        });
        this.publish();
      } else this.fail(ctx, `shutdown_${reason}`);
    }
  }
}
const string = { type: 'string' };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export default function installRoleExtension(pi: WorkerAPI): void {
  // Explicit worker entry only: native pi session/report/scratch writers must also
  // create private files, not merely HUD's own atomic writers.
  process.umask(0o077);
  pi.registerFlag('hud-role-contract', { type: 'string', description: 'Pinned HUD worker contract' });
  pi.registerFlag('hud-role-file', { type: 'string', description: 'Pinned HUD role text' });
  let worker: WorkerSession | undefined;
  let startupError = 'worker_not_ready';
  pi.on('session_start', async (event, ctx) => {
    try {
      if (worker || event.reason !== 'startup') throw new Error('session_replacement_refused');
      const file = pi.getFlag('hud-role-contract');
      if (typeof file !== 'string') throw new Error('invalid_contract');
      const context = contextForContract(file, await loadWorkerRelease());
      const c = readSlotContract(file, context);
      if (pi.getFlag('hud-role-file') !== c.role_resource.path) throw new Error('role_file_mismatch');
      const options = { ...readRuntimeBinding(c.task_dir), env: process.env };
      const runtime = new Runtime(context, options, new Deadline(15_000));
      const j = runtime.journal(c.slot);
      const sessionFile = ctx.sessionManager.getSessionFile();
      const header = ctx.sessionManager.getHeader();
      if (
        !j ||
        (await runtime.instance()) !== j.instance ||
        ctx.cwd !== c.cwd ||
        ctx.sessionManager.getSessionId() !== c.session_id ||
        !sessionFile?.startsWith(c.session_dir + '/') ||
        !sessionFile.endsWith(`_${c.session_id}.jsonl`) ||
        `${ctx.model?.provider}/${ctx.model?.id}` !== c.model ||
        ctx.thinkingLevel !== c.effort ||
        header?.id !== c.session_id ||
        header.cwd !== c.cwd ||
        header.type !== 'session'
      )
        throw new Error('worker_identity_mismatch');
      worker = new WorkerSession(c, context, options, pi);
      worker.status.session_file = sessionFile;
      const owner: Owner = {
        schema: 1,
        ready: true,
        job: c.job,
        slot: c.slot,
        session_id: c.session_id,
        session_file: sessionFile,
        session_header: { type: 'session', id: header.id, cwd: header.cwd },
        instance: j.instance,
        tab_id: j.tab!,
        pane_id: j.pane!,
        agent_name: j.name,
        process: selfStamp(),
        model: c.model,
        effort: c.effort,
      };
      const tool = (name: string, parameters: Record<string, unknown>, execute: WorkerTool['execute']) =>
        pi.registerTool({
          name,
          label: name,
          description:
            name === 'ask_orchestrator'
              ? 'Ask the main session; waits up to 1200 seconds, timeout instructs default, never claims action.'
              : 'Run one blocking helper; returns at most 50 KiB/2000 lines and full artifact path.',
          parameters,
          executionMode: 'sequential',
          execute,
        });
      tool(
        'ask_orchestrator',
        schema({ question: string, options: { type: 'array', items: string }, default: string, context: string }, [
          'question',
          'default',
        ]),
        async (_id, p, signal) => worker!.ask(p, signal)
      );
      if (c.role !== 'sonic')
        tool(
          'call_sonic',
          schema({ brief_path: string, thinking: { type: 'string', enum: ['low', 'high'] } }, ['brief_path']),
          async (_id, p, signal) =>
            worker!.helper({ kind: 'sonic', brief_path: p.brief_path, thinking: p.thinking }, signal)
        );
      if (c.role === 'implementer')
        tool('call_reviewer', schema({}), async (_id, _p, signal) => worker!.helper({ kind: 'reviewer' }, signal));
      pi.setActiveTools(ROLE_TOOLS[c.role].split(','));
      worker.publish();
      save(runtime.path(c.slot, 'owner.json'), owner, c.task_dir);
      startupError = '';
    } catch (error) {
      startupError = error instanceof Error ? error.message : 'startup_failed';
      ctx.abort();
      ctx.shutdown();
    }
  });
  pi.on('input', () => (startupError ? { action: 'handled' } : undefined));
  pi.on('before_agent_start', (_e, ctx) => {
    if (startupError || !worker) {
      ctx.abort();
      ctx.shutdown();
      return;
    }
    try {
      const role = readOwnedText(worker.c.role_resource.path, 256 * 1024);
      if (createHash('sha256').update(role).digest('hex') !== worker.c.role_resource.sha256)
        throw new Error('role_resource_changed');
      worker.begin(ctx);
      return {
        systemPrompt: `${_e.systemPrompt ?? ''}\n\n<role>\n${role}\nAuthoritative output: ${worker.c.output_path}\n</role>`,
      };
    } catch {
      worker.fail(ctx, 'role_resource_changed');
    }
  });
  pi.on('before_provider_request', (_e, ctx) => {
    if (startupError || !worker?.matches(ctx)) {
      ctx.abort();
      ctx.shutdown();
    }
  });
  pi.on('tool_call', (event, ctx) => {
    if (startupError || !worker || !worker.matches(ctx))
      return { block: true, reason: startupError || 'worker_identity_mismatch' };
    if (!ROLE_TOOLS[worker.c.role].split(',').includes(event.toolName))
      return { block: true, reason: 'tool_ineligible' };
    const g = guardTool(
      {
        role: worker.c.read_only ? 'reviewer' : worker.c.role,
        cwd: worker.c.cwd,
        allowedWritePaths: worker.c.allowed_write_paths,
        qaDirectory: worker.c.qa_dir,
        temporaryDirectory: join(worker.c.task_dir, '.dispatch', worker.c.slot, 'scratch'),
      },
      event.toolName,
      event.input
    );
    if (!g.allowed) return { block: true, reason: g.reason };
  });
  pi.on('message_end', (e) => worker?.message(e));
  pi.on('agent_settled', (e, ctx) => worker?.settle(e, ctx));
  pi.on('model_select', (_e, ctx) => worker?.modelChanged(ctx));
  pi.on('thinking_level_select', (_e, ctx) => worker?.modelChanged(ctx));
  pi.on('cache_warming_decision', (e) => worker?.warm(e) ?? { action: 'stop' });
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree'])
    pi.on(event, (_e, ctx) => {
      worker?.fail(ctx, 'session_replacement_refused');
      return { cancel: true };
    });
  pi.on('session_shutdown', (e, ctx) => worker?.shutdown(ctx, e.reason));
}
