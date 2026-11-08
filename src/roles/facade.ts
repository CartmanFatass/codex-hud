/**
 * Fixed-role job facade. herdr runs CLI jobs. A Jev binding uses the role
 * executor: the receipt and association are written first, then the runtime job.
 * With no executor attached, a Jev binding returns `backend_unavailable` and
 * writes nothing.
 *
 * The receipt at `$HUD_HOME/jobs/<job>/receipt.json` is written before any herdr
 * or Jev call. The same request key and the same fingerprint return that job. A
 * changed fingerprint is `conflict`. A lost tab acknowledgement is reconciled
 * from `herdr tab list` by label, then `herdr pane list`. A lost Jev `createJob`
 * acknowledgement is reconciled by calling `createJob` again with the same
 * runtime key. The agent is checked only after that tab is known. A step that
 * was sent is not sent again.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { installationRoot } from '../cli/compat.js';
import { dispatchView, readDispatch, questions, observation } from './job-wait.js';
export { waitForJob } from './job-wait.js';
import {
  fail,
  jobDirectory,
  receiptPath,
  loadReceipt,
  requireHerdr,
  type Result,
  type JobReceipt,
} from './job-receipt.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { JevCreateRequest } from '../jev/runtime/types.js';
import { canonicalJson } from '../core/canonical.js';
import { writeAssociation, type JobAssociation } from './association.js';
import {
  agentStartArgs,
  agentStatus,
  isRecord,
  listedAgents,
  listedPanes,
  listedTabs,
  promptArgs,
  runCommand,
  runHerdr,
  tabCreateArgs,
  tabIds,
  waitArgs,
  type HerdrOutcome,
  type ListedAgent,
} from './herdr-run.js';
import { LockBusy, readPrivateJson, withLock, writePrivate } from './job-store.js';
import {
  discoverDispatch,
  dispatchText,
  launchDispatch,
  readDispatchSession,
  reapDispatch,
  type PiDispatch,
} from './pi-dispatch.js';
import { ADAPTER_HARNESS, isLaunchAdapter } from './adapters.js';
import {
  connectRoleRuntime,
  facadeState,
  isLostAck,
  isRuntimeStartError,
  jevErrorCode,
  mapJevLaunch,
  readRoleJevJob,
  runtimeRequestKey,
  type JevRuntimeHandle,
} from './jev-adapter.js';
import {
  adapterOf,
  appendPiOverrides,
  claudeArgs,
  codexShell,
  grokArgs,
  LaunchError,
  orchestratorPane,
  parsePiRoleArgs,
  piRoleArgv,
  piRoleName,
  qaDir,
  RENAME_BACKOFF_MS,
} from './launch.js';
import {
  assertRoutingId,
  backendJson,
  envProfileVars,
  idValue,
  loadRouting,
  readRouting,
  RoutingError,
  type BackendProfile,
} from './routing.js';
import { ORACLE_PHASES, ROLES, type OraclePhase, type RoleName, type Slot } from './roles.js';
import {
  formatRosterRoot,
  loadRosterSelection,
  parseRosterRoot,
  resolveRoster,
  saveRosterSelection,
  type RosterRoot,
} from './selection.js';

export interface FacadeContext {
  readonly home: string;
  readonly root: RosterRoot | null;
  readonly env: NodeJS.ProcessEnv;
  readonly run?: (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<HerdrOutcome>;
  /**
   * Cross-process lock wait. The default is `LOCK_WAIT_MS` (180s), documented
   * on `withLock`. Tests pass a short budget. Callers in this process share a
   * promise chain and do not observe `busy` through that chain.
   */
  readonly lockWaitMs?: number;
  /** Wall-clock cap for every herdr and pi-role spawn. Tests pass a short budget. */
  readonly herdrBudgetMs?: number;
  /**
   * Role Jev adapter. When it is absent, a Jev binding returns
   * `backend_unavailable` and the facade writes no receipt and starts nothing.
   * `createRoleJevExecutor` supplies the runtime. One handle per context.
   */
  readonly jev?: JevExecutor | null;
}

export interface JevStatement {
  readonly name: string;
  readonly statement: string;
}

export interface JevInput {
  readonly kind: 'ask' | 'browse' | 'judge';
  readonly text: string | null;
  readonly url: string | null;
  readonly statements: readonly JevStatement[];
}

/** What the adapter turns into one runtime job. The receipt does not exist yet. */
export interface JevLaunchRequest {
  readonly root: RosterRoot;
  readonly role: RoleName;
  readonly phase: OraclePhase | null;
  readonly requestKey: string;
  readonly fingerprint: string;
  readonly preset: string;
  readonly routingRevision: string;
  readonly binding: ReturnType<typeof backendJson>;
  readonly input: JevInput | null;
  /** Oracle prompt. Null for a `jev` role; that prompt is `input.text`. */
  readonly task: string | null;
  readonly cwd: string | null;
  readonly jevDecisions: { id: string; provider: 'typesafe' | 'openai'; model: string | null };
}

/**
 * Role-facade Jev adapter. `launch` writes the receipt, then `createJob`.
 * `runtime` is the one reconnecting handle. A test double may omit it and
 * implement only `launch`.
 */
export interface JevExecutor {
  readonly id: 'jev';
  launch(ctx: FacadeContext, request: JevLaunchRequest): Promise<Result>;
  runtime?(): Promise<JevRuntimeHandle>;
}

interface KeyIndex {
  schema: 1;
  job: string;
  fingerprint: string;
  parent: string;
}

interface SentMessage {
  schema: 1;
  message_key: string;
  text: string;
  state: 'sending' | 'sent' | 'send_unknown' | 'failed';
}

const REQUEST_ID = /^q[1-9][0-9]{0,3}$/;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function runner(ctx: FacadeContext): (argv: readonly string[]) => Promise<HerdrOutcome> {
  const budget = ctx.herdrBudgetMs === undefined ? undefined : { budgetMs: ctx.herdrBudgetMs };
  return (argv) => (ctx.run ? ctx.run(argv, ctx.env) : runHerdr(argv, ctx.env, budget));
}

/**
 * pi-role prints argv. Drop inherited notify and pane overrides, and set
 * `HERDR_ENV=1` on purpose so the printed argv can include the pane-state hook.
 */
function piRoleEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.PI_ROLE_NOTIFY;
  delete next.PI_ORCHESTRATOR_PANE;
  next.HERDR_ENV = '1';
  return next;
}

function runPiRole(ctx: FacadeContext, argv: readonly string[]): Promise<HerdrOutcome> {
  const budget = ctx.herdrBudgetMs === undefined ? undefined : { budgetMs: ctx.herdrBudgetMs };
  return runCommand('pi-role', argv, piRoleEnv(ctx.env), budget);
}

function keyLock(parent: string, requestKey: string): string {
  return `key-${sha256(canonicalJson([parent, requestKey]))}`;
}

/** The binding and env stored on the receipt. A retry does not read routing.toml again. */
function profileFromReceipt(receipt: JobReceipt): BackendProfile | null {
  const binding = receipt.binding;
  if (binding.executor !== 'herdr' || !binding.harness || !binding.recipe || !isLaunchAdapter(binding.recipe)) {
    return null;
  }
  if (ADAPTER_HARNESS[binding.recipe] !== binding.harness) return null;
  const wrapper = binding.wrapper ?? null;
  if (binding.recipe === 'codex-zsh') {
    if (wrapper !== 'codex' && wrapper !== 'codex2') return null;
  } else if (wrapper !== null) {
    return null;
  }
  return {
    id: binding.id,
    executor: 'herdr',
    harness: binding.harness,
    model: binding.model,
    effort: binding.effort,
    recipe: binding.recipe,
    envProfile: binding.env_profile,
    wrapper,
    target: null,
    mode: null,
    args: binding.args,
    capabilities: binding.capabilities,
  };
}

function indexPath(home: string, root: RosterRoot, requestKey: string): string {
  return join(home, 'jobs', 'index', sha256(formatRosterRoot(root)), `${sha256(requestKey)}.json`);
}

function messagePath(home: string, job: string, messageKey: string): string {
  return join(jobDirectory(home, job), 'messages', `${sha256(messageKey)}.json`);
}

function parentOf(root: RosterRoot): string {
  return formatRosterRoot(root);
}

function workspaceOf(env: NodeJS.ProcessEnv): string | null {
  const value = env.HERDR_WORKSPACE_ID;
  return value && /^[A-Za-z0-9:_-]{1,64}$/.test(value) ? value : null;
}

function routingFailure(error: unknown): Result | null {
  if (!(error instanceof RoutingError)) return null;
  return fail(error.code, { field: error.field });
}

function requireRoot(ctx: FacadeContext): RosterRoot | Result {
  if (!ctx.root) return fail('session_identity_missing', { field: 'root' });
  return ctx.root;
}

function token(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length < 1 || [...value].length > max || /[\u0000-\u001f]/.test(value))
    return null;
  return value;
}

function block(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value) > max || value.includes('\0'))
    return null;
  return value;
}

function roleOf(value: unknown): RoleName | null {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value) ? (value as RoleName) : null;
}

function phaseOf(value: unknown): OraclePhase | null | undefined {
  if (value === undefined) return null;
  return typeof value === 'string' && (ORACLE_PHASES as readonly string[]).includes(value)
    ? (value as OraclePhase)
    : undefined;
}

function slotFor(role: RoleName, phase: OraclePhase | null): Slot | 'phase_required' | 'phase_forbidden' {
  if (role === 'oracle') {
    if (!phase) return 'phase_required';
    return phase === 'propose' ? 'oracle.propose' : 'oracle.converge';
  }
  if (phase) return 'phase_forbidden';
  return role;
}

function canonicalCwd(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) return null;
  try {
    const real = fs.realpathSync(value);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function taskLabel(task: string): string {
  return task.split('\n')[0]?.trim().replace(/\s+/g, ' ').slice(0, 80) || 'job';
}

function fingerprintOf(parts: {
  role: RoleName;
  phase: OraclePhase | null;
  task: string | null;
  cwd: string | null;
  preset: string | null;
  profile: string | null;
  input: unknown;
}): string {
  return sha256(canonicalJson(parts));
}

function saveReceipt(home: string, receipt: JobReceipt): void {
  const stored = { ...(receipt as JobReceipt & { task?: string }) };
  delete stored.task;
  writePrivate(receiptPath(home, receipt.job), JSON.stringify(stored) + '\n');
}

function associationOf(home: string, receipt: JobReceipt, closed: boolean): JobAssociation {
  return {
    schema: 1,
    job: receipt.job,
    root: receipt.parent,
    role: receipt.role,
    phase: receipt.phase,
    preset: receipt.preset,
    task_label: receipt.task_label,
    cwd: receipt.cwd,
    backend: {
      id: receipt.binding.id,
      executor: receipt.binding.executor,
      harness: receipt.binding.harness,
      model: receipt.binding.model,
      effort: receipt.binding.effort,
      env_profile: receipt.binding.env_profile,
      recipe: receipt.binding.recipe,
    },
    herdr:
      receipt.executor.kind === 'herdr'
        ? {
            tab_id: receipt.executor.tab_id,
            pane_id: receipt.executor.pane_id,
            agent: receipt.executor.agent,
            workspace_id: receipt.executor.workspace_id,
          }
        : { tab_id: null, pane_id: null, agent: null, workspace_id: null },
    report_path: join(jobDirectory(home, receipt.job), 'report.md'),
    closed,
  };
}

function owned(ctx: FacadeContext, receipt: JobReceipt): boolean {
  return ctx.root !== null && receipt.parent === parentOf(ctx.root);
}

function waitCommand(job: string): { command: string; argv: string[]; wait_path?: 'unresolved' } {
  let bin = 'hud';
  try {
    const candidate = join(installationRoot(), 'bin/hud');
    if (fs.statSync(candidate).isFile()) {
      fs.accessSync(candidate, fs.constants.X_OK);
      bin = candidate;
    }
  } catch {
    /* Keep a runnable PATH fallback when the package bin is unavailable. */
  }
  const argv = [bin, 'wait', '--job', job, '--timeout-ms', '3600000'];
  const command = argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
  return { command, argv, ...(bin === 'hud' ? { wait_path: 'unresolved' as const } : {}) };
}

function present(home: string, receipt: JobReceipt, idempotent: boolean): Result {
  const directory = jobDirectory(home, receipt.job);
  const jev = receipt.executor.kind === 'jev';
  return {
    ok: true,
    job: receipt.job,
    idempotent,
    role: receipt.role,
    phase: receipt.phase,
    preset: receipt.preset,
    routing_revision: receipt.routing_revision,
    binding: receipt.binding,
    jev_decisions: receipt.jev_decisions,
    cwd: receipt.cwd,
    state: receipt.state,
    prompted: receipt.prompted,
    executor: receipt.executor,
    ...(receipt.pi_dispatch ? dispatchView(home, receipt) : {}),
    ...(jev ? {} : { brief_path: join(directory, 'brief.md') }),
    report_path: join(directory, 'report.md'),
    wait: jev
      ? { command: `hud_read --job ${receipt.job}`, argv: ['hud_read', '--job', receipt.job] }
      : waitCommand(receipt.job),
  };
}

function forgetJob(home: string, root: RosterRoot, requestKey: string, job: string): void {
  fs.rmSync(jobDirectory(home, job), { recursive: true, force: true });
  for (const file of [indexPath(home, root, requestKey), join(home, 'assoc', `${job}.json`)]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* Already gone. */
    }
  }
}

function writeBrief(home: string, receipt: JobReceipt, task: string): string {
  const directory = jobDirectory(home, receipt.job);
  fs.mkdirSync(join(directory, 'qa'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  const brief = join(directory, 'brief.md');
  const report = join(directory, 'report.md');
  const body = [
    `# ${receipt.role}${receipt.phase ? ` ${receipt.phase}` : ''}`,
    '',
    task,
    '',
    `Write the final artifact to ${report}. Stdout is not the report.`,
    `Report path: ${report}`,
    `Question directory: ${join(directory, 'qa')}`,
    '',
  ].join('\n');
  writePrivate(brief, body);
  return brief;
}

type Found = 'known' | 'absent' | 'timeout' | 'unknown';
type Run = (argv: readonly string[]) => Promise<HerdrOutcome>;

function remember(home: string, receipt: JobReceipt): void {
  saveReceipt(home, receipt);
  writeAssociation(home, associationOf(home, receipt, receipt.state === 'closed'));
}

function envOf(receipt: JobReceipt): Record<string, string> {
  return receipt.env ?? {};
}

function herdrTimeout(receipt: JobReceipt): Result {
  return fail('herdr_timeout', { job: receipt.job, prompted: receipt.prompted });
}

async function markUnknown(home: string, receipt: JobReceipt): Promise<Result> {
  receipt.state = 'launch_unknown';
  receipt.launch_error = 'launch_unknown';
  remember(home, receipt);
  return fail('launch_unknown', { job: receipt.job, executor: receipt.executor, prompted: receipt.prompted });
}

type TabHit = { tabId: string; workspaceId: string | null };
/** `absent` is a successful list with no row for the label. Anything else inconclusive is `unresolved`. */
type TabLookup = 'timeout' | 'absent' | 'unresolved' | TabHit;

/**
 * Find a tab by its unique label. Pane count is not part of the match.
 * `herdr tab get` has no pane id, so launch recovery still asks `pane list`.
 */
async function lookupTab(run: Run, label: string): Promise<TabLookup> {
  const listed = await run(['tab', 'list']);
  if (listed.reason === 'timeout') return 'timeout';
  if (!listed.ok) return 'unresolved';
  const tabs = listedTabs(listed.stdout);
  if (!tabs) return 'unresolved';
  const matches = tabs.filter((tab) => tab.label === label);
  if (matches.length === 0) return 'absent';
  if (matches.length !== 1) return 'unresolved';
  return { tabId: matches[0]!.tabId, workspaceId: matches[0]!.workspaceId };
}

/**
 * A lost `tab create` is reconciled by the unique label, then exactly one pane
 * on that tab. Close does not use this pane check.
 */
async function reconcileTab(run: Run, receipt: JobReceipt): Promise<Found> {
  requireHerdr(receipt);
  const found = await lookupTab(run, receipt.label);
  if (found === 'timeout') return 'timeout';
  if (found === 'absent') return 'absent';
  if (found === 'unresolved') return 'unknown';
  const panesOut = await run(['pane', 'list']);
  if (panesOut.reason === 'timeout') return 'timeout';
  if (!panesOut.ok) return 'unknown';
  const panes = listedPanes(panesOut.stdout);
  if (!panes) return 'unknown';
  const mine = panes.filter((pane) => pane.tabId === found.tabId);
  if (mine.length !== 1) return 'unknown';
  receipt.executor = {
    ...receipt.executor,
    tab_id: found.tabId,
    pane_id: mine[0]!.paneId,
    workspace_id: found.workspaceId ?? receipt.executor.workspace_id,
  };
  receipt.steps.tab_create = 'acked';
  return 'known';
}

async function findNamed(run: Run, name: string): Promise<ListedAgent | 'timeout' | 'unknown' | null> {
  const listed = await run(['agent', 'list']);
  if (listed.reason === 'timeout') return 'timeout';
  if (!listed.ok) return 'unknown';
  const agents = listedAgents(listed.stdout);
  if (!agents) return 'unknown';
  return agents.find((agent) => agent.name === name) ?? null;
}

function noteAgent(receipt: JobReceipt, agent: ListedAgent): void {
  requireHerdr(receipt);
  receipt.executor = {
    ...receipt.executor,
    tab_id: agent.tabId ?? receipt.executor.tab_id,
    pane_id: agent.paneId ?? receipt.executor.pane_id,
  };
  receipt.steps.launch = 'acked';
  if (receipt.binding.recipe !== 'codex-zsh') receipt.steps.rename = 'acked';
}

/**
 * Close the tab when it still exists.
 * `already_gone` only when `tab list` succeeds and the label is absent.
 * A failed or ambiguous lookup is `unresolved` and does not record the close.
 */
async function closeRecorded(
  run: Run,
  receipt: JobReceipt
): Promise<'closed' | 'already_gone' | 'timeout' | 'unresolved' | 'failed'> {
  requireHerdr(receipt);
  if (receipt.steps.tab_closed) return 'already_gone';
  let tabId = receipt.executor.tab_id;
  if (!tabId) {
    const found = await lookupTab(run, receipt.label);
    if (found === 'timeout') return 'timeout';
    if (found === 'absent') {
      receipt.steps.tab_closed = true;
      return 'already_gone';
    }
    if (found === 'unresolved') return 'unresolved';
    tabId = found.tabId;
    receipt.executor = {
      ...receipt.executor,
      tab_id: tabId,
      workspace_id: found.workspaceId ?? receipt.executor.workspace_id,
    };
  }
  const closed = await run(['tab', 'close', tabId]);
  if (closed.reason === 'timeout') return 'timeout';
  if (closed.ok) {
    receipt.steps.tab_closed = true;
    return 'closed';
  }
  const still = await lookupTab(run, receipt.label);
  if (still === 'timeout') return 'timeout';
  if (still === 'absent') {
    receipt.steps.tab_closed = true;
    return 'already_gone';
  }
  if (still === 'unresolved') return 'unresolved';
  return 'failed';
}

async function failLaunch(
  home: string,
  run: Run,
  receipt: JobReceipt,
  code: string,
  extra: Record<string, unknown> = {}
): Promise<Result> {
  requireHerdr(receipt);
  if (receipt.executor.tab_id || receipt.steps.tab_create !== 'unsent') {
    const closed = await closeRecorded(run, receipt);
    if (closed === 'timeout') {
      remember(home, receipt);
      return herdrTimeout(receipt);
    }
    if (closed === 'unresolved' || closed === 'failed') {
      receipt.state = 'failed';
      receipt.launch_error = code;
      remember(home, receipt);
      return fail(code, { job: receipt.job, ...extra });
    }
  }
  receipt.state = 'failed';
  receipt.launch_error = code;
  remember(home, receipt);
  return fail(code, { job: receipt.job, ...extra });
}

async function ensureTab(ctx: FacadeContext, run: Run, receipt: JobReceipt): Promise<Result | null> {
  requireHerdr(receipt);
  if (receipt.steps.tab_create === 'acked' && receipt.executor.tab_id && receipt.executor.pane_id) return null;
  if (receipt.steps.tab_create !== 'unsent') {
    const found = await reconcileTab(run, receipt);
    if (found === 'known') {
      remember(ctx.home, receipt);
      return null;
    }
    if (found === 'timeout') return herdrTimeout(receipt);
    return markUnknown(ctx.home, receipt);
  }
  receipt.steps.tab_create = 'sent';
  remember(ctx.home, receipt);
  const created = await run(tabCreateArgs(receipt.cwd, receipt.label, envOf(receipt), receipt.executor.workspace_id));
  if (created.reason === 'unavailable') return fail('rollback', { job: receipt.job });
  const ids = created.ok ? tabIds(created.stdout) : null;
  if (ids) {
    receipt.executor = { ...receipt.executor, tab_id: ids.tabId, pane_id: ids.paneId };
    receipt.steps.tab_create = 'acked';
    remember(ctx.home, receipt);
    return null;
  }
  const found = await reconcileTab(run, receipt);
  if (found === 'known') {
    remember(ctx.home, receipt);
    return null;
  }
  if (created.reason === 'timeout' || found === 'timeout') return herdrTimeout(receipt);
  if (created.reason === 'failed' && found === 'absent') return failLaunch(ctx.home, run, receipt, 'launch_failed');
  return markUnknown(ctx.home, receipt);
}

async function renameCodex(ctx: FacadeContext, run: Run, receipt: JobReceipt): Promise<Result | null> {
  requireHerdr(receipt);
  if (receipt.steps.rename === 'acked') return null;
  const pane = receipt.executor.pane_id;
  if (!pane) return markUnknown(ctx.home, receipt);
  receipt.steps.rename = 'sent';
  remember(ctx.home, receipt);
  for (const wait of RENAME_BACKOFF_MS) {
    if (wait > 0) await delay(wait);
    const renamed = await run(['agent', 'rename', pane, receipt.executor.agent]);
    if (renamed.ok) {
      receipt.steps.rename = 'acked';
      receipt.steps.launch = 'acked';
      remember(ctx.home, receipt);
      return null;
    }
    if (renamed.reason === 'timeout') return herdrTimeout(receipt);
    if (renamed.reason === 'lost') return markUnknown(ctx.home, receipt);
    const text = `${renamed.stdout}\n${renamed.stderr}`;
    if (!text.includes('agent_not_found')) return failLaunch(ctx.home, run, receipt, 'launch_failed');
  }
  return markUnknown(ctx.home, receipt);
}

async function finishStart(
  ctx: FacadeContext,
  run: Run,
  receipt: JobReceipt,
  started: HerdrOutcome
): Promise<Result | null> {
  requireHerdr(receipt);
  if (started.ok) {
    receipt.steps.launch = 'acked';
    receipt.steps.rename = 'acked';
    remember(ctx.home, receipt);
    return null;
  }
  if (started.reason === 'timeout') return herdrTimeout(receipt);
  const found = await findNamed(run, receipt.executor.agent);
  if (found === 'timeout') return herdrTimeout(receipt);
  if (found && found !== 'unknown') {
    noteAgent(receipt, found);
    remember(ctx.home, receipt);
    return null;
  }
  if (started.reason === 'lost' || found === 'unknown') return markUnknown(ctx.home, receipt);
  return failLaunch(ctx.home, run, receipt, 'launch_failed');
}

async function ensureLaunch(
  ctx: FacadeContext,
  run: Run,
  receipt: JobReceipt,
  profile: BackendProfile
): Promise<Result | null> {
  requireHerdr(receipt);
  const recipe = adapterOf(profile);
  if (receipt.steps.launch === 'acked' && (recipe !== 'codex-zsh' || receipt.steps.rename === 'acked')) return null;
  if (receipt.steps.launch !== 'unsent') {
    const found = await findNamed(run, receipt.executor.agent);
    if (found === 'timeout') return herdrTimeout(receipt);
    if (found && found !== 'unknown') {
      noteAgent(receipt, found);
      if (recipe === 'codex-zsh') receipt.steps.rename = 'acked';
      remember(ctx.home, receipt);
      return null;
    }
    if (recipe === 'codex-zsh') return renameCodex(ctx, run, receipt);
    return markUnknown(ctx.home, receipt);
  }
  const pane = receipt.executor.pane_id;
  if (!pane || !profile.harness) return failLaunch(ctx.home, run, receipt, 'launch_failed');
  if (recipe === 'pi-role') {
    const outcome = await runPiRole(
      ctx,
      piRoleArgv(receipt.role, qaDir(jobDirectory(ctx.home, receipt.job)), orchestratorPane(ctx.env))
    );
    if (outcome.reason === 'timeout') return herdrTimeout(receipt);
    if (!outcome.ok) {
      const reason = outcome.reason === 'unavailable' ? 'pi_role_missing' : 'pi_role_failed';
      return failLaunch(ctx.home, run, receipt, 'launch_failed', { reason });
    }
    const args = appendPiOverrides(
      parsePiRoleArgs(outcome.stdout),
      profile,
      join(jobDirectory(ctx.home, receipt.job), 'sessions')
    );
    receipt.steps.launch = 'sent';
    remember(ctx.home, receipt);
    return finishStart(ctx, run, receipt, await run(agentStartArgs(receipt.executor.agent, 'pi', pane, args)));
  }
  if (recipe === 'codex-zsh') {
    const command = codexShell(profile);
    receipt.steps.launch = 'sent';
    remember(ctx.home, receipt);
    const ran = await run(['pane', 'run', pane, command]);
    if (ran.reason === 'timeout') return herdrTimeout(receipt);
    if (ran.reason === 'lost') return markUnknown(ctx.home, receipt);
    if (!ran.ok) return failLaunch(ctx.home, run, receipt, 'launch_failed');
    receipt.steps.launch = 'acked';
    remember(ctx.home, receipt);
    return renameCodex(ctx, run, receipt);
  }
  const args = recipe === 'grok' ? grokArgs(profile) : claudeArgs(profile);
  receipt.steps.launch = 'sent';
  remember(ctx.home, receipt);
  return finishStart(ctx, run, receipt, await run(agentStartArgs(receipt.executor.agent, profile.harness, pane, args)));
}

async function ensurePrompt(ctx: FacadeContext, run: Run, receipt: JobReceipt): Promise<Result> {
  requireHerdr(receipt);
  const brief = join(jobDirectory(ctx.home, receipt.job), 'brief.md');
  const pointer = `Read ${brief} and do exactly what it asks.`;
  if (receipt.steps.prompt === 'acked') {
    receipt.prompted = true;
    receipt.state = 'open';
    receipt.launch_error = null;
    remember(ctx.home, receipt);
    return present(ctx.home, receipt, false);
  }
  if (receipt.steps.prompt === 'sent') {
    receipt.prompted = false;
    receipt.state = 'open';
    receipt.launch_error = null;
    remember(ctx.home, receipt);
    return present(ctx.home, receipt, true);
  }
  receipt.steps.prompt = 'sent';
  receipt.prompted = false;
  remember(ctx.home, receipt);
  const prompted = await run(promptArgs(receipt.executor.agent, pointer, true));
  if (prompted.reason === 'timeout') return herdrTimeout(receipt);
  if (prompted.ok) {
    receipt.steps.prompt = 'acked';
    receipt.prompted = true;
  }
  receipt.state = 'open';
  receipt.launch_error = null;
  remember(ctx.home, receipt);
  return present(ctx.home, receipt, false);
}

async function openJob(
  ctx: FacadeContext,
  run: Run,
  receipt: JobReceipt,
  profile: BackendProfile,
  task: string
): Promise<Result> {
  try {
    adapterOf(profile);
    if (profile.recipe === 'pi-role') piRoleName(receipt.role);
  } catch (error) {
    if (error instanceof LaunchError) return failLaunch(ctx.home, run, receipt, error.code);
    throw error;
  }
  writeBrief(ctx.home, receipt, task);
  const tab = await ensureTab(ctx, run, receipt);
  if (tab) return tab;
  try {
    const launched = await ensureLaunch(ctx, run, receipt, profile);
    if (launched) return launched;
  } catch (error) {
    if (error instanceof LaunchError) return failLaunch(ctx.home, run, receipt, error.code);
    throw error;
  }
  return ensurePrompt(ctx, run, receipt);
}

async function openDispatch(
  ctx: FacadeContext,
  receipt: JobReceipt,
  task: string,
  idempotent: boolean
): Promise<Result> {
  const metadata = receipt.pi_dispatch!;
  const directory = jobDirectory(ctx.home, receipt.job);
  if (metadata.launch === 'unsent' && receipt.state !== 'closed') {
    // The key lock and the per-job mutation lock are held, in that order.
    const brief = join(directory, 'brief.md');
    if (!fs.existsSync(brief)) writeBrief(ctx.home, receipt, task);
    if (!dispatchText(brief, 128 * 1024)?.trim()) return fail('receipt_unreadable', { job: receipt.job });
    metadata.launch = 'sent';
    receipt.state = 'launch_unknown';
    remember(ctx.home, receipt);
    const outcome = await launchDispatch(
      metadata,
      fs.realpathSync(directory),
      receipt.cwd,
      receipt.binding.model,
      receipt.binding.effort,
      ctx.env,
      ctx.herdrBudgetMs
    );
    const session = readDispatchSession(directory);
    if (outcome.ok && session) {
      metadata.launch = 'acked';
      receipt.state = 'open';
      receipt.prompted = true;
      receipt.launch_error = null;
    } else receipt.launch_error = 'launch_unknown';
  }
  const session = readDispatchSession(directory);
  if (session && receipt.executor.kind === 'herdr') {
    receipt.executor = {
      kind: 'herdr',
      tab_id: session.TAB,
      pane_id: session.LEFT,
      agent: session.PRIMARY,
      workspace_id: null,
    };
    receipt.label = session.TAB_NAME;
  }
  remember(ctx.home, receipt);
  const view = present(ctx.home, receipt, idempotent);
  const state = dispatchView(ctx.home, receipt).state;
  return state === 'launch_unknown' ? { ...view, ok: false, code: 'launch_unknown' } : view;
}

async function sendDispatch(
  ctx: FacadeContext,
  receipt: JobReceipt,
  messageKey: string,
  text: string
): Promise<Result> {
  try {
    return await withLock(
      ctx.home,
      `job-${receipt.job}`,
      async () => {
        const current = loadReceipt(ctx.home, receipt.job);
        if (!current?.pi_dispatch || !owned(ctx, current)) return fail('receipt_unreadable');
        const path = messagePath(ctx.home, receipt.job, messageKey);
        const prior = readPrivateJson(path, 8192);
        if (isRecord(prior) && prior.schema === 1) {
          if (prior.text !== text) return fail('conflict', { job: current.job, message_key: messageKey });
          return prior.state === 'sent'
            ? { ok: true, job: current.job, message_key: messageKey, idempotent: true }
            : fail('send_unknown', { job: current.job, message_key: messageKey });
        }
        const directory = jobDirectory(ctx.home, current.job);
        const session = readDispatchSession(directory);
        const view = dispatchView(ctx.home, current);
        const native = view.dispatch;
        if (
          current.state === 'closed' ||
          !native ||
          !session ||
          view.continuation ||
          native.state === 'closed' ||
          native.state === 'failed' ||
          (native.state === 'idle_grace' && current.pi_dispatch.role !== 'implementer')
        ) {
          return fail('continuation_unavailable', { job: current.job, ...view });
        }
        if (current.pi_dispatch.launch !== 'acked' && native.state !== 'idle_grace')
          return fail('launch_unknown', { job: current.job });
        if (native.state === 'idle_grace') {
          if (!native.settled_at || !native.idle_deadline_at || Date.parse(native.idle_deadline_at) <= Date.now()) {
            return fail('continuation_unavailable', { job: current.job, ...view });
          }
          current.pi_dispatch.continuation = {
            message_key: messageKey,
            previous_session_id: native.session_id,
            previous_settled_at: native.settled_at,
          };
          remember(ctx.home, current);
        }
        const record: SentMessage = { schema: 1, message_key: messageKey, text, state: 'sending' };
        writePrivate(path, JSON.stringify(record) + '\n');
        const outcome = await runner(ctx)(promptArgs(session.PRIMARY, text, false));
        record.state = outcome.ok ? 'sent' : 'send_unknown';
        writePrivate(path, JSON.stringify(record) + '\n');
        return outcome.ok
          ? { ok: true, job: current.job, message_key: messageKey, idempotent: false }
          : fail('send_unknown', { job: current.job, message_key: messageKey });
      },
      ctx.lockWaitMs
    );
  } catch (error) {
    if (error instanceof LockBusy) return fail('busy', { job: receipt.job });
    throw error;
  }
}

async function closeDispatch(ctx: FacadeContext, receipt: JobReceipt): Promise<Result> {
  try {
    return await withLock(
      ctx.home,
      keyLock(receipt.parent, receipt.request_key),
      () =>
        withLock(
          ctx.home,
          `job-${receipt.job}`,
          async () => {
            const current = loadReceipt(ctx.home, receipt.job);
            if (!current?.pi_dispatch || !owned(ctx, current)) return fail('receipt_unreadable');
            if (current.state === 'closed') return { ok: true, job: current.job, closed: true, idempotent: true };
            const directory = jobDirectory(ctx.home, current.job);
            const session = readDispatchSession(directory);
            const outcome = await reapDispatch(current.pi_dispatch, directory, ctx.env, ctx.herdrBudgetMs);
            // An empty reaper inventory without recorded ownership cannot disprove
            // the tab-created-before-SESSION crash window. Preserve uncertainty.
            if (!outcome.ok || !session)
              return fail('close_unresolved', {
                job: current.job,
                reason: outcome.reason,
                session_path: join(directory, 'SESSION.txt'),
                ...dispatchView(ctx.home, current),
              });
            return finishClose(ctx.home, current, 'reaped');
          },
          ctx.lockWaitMs
        ),
      ctx.lockWaitMs
    );
  } catch (error) {
    if (error instanceof LockBusy) return fail('busy', { job: receipt.job });
    throw error;
  }
}

interface LaunchPlan extends JobReceipt {
  env: Record<string, string>;
  task: string;
}

export async function hudRoster(ctx: FacadeContext, args: Record<string, unknown>): Promise<Result> {
  const action = args.action;
  if (action !== 'list' && action !== 'show' && action !== 'select')
    return fail('invalid_arguments', { field: 'action' });
  try {
    const routing = loadRouting(ctx.home);
    if (action === 'list') {
      const names = Object.keys(routing.presets).sort();
      return {
        ok: true,
        schema: 1,
        default_preset: routing.defaultPreset,
        presets: names.flatMap((name) => {
          const preset = idValue(routing.presets, name);
          return preset ? [{ name, description: preset.description, jev_decisions: preset.jevDecisions }] : [];
        }),
      };
    }
    const presetArg = args.preset === undefined ? null : typeof args.preset === 'string' ? args.preset : '';
    if (presetArg === '') return fail('invalid_arguments', { field: 'preset' });
    if (presetArg) assertRoutingId(presetArg, 'preset');
    if (action === 'select') {
      const root = requireRoot(ctx);
      if ('ok' in root) return root;
      if (!presetArg) return fail('invalid_arguments', { field: 'preset' });
      saveRosterSelection(ctx.home, root, presetArg);
      return { ok: true, schema: 1, root: parentOf(root), preset: presetArg };
    }
    const root = ctx.root;
    const selection = root && !presetArg ? loadRosterSelection(ctx.home, root) : null;
    const resolved = resolveRoster(routing, { root, selection, preset: presetArg });
    const source =
      resolved.source === 'default' && resolved.root === null ? 'default (no session identity)' : resolved.source;
    return {
      ok: true,
      schema: 1,
      preset: resolved.preset,
      source,
      root: resolved.root,
      jev_decisions: resolved.jev_decisions,
      roles: resolved.roles,
    };
  } catch (error) {
    return routingFailure(error) ?? fail('internal_error');
  }
}

export async function hudCreate(ctx: FacadeContext, args: Record<string, unknown>): Promise<Result> {
  const root = requireRoot(ctx);
  if ('ok' in root) return root;
  const role = roleOf(args.role);
  if (!role) return fail('invalid_arguments', { field: 'role' });
  const phase = phaseOf(args.phase);
  if (phase === undefined) return fail('invalid_arguments', { field: 'phase' });
  const requestKey = token(args.request_key, 200);
  if (!requestKey) return fail('invalid_arguments', { field: 'request_key' });
  const slot = slotFor(role, phase);
  if (slot === 'phase_required' || slot === 'phase_forbidden') return fail('invalid_arguments', { field: 'phase' });
  let preset: string | null = null;
  if (args.preset !== undefined) {
    if (typeof args.preset !== 'string') return fail('invalid_arguments', { field: 'preset' });
    try {
      preset = assertRoutingId(args.preset, 'preset');
    } catch (error) {
      return routingFailure(error) ?? fail('invalid_arguments', { field: 'preset' });
    }
  }
  let profileName: string | null = null;
  if (args.profile !== undefined) {
    if (typeof args.profile !== 'string') return fail('invalid_arguments', { field: 'profile' });
    try {
      profileName = assertRoutingId(args.profile, 'profile');
    } catch (error) {
      return routingFailure(error) ?? fail('invalid_arguments', { field: 'profile' });
    }
  }
  let input: JevInput | null = null;
  if (role === 'jev') {
    const parsed = parseJevInput(args.input);
    if (!parsed) return fail('invalid_arguments', { field: 'input' });
    input = parsed;
  } else if (args.input !== undefined) {
    return fail('invalid_arguments', { field: 'input' });
  }
  const task = role === 'jev' ? null : block(args.task, 64 * 1024);
  if (role !== 'jev' && !task) return fail('invalid_arguments', { field: 'task' });
  const cwd = role === 'jev' ? null : canonicalCwd(args.cwd);
  if (role !== 'jev' && !cwd) return fail('cwd_unavailable', { field: 'cwd' });
  const fingerprint = fingerprintOf({ role, phase, task, cwd, preset, profile: profileName, input });
  try {
    // A receipt pins the adapter even if routing now selects a different
    // executor (or the original preset was removed). Do not redetect it.
    const indexed = readPrivateJson(indexPath(ctx.home, root, requestKey), 4096);
    if (isRecord(indexed) && typeof indexed.job === 'string') {
      const pinned = loadReceipt(ctx.home, indexed.job);
      if (pinned?.pi_dispatch)
        return await withLock(
          ctx.home,
          keyLock(parentOf(root), requestKey),
          async () => {
            const currentIndex = readPrivateJson(indexPath(ctx.home, root, requestKey), 4096);
            const current = loadReceipt(ctx.home, indexed.job as string);
            if (!current || !owned(ctx, current) || current.request_key !== requestKey || !isRecord(currentIndex))
              return fail('receipt_unreadable');
            if (current.fingerprint !== fingerprint || currentIndex.fingerprint !== fingerprint)
              return fail('conflict', { job: current.job });
            return withLock(
              ctx.home,
              `job-${current.job}`,
              async () => {
                const locked = loadReceipt(ctx.home, current.job);
                if (!locked?.pi_dispatch) return fail('receipt_unreadable');
                return openDispatch(ctx, locked, task!, true);
              },
              ctx.lockWaitMs
            );
          },
          ctx.lockWaitMs
        );
    }
    const loaded = readRouting(ctx.home);
    const routing = loaded.routing;
    const revision = loaded.revision;
    const selection = preset ? null : loadRosterSelection(ctx.home, root);
    const resolved = resolveRoster(routing, {
      root,
      selection,
      preset,
      override: profileName ? { slot, backend: profileName } : null,
    });
    const bound = resolved.roles.find((entry) => entry.slot === slot);
    if (!bound) return fail('unbound_slot', { field: slot });
    if (bound.backend.executor === 'jev') {
      if (!ctx.jev) return fail('backend_unavailable', { executor: 'jev', reason: 'pending R3' });
      return ctx.jev.launch(ctx, {
        root,
        role,
        phase,
        requestKey,
        fingerprint,
        preset: resolved.preset,
        routingRevision: revision,
        binding: bound.backend,
        input,
        task,
        cwd,
        jevDecisions: resolved.jev_decisions,
      });
    }
    return await withLock(
      ctx.home,
      keyLock(parentOf(root), requestKey),
      async () => {
        const existing = readPrivateJson(indexPath(ctx.home, root, requestKey), 4096);
        if (existing !== undefined) {
          if (!isRecord(existing) || existing.schema !== 1 || typeof existing.job !== 'string') {
            return fail('receipt_unreadable');
          }
          const receipt = loadReceipt(ctx.home, existing.job);
          if (!receipt || receipt.request_key !== requestKey || receipt.parent !== parentOf(root)) {
            return fail('receipt_unreadable');
          }
          if (receipt.fingerprint !== fingerprint || existing.fingerprint !== fingerprint) {
            return fail('conflict', { job: receipt.job });
          }
          if (receipt.pi_dispatch)
            return withLock(
              ctx.home,
              `job-${receipt.job}`,
              async () => {
                const current = loadReceipt(ctx.home, receipt.job);
                if (!current) return fail('receipt_unreadable');
                return openDispatch(ctx, current, task!, true);
              },
              ctx.lockWaitMs
            );
          if (receipt.state === 'open' || receipt.state === 'closed') return present(ctx.home, receipt, true);
          if (receipt.state === 'failed') return fail(receipt.launch_error ?? 'launch_failed', { job: receipt.job });
          const stored = profileFromReceipt(receipt);
          if (!stored) return fail('conflict', { job: receipt.job });
          return openJob(ctx, runner(ctx), receipt, stored, task!);
        }
        const profile = idValue(routing.backends, bound.backend.id);
        if (!profile || profile.executor !== 'herdr' || !profile.harness) {
          return fail('backend_unavailable', { executor: 'herdr', reason: 'binding_incomplete' });
        }
        const envVars = envProfileVars(routing, profile.envProfile);
        if (!envVars) return fail('env_profile_unresolved', { env_profile: profile.envProfile });
        let dispatch: PiDispatch | null = null;
        if (profile.harness === 'pi') {
          try {
            dispatch = discoverDispatch(ctx.env, role);
          } catch (error) {
            return fail((error as Error).message);
          }
          if (dispatch && Object.keys(envVars).length > 0) return fail('dispatch_env_unsupported');
          if (dispatch && /[\r\n]/.test(ctx.home + cwd)) return fail('invalid_arguments', { field: 'cwd' });
        }
        const job = `j${randomBytes(8).toString('hex')}`;
        const receipt: LaunchPlan = {
          schema: 1,
          job,
          parent: parentOf(root),
          request_key: requestKey,
          fingerprint,
          role,
          phase,
          routing_revision: revision,
          preset: resolved.preset,
          jev_decisions: resolved.jev_decisions,
          binding: bound.backend,
          cwd: cwd!,
          task_label: taskLabel(task!),
          label: `${role}:${job.slice(1, 9)}`,
          state: 'launching',
          launch_error: null,
          prompted: false,
          steps: { tab_create: 'unsent', launch: 'unsent', rename: 'unsent', prompt: 'unsent', tab_closed: false },
          executor: {
            kind: 'herdr',
            tab_id: null,
            pane_id: null,
            agent: dispatch ? '' : `hud-${job}`,
            workspace_id: dispatch ? null : workspaceOf(ctx.env),
          },
          ...(dispatch ? { pi_dispatch: dispatch } : {}),
          closed_observation: null,
          env: { ...envVars },
          task: task!,
        };
        saveReceipt(ctx.home, receipt);
        writePrivate(
          indexPath(ctx.home, root, requestKey),
          JSON.stringify({ schema: 1, job, fingerprint, parent: receipt.parent } satisfies KeyIndex) + '\n'
        );
        writeAssociation(ctx.home, associationOf(ctx.home, receipt, false));
        const run = runner(ctx);
        const outcome = dispatch
          ? await withLock(ctx.home, `job-${job}`, () => openDispatch(ctx, receipt, task!, false), ctx.lockWaitMs)
          : await openJob(ctx, run, receipt, profile, task!);
        if (!outcome.ok && outcome.code === 'rollback') {
          forgetJob(ctx.home, root, requestKey, job);
          return fail('backend_unavailable', { executor: 'herdr', reason: 'herdr_missing' });
        }
        return outcome;
      },
      ctx.lockWaitMs
    );
  } catch (error) {
    if (error instanceof LockBusy) return busyJob(ctx, root, requestKey);
    return routingFailure(error) ?? fail('internal_error');
  }
}

/** The index is read without the lock. `job` is present when this key already has one. */
function busyJob(ctx: FacadeContext, root: RosterRoot, requestKey: string): Result {
  try {
    const existing = readPrivateJson(indexPath(ctx.home, root, requestKey), 4096);
    if (isRecord(existing) && typeof existing.job === 'string') return fail('busy', { job: existing.job });
  } catch {
    /* An unreadable index still means the key is busy. */
  }
  return fail('busy');
}

const STATEMENT_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const RESERVED_STATEMENTS = new Set(['loading', 'needs_human', 'human_kind']);

function parseJevInput(value: unknown): JevInput | null {
  if (!isRecord(value)) return null;
  if (value.kind !== 'ask' && value.kind !== 'browse' && value.kind !== 'judge') return null;
  const text = value.text === undefined ? null : value.text;
  if (text !== null && (typeof text !== 'string' || text.length < 1 || text.length > 65536)) return null;
  const url = parseJevUrl(value.url);
  if (url === undefined) return null;
  const statements = parseJevStatements(value.statements);
  if (!statements) return null;
  if (value.kind === 'judge' && statements.length === 0) return null;
  if (value.kind !== 'judge' && !text) return null;
  if ((value.kind === 'browse' || value.kind === 'judge') && !url) return null;
  const extra = Object.keys(value).filter((key) => !['kind', 'text', 'statements', 'url'].includes(key));
  if (extra.length > 0) return null;
  return { kind: value.kind, text, url, statements };
}

/** `null` when the field is absent. `undefined` when it is present and not an http(s) URL. */
function parseJevUrl(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Plain strings are named `s1..sN`. At most 12. Reserved judge names are rejected. */
function parseJevStatements(value: unknown): JevStatement[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) return null;
  const statements: JevStatement[] = [];
  const names = new Set<string>();
  let auto = 0;
  for (const item of value) {
    let name: string;
    let statement: string;
    if (typeof item === 'string') {
      statement = item.trim();
      if (statement.length < 1 || item.length > 2000) return null;
      auto += 1;
      name = `s${auto}`;
    } else if (isRecord(item)) {
      if (typeof item.name !== 'string' || typeof item.statement !== 'string') return null;
      if (!STATEMENT_NAME.test(item.name) || RESERVED_STATEMENTS.has(item.name)) return null;
      statement = item.statement.trim();
      if (statement.length < 1 || item.statement.length > 2000) return null;
      if (Object.keys(item).some((key) => key !== 'name' && key !== 'statement')) return null;
      name = item.name;
    } else {
      return null;
    }
    if (names.has(name)) return null;
    names.add(name);
    statements.push({ name, statement });
  }
  return statements;
}

export async function hudRead(ctx: FacadeContext, args: Record<string, unknown>): Promise<Result> {
  const root = requireRoot(ctx);
  if ('ok' in root) return root;
  const waitMs = args.wait_ms === undefined ? 0 : args.wait_ms;
  if (typeof waitMs !== 'number' || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120000) {
    return fail('invalid_arguments', { field: 'wait_ms' });
  }
  if (args.job === undefined) {
    const dir = join(ctx.home, 'jobs', 'index', sha256(parentOf(root)));
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    const jobs = [];
    for (const name of names.sort()) {
      const parsed = readPrivateJson(join(dir, name), 4096);
      if (!isRecord(parsed) || typeof parsed.job !== 'string') continue;
      const receipt = loadReceipt(ctx.home, parsed.job);
      if (!receipt || !owned(ctx, receipt)) continue;
      const dispatch = receipt.pi_dispatch ? dispatchView(ctx.home, receipt) : null;
      jobs.push({
        job: receipt.job,
        role: receipt.role,
        phase: receipt.phase,
        state: dispatch?.state ?? receipt.state,
        ...(dispatch ? { status: dispatch.status } : {}),
        task_label: receipt.task_label,
        preset: receipt.preset,
      });
    }
    return { ok: true, jobs };
  }
  if (typeof args.job !== 'string') return fail('invalid_arguments', { field: 'job' });
  const receipt = loadReceipt(ctx.home, args.job);
  if (!receipt || !owned(ctx, receipt)) return fail('not_found', { field: 'job' });
  if (receipt.executor.kind === 'jev') return readJev(ctx, receipt, waitMs);
  if (receipt.pi_dispatch) return readDispatch(ctx, receipt, waitMs);
  if (receipt.state !== 'open') return observation(ctx.home, receipt, null);
  requireHerdr(receipt);
  const run = runner(ctx);
  const directory = jobDirectory(ctx.home, receipt.job);
  if (waitMs > 0) {
    const started = Date.now();
    const seen = new Set(questions(directory).map((item) => item.id));
    let interval = 1_000;
    while (Date.now() - started < waitMs) {
      const slice = Math.min(interval, waitMs - (Date.now() - started));
      if (slice < 1) break;
      interval = Math.min(interval * 2, 8_000);
      const waited = await run(waitArgs(receipt.executor.agent, slice));
      const fresh = questions(directory);
      if (fresh.some((item) => !seen.has(item.id))) {
        return observation(ctx.home, receipt, waited.ok ? (agentStatus(waited.stdout) ?? 'working') : 'working');
      }
      const status = waited.ok ? agentStatus(waited.stdout) : null;
      if (status === 'idle' || status === 'done' || status === 'blocked') break;
      if (waited.reason === 'unavailable' || waited.reason === 'lost') break;
    }
  }
  const got = await run(['agent', 'get', receipt.executor.agent]);
  return observation(ctx.home, receipt, got.ok ? agentStatus(got.stdout) : 'unknown');
}

export async function hudSend(ctx: FacadeContext, args: Record<string, unknown>): Promise<Result> {
  const root = requireRoot(ctx);
  if ('ok' in root) return root;
  if (typeof args.job !== 'string') return fail('invalid_arguments', { field: 'job' });
  const messageKey = token(args.message_key, 200);
  const text = token(args.text, 4096);
  if (!messageKey) return fail('invalid_arguments', { field: 'message_key' });
  if (!text || text.includes('\n')) return fail('invalid_arguments', { field: 'text' });
  const receipt = loadReceipt(ctx.home, args.job);
  if (!receipt || !owned(ctx, receipt)) return fail('not_found', { field: 'job' });
  if (receipt.executor.kind === 'jev') return sendJev(ctx, receipt, messageKey, text);
  if (receipt.pi_dispatch) return sendDispatch(ctx, receipt, messageKey, text);
  if (receipt.state === 'launch_unknown' || receipt.state === 'launching')
    return fail('launch_unknown', { job: receipt.job });
  if (receipt.state !== 'open') return fail('job_closed', { job: receipt.job });
  requireHerdr(receipt);
  if (!receipt.binding.capabilities.includes('interactive_or_continuable')) {
    return fail('handoff', {
      job: receipt.job,
      location: herdrLocation(receipt),
      reason: 'continuation_unsupported',
    });
  }
  try {
    return await withLock(
      ctx.home,
      `job-${receipt.job}`,
      async () => {
        const path = messagePath(ctx.home, receipt.job, messageKey);
        const prior = readPrivateJson(path, 8192);
        if (isRecord(prior) && prior.schema === 1) {
          if (prior.text !== text) return fail('conflict', { job: receipt.job, message_key: messageKey });
          if (prior.state === 'sent') return { ok: true, job: receipt.job, message_key: messageKey, idempotent: true };
          if (prior.state === 'sending' || prior.state === 'send_unknown') {
            return fail('send_unknown', { job: receipt.job, message_key: messageKey });
          }
          if (prior.state === 'failed') forgetMessage(path);
        }
        const record: SentMessage = { schema: 1, message_key: messageKey, text, state: 'sending' };
        writePrivate(path, JSON.stringify(record) + '\n');
        const outcome = await runner(ctx)(promptArgs(receipt.executor.agent, text, false));
        if (outcome.ok) {
          record.state = 'sent';
          writePrivate(path, JSON.stringify(record) + '\n');
          return { ok: true, job: receipt.job, message_key: messageKey, idempotent: false };
        }
        if (outcome.reason === 'failed') {
          forgetMessage(path);
          return fail('send_failed', { job: receipt.job, message_key: messageKey });
        }
        record.state = 'send_unknown';
        writePrivate(path, JSON.stringify(record) + '\n');
        return fail('send_unknown', { job: receipt.job, message_key: messageKey });
      },
      ctx.lockWaitMs
    );
  } catch (error) {
    if (error instanceof LockBusy) return fail('busy', { job: receipt.job });
    throw error;
  }
}

function forgetMessage(path: string): void {
  try {
    const info = fs.lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) return;
    fs.unlinkSync(path);
  } catch {
    /* Already gone. */
  }
}

function herdrLocation(receipt: JobReceipt): {
  kind: 'herdr';
  agent: string;
  pane_id: string | null;
  tab_id: string | null;
} {
  requireHerdr(receipt);
  return {
    kind: 'herdr',
    agent: receipt.executor.agent,
    pane_id: receipt.executor.pane_id,
    tab_id: receipt.executor.tab_id,
  };
}

export async function hudRespond(ctx: FacadeContext, args: Record<string, unknown>): Promise<Result> {
  const root = requireRoot(ctx);
  if ('ok' in root) return root;
  if (typeof args.job !== 'string') return fail('invalid_arguments', { field: 'job' });
  if (typeof args.request_id !== 'string' || !REQUEST_ID.test(args.request_id)) {
    return fail('invalid_arguments', { field: 'request_id' });
  }
  const answer = block(args.answer, 16 * 1024);
  if (!answer) return fail('invalid_arguments', { field: 'answer' });
  const receipt = loadReceipt(ctx.home, args.job);
  if (!receipt || !owned(ctx, receipt)) return fail('not_found', { field: 'job' });
  if (receipt.executor.kind === 'jev') {
    return fail('handoff', {
      job: receipt.job,
      request_id: args.request_id,
      location: { kind: 'jev', job: receipt.executor.job },
      reason: 'unsupported_channel',
    });
  }
  if (receipt.binding.harness !== 'pi') {
    return fail('handoff', {
      job: receipt.job,
      request_id: args.request_id,
      location: herdrLocation(receipt),
      reason: 'unsupported_channel',
    });
  }
  const qa = join(jobDirectory(ctx.home, receipt.job), 'qa');
  if (receipt.pi_dispatch) {
    if (!answer.trim()) return fail('invalid_arguments', { field: 'answer' });
    try {
      if (fs.realpathSync(qa) !== qa) return fail('request_missing');
    } catch {
      return fail('request_missing');
    }
  }
  const question = join(qa, `${args.request_id}.md`);
  try {
    if (!fs.lstatSync(question).isFile())
      return fail('request_missing', { job: receipt.job, request_id: args.request_id });
  } catch {
    return fail('request_missing', { job: receipt.job, request_id: args.request_id });
  }
  const target = join(qa, `${args.request_id}.answer.md`);
  const body = answer.endsWith('\n') ? answer : `${answer}\n`;
  return withLock(ctx.home, `job-${receipt.job}`, async () => {
    try {
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink() || !info.isFile()) return fail('request_missing', { request_id: args.request_id });
      const current = receipt.pi_dispatch ? dispatchText(target, 16 * 1024 + 1) : fs.readFileSync(target, 'utf8');
      // Only demonstrably empty/stale answers may be refreshed. Unreadable or
      // oversized files are not permission to overwrite an eligible answer.
      if (current === null) return fail('conflict', { job: receipt.job, request_id: args.request_id });
      const refresh = receipt.pi_dispatch && (!current.trim() || info.mtimeMs < fs.lstatSync(question).mtimeMs);
      if (refresh) {
        writePrivate(target, body);
        return { ok: true, job: receipt.job, request_id: args.request_id, idempotent: false, consumed: false };
      }
      if (current === body) {
        return { ok: true, job: receipt.job, request_id: args.request_id, idempotent: true, consumed: false };
      }
      return fail('conflict', { job: receipt.job, request_id: args.request_id });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return fail('request_missing', { request_id: args.request_id });
    }
    writePrivate(target, body);
    return { ok: true, job: receipt.job, request_id: args.request_id, idempotent: false, consumed: false };
  });
}

export async function hudClose(ctx: FacadeContext, args: Record<string, unknown>): Promise<Result> {
  const root = requireRoot(ctx);
  if ('ok' in root) return root;
  if (typeof args.job !== 'string') return fail('invalid_arguments', { field: 'job' });
  const receipt = loadReceipt(ctx.home, args.job);
  if (!receipt || !owned(ctx, receipt)) return fail('not_found', { field: 'job' });
  if (receipt.state === 'closed') {
    return { ok: true, job: receipt.job, closed: true, idempotent: true, observation: receipt.closed_observation };
  }
  if (receipt.executor.kind === 'jev') return closeJev(ctx, receipt);
  if (receipt.pi_dispatch) return closeDispatch(ctx, receipt);
  try {
    return await withLock(
      ctx.home,
      keyLock(receipt.parent, receipt.request_key),
      async () => {
        const current = loadReceipt(ctx.home, receipt.job) ?? receipt;
        if (current.state === 'closed') {
          return {
            ok: true,
            job: current.job,
            closed: true,
            idempotent: true,
            observation: current.closed_observation,
          };
        }
        requireHerdr(current);
        const run = runner(ctx);
        if (current.steps.tab_closed) {
          return finishClose(ctx.home, current, 'already_gone');
        }
        let tabId = current.executor.tab_id;
        if (!tabId) {
          const found = await lookupTab(run, current.label);
          if (found === 'timeout') return herdrTimeout(current);
          if (found === 'absent') return finishClose(ctx.home, current, 'already_gone');
          if (found === 'unresolved') return fail('close_unresolved', { job: current.job });
          tabId = found.tabId;
          current.executor = {
            ...current.executor,
            tab_id: tabId,
            workspace_id: found.workspaceId ?? current.executor.workspace_id,
          };
        }
        let quitOk = false;
        if (current.steps.launch === 'acked') {
          const quit = await run(promptArgs(current.executor.agent, '/quit', false));
          if (quit.reason === 'timeout') return herdrTimeout(current);
          quitOk = quit.ok;
        }
        const closed = await run(['tab', 'close', tabId]);
        if (closed.reason === 'timeout') return herdrTimeout(current);
        if (!closed.ok) {
          const still = await lookupTab(run, current.label);
          if (still === 'timeout') return herdrTimeout(current);
          if (still === 'absent') return finishClose(ctx.home, current, 'already_gone');
          if (still === 'unresolved') return fail('close_unresolved', { job: current.job });
          return fail('close_failed', {
            job: current.job,
            observation: quitOk ? 'quit_only' : 'unconfirmed',
          });
        }
        return finishClose(ctx.home, current, quitOk ? 'quit_and_closed' : 'tab_closed');
      },
      ctx.lockWaitMs
    );
  } catch (error) {
    if (error instanceof LockBusy) return fail('busy', { job: receipt.job });
    throw error;
  }
}

function finishClose(home: string, receipt: JobReceipt, observation: string): Result {
  receipt.state = 'closed';
  receipt.steps.tab_closed = true;
  receipt.closed_observation = observation;
  remember(home, receipt);
  return {
    ok: true,
    job: receipt.job,
    closed: true,
    idempotent: false,
    observation,
    report_path: join(jobDirectory(home, receipt.job), 'report.md'),
  };
}

type OpenRuntime = () => Promise<JevRuntimeHandle>;

/**
 * One Jev adapter for this HUD home. The runtime handle is created on the first
 * Jev call and reused. Pass `injected` in tests so nothing starts a child or
 * reads the owner jev-ask config.
 */
export function createRoleJevExecutor(home: string, injected?: JevRuntimeHandle | null): JevExecutor {
  const openRuntime = connectRoleRuntime(home, injected);
  return {
    id: 'jev',
    runtime: openRuntime,
    launch: (ctx, request) => launchJev(ctx, request, openRuntime),
  };
}

async function launchJev(ctx: FacadeContext, request: JevLaunchRequest, openRuntime: OpenRuntime): Promise<Result> {
  const parent = parentOf(request.root);
  const runtimeKey = runtimeRequestKey(parent, request.requestKey);
  try {
    return await withLock(
      ctx.home,
      keyLock(parent, request.requestKey),
      async () => {
        const existing = readPrivateJson(indexPath(ctx.home, request.root, request.requestKey), 4096);
        if (existing !== undefined) {
          if (!isRecord(existing) || existing.schema !== 1 || typeof existing.job !== 'string') {
            return fail('receipt_unreadable');
          }
          const receipt = loadReceipt(ctx.home, existing.job);
          if (!receipt || receipt.request_key !== request.requestKey || receipt.parent !== parent) {
            return fail('receipt_unreadable');
          }
          if (receipt.fingerprint !== request.fingerprint || existing.fingerprint !== request.fingerprint) {
            return fail('conflict', { job: receipt.job });
          }
          if (receipt.executor.kind !== 'jev') return fail('conflict', { job: receipt.job });
          if (receipt.state === 'closed' || receipt.executor.job) return present(ctx.home, receipt, true);
          if (!receipt.jev_input) return fail('receipt_unreadable');
          return submitJev(ctx, receipt, openRuntime);
        }
        const mapped = mapJevLaunch(request);
        if (!mapped.ok) return fail('invalid_arguments', { field: mapped.field });
        const job = `j${randomBytes(8).toString('hex')}`;
        const text = request.task ?? request.input?.text ?? request.input?.statements[0]?.statement ?? 'job';
        const receipt: JobReceipt = {
          schema: 1,
          job,
          parent,
          request_key: request.requestKey,
          fingerprint: request.fingerprint,
          role: request.role,
          phase: request.phase,
          routing_revision: request.routingRevision,
          preset: request.preset,
          jev_decisions: request.jevDecisions,
          binding: request.binding,
          cwd: request.cwd ?? ctx.home,
          task_label: taskLabel(text),
          label: `${request.role}:${job.slice(1, 9)}`,
          state: 'launching',
          launch_error: null,
          prompted: false,
          steps: { tab_create: 'unsent', launch: 'unsent', rename: 'unsent', prompt: 'unsent', tab_closed: false },
          executor: { kind: 'jev', job: null },
          closed_observation: null,
          jev_tag: mapped.tag,
          runtime_request_key: runtimeKey,
          jev_input: mapped.input,
        };
        saveReceipt(ctx.home, receipt);
        writePrivate(
          indexPath(ctx.home, request.root, request.requestKey),
          JSON.stringify({ schema: 1, job, fingerprint: request.fingerprint, parent } satisfies KeyIndex) + '\n'
        );
        writeAssociation(ctx.home, associationOf(ctx.home, receipt, false));
        return submitJev(ctx, receipt, openRuntime);
      },
      ctx.lockWaitMs
    );
  } catch (error) {
    if (error instanceof LockBusy) return busyJob(ctx, request.root, request.requestKey);
    throw error;
  }
}

/** Body for `createJob`. Comes from the receipt, including on a retry. */
function jevBody(receipt: JobReceipt): JevCreateRequest | null {
  if (receipt.executor.kind !== 'jev' || !receipt.jev_input || !receipt.runtime_request_key) return null;
  let root: ReturnType<typeof parseRosterRoot>;
  try {
    root = parseRosterRoot(receipt.parent);
  } catch {
    return null;
  }
  return {
    requestKey: receipt.runtime_request_key,
    session: { namespace: root.namespace, sessionId: root.sessionId },
    jevDecisions: {
      id: receipt.jev_decisions.id,
      provider: receipt.jev_decisions.provider,
      model: receipt.jev_decisions.model,
    },
    input: receipt.jev_input,
  };
}

async function submitJev(ctx: FacadeContext, receipt: JobReceipt, openRuntime: OpenRuntime): Promise<Result> {
  if (receipt.executor.kind !== 'jev') return fail('conflict', { job: receipt.job });
  if (receipt.state === 'closed') return present(ctx.home, receipt, true);
  const body = jevBody(receipt);
  if (!body) return fail('receipt_unreadable');
  try {
    const runtime = await openRuntime();
    const job = await createJevJob(runtime, body);
    receipt.executor = { kind: 'jev', job: job.id };
    receipt.state = facadeState(job.state, job.result);
    receipt.launch_error = null;
    receipt.jev_seq = job.seq;
    remember(ctx.home, receipt);
    const view = present(ctx.home, receipt, false);
    return { ...view, result: job.result ?? null, recoverable: job.recoverable === true };
  } catch (error) {
    return jevCallError(ctx.home, receipt, error);
  }
}

/** One lost acknowledgement is the same `requestKey` again. The runtime dedupes it. */
async function createJevJob(
  runtime: JevRuntimeHandle,
  body: Parameters<JevRuntimeHandle['createJob']>[0]
): Promise<Awaited<ReturnType<JevRuntimeHandle['createJob']>>> {
  try {
    return await runtime.createJob(body);
  } catch (error) {
    if (!isLostAck(error)) throw error;
    return runtime.createJob(body);
  }
}

function jevCallError(home: string, receipt: JobReceipt, error: unknown): Result {
  const code = jevErrorCode(error);
  if (isRuntimeStartError(error)) {
    remember(home, receipt);
    return fail('backend_unavailable', { executor: 'jev', reason: code, job: receipt.job });
  }
  if (code === 'association_conflict' || code === 'conflict' || code === 'invalid_request') {
    return fail(code, { job: receipt.job });
  }
  receipt.state = 'launch_unknown';
  receipt.launch_error = 'launch_unknown';
  remember(home, receipt);
  return fail('launch_unknown', { job: receipt.job, executor: receipt.executor });
}

/** Read, send, and close leave the receipt where it was. */
function runtimeCallError(receipt: JobReceipt, error: unknown): Result {
  const code = jevErrorCode(error);
  if (isRuntimeStartError(error)) {
    return fail('backend_unavailable', { executor: 'jev', reason: code, job: receipt.job });
  }
  return fail('runtime_unavailable', { executor: 'jev', reason: code, job: receipt.job });
}

async function readJev(ctx: FacadeContext, receipt: JobReceipt, waitMs: number): Promise<Result> {
  if (receipt.executor.kind !== 'jev') return fail('internal_error');
  const openRuntime = ctx.jev?.runtime;
  if (!openRuntime) return fail('backend_unavailable', { executor: 'jev', reason: 'pending R3' });
  if (!receipt.executor.job) return observation(ctx.home, receipt, null);
  let runtime: JevRuntimeHandle;
  try {
    runtime = await openRuntime();
  } catch (error) {
    return runtimeCallError(receipt, error);
  }
  const jobId = receipt.executor.job;
  let job: Awaited<ReturnType<JevRuntimeHandle['readJob']>>;
  try {
    job = await readRoleJevJob(runtime, jobId, {
      waitMs,
      ...(typeof receipt.jev_seq === 'number' ? { afterSeq: receipt.jev_seq } : {}),
    });
  } catch (error) {
    if (jevErrorCode(error) === 'not_found') return fail('not_found', { field: 'job' });
    return runtimeCallError(receipt, error);
  }
  try {
    return await withLock(
      ctx.home,
      keyLock(receipt.parent, receipt.request_key),
      async () => {
        const current = loadReceipt(ctx.home, receipt.job) ?? receipt;
        if (current.state === 'closed') return observation(ctx.home, current, 'closed');
        const state = facadeState(job.state, job.result);
        current.state = state;
        current.jev_seq = job.seq;
        if (state === 'closed') current.closed_observation ??= 'closed';
        remember(ctx.home, current);
        const status = state === 'error' ? (job.error?.code ?? 'error') : resultStatus(job.result);
        return {
          ...observation(ctx.home, current, status),
          state,
          result: job.result ?? null,
          recoverable: job.recoverable === true,
          error: job.error ?? null,
        };
      },
      ctx.lockWaitMs
    );
  } catch (error) {
    if (error instanceof LockBusy) return fail('busy', { job: receipt.job });
    throw error;
  }
}

function resultStatus(result: unknown): string | null {
  if (!isRecord(result) || typeof result.status !== 'string') return null;
  return result.status;
}

async function sendJev(ctx: FacadeContext, receipt: JobReceipt, messageKey: string, text: string): Promise<Result> {
  if (receipt.executor.kind !== 'jev') return fail('internal_error');
  if (receipt.state === 'launching' || receipt.state === 'launch_unknown') {
    return fail('launch_unknown', { job: receipt.job });
  }
  if (receipt.state === 'closed') return fail('job_closed', { job: receipt.job });
  if (receipt.jev_tag !== 'browse') {
    return fail('unsupported', { job: receipt.job, reason: 'follow_up_requires_browse' });
  }
  if (!receipt.executor.job) return fail('launch_unknown', { job: receipt.job });
  const openRuntime = ctx.jev?.runtime;
  if (!openRuntime) return fail('backend_unavailable', { executor: 'jev', reason: 'pending R3' });
  const jobId = receipt.executor.job;
  try {
    return await withLock(
      ctx.home,
      `job-${receipt.job}`,
      async () => {
        const runtime = await openRuntime();
        const job = await runtime.sendFollowUp(jobId, { key: followKey(messageKey), text });
        if (job.followUp && job.followUp.supported === false) {
          return fail('unsupported', { job: receipt.job, reason: job.followUp.code });
        }
        return { ok: true, job: receipt.job, message_key: messageKey, idempotent: false };
      },
      ctx.lockWaitMs
    );
  } catch (error) {
    if (error instanceof LockBusy) return fail('busy', { job: receipt.job });
    if (jevErrorCode(error) === 'not_found') return fail('not_found', { field: 'job' });
    return runtimeCallError(receipt, error);
  }
}

function followKey(messageKey: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/.test(messageKey)) return messageKey;
  return runtimeRequestKey('message', messageKey);
}

async function closeJev(ctx: FacadeContext, receipt: JobReceipt): Promise<Result> {
  if (receipt.executor.kind !== 'jev') return fail('internal_error');
  const openRuntime = ctx.jev?.runtime;
  try {
    return await withLock(
      ctx.home,
      keyLock(receipt.parent, receipt.request_key),
      async () => {
        const current = loadReceipt(ctx.home, receipt.job) ?? receipt;
        if (current.executor.kind !== 'jev') return fail('internal_error');
        if (current.state === 'closed') {
          return {
            ok: true,
            job: current.job,
            closed: true,
            idempotent: true,
            observation: current.closed_observation,
          };
        }
        let runtimeId = current.executor.job;
        if (!runtimeId && current.state === 'launch_unknown') {
          if (!openRuntime) return fail('backend_unavailable', { executor: 'jev', reason: 'pending R3' });
          const body = jevBody(current);
          if (!body) return fail('receipt_unreadable');
          try {
            const runtime = await openRuntime();
            const job = await createJevJob(runtime, body);
            runtimeId = job.id;
            current.executor = { kind: 'jev', job: job.id };
            current.jev_seq = job.seq;
            remember(ctx.home, current);
          } catch (error) {
            if (jevErrorCode(error) === 'not_found') return finishClose(ctx.home, current, 'already_gone');
            return runtimeCallError(current, error);
          }
        }
        if (runtimeId) {
          if (!openRuntime) return fail('backend_unavailable', { executor: 'jev', reason: 'pending R3' });
          try {
            const runtime = await openRuntime();
            await runtime.closeJob(runtimeId);
          } catch (error) {
            if (jevErrorCode(error) === 'not_found') return finishClose(ctx.home, current, 'already_gone');
            return runtimeCallError(current, error);
          }
        }
        return finishClose(ctx.home, current, 'jev_closed');
      },
      ctx.lockWaitMs
    );
  } catch (error) {
    if (error instanceof LockBusy) return fail('busy', { job: receipt.job });
    return runtimeCallError(receipt, error);
  }
}
