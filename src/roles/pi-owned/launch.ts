/** Owned launch orchestration. PR4 opts into this seam; no production selection here. */
import * as fs from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildWorkerArgv } from './argv.js';
import {
  readOwnedText,
  readSlotContract,
  record,
  slotPaths,
  validateSlotContract,
  type ContractContext,
  type SlotContract,
} from './contracts.js';
import { Deadline, ExecutionError, Runtime, save, selfStamp, type Journal, type RuntimeOptions } from './runtime.js';
import { submitPrompt } from './prompt.js';
import { writePrivate } from '../job-store.js';
import { runCommand } from '../herdr-run.js';

export const LAUNCH_BUDGET_MS = 300_000;
export interface LaunchOptions extends RuntimeOptions {
  /** Facade-owned durable transaction evidence; never created by the launcher. */
  indexPath: string;
  associationPath: string;
  envProfile?: string;
}
export interface LaunchResult {
  state: 'acked' | 'launch_unknown';
  reason?: string;
  journal?: Journal;
}
const integrations = new Map<string, { path: string; version: number; text: string; identity: string }>();
function fileIdentity(path: string): string {
  const info = fs.lstatSync(path, { bigint: true });
  return `${info.dev}:${info.ino}:${info.ctimeNs}:${info.mtimeNs}:${info.size}`;
}
function executable(name: string, env: NodeJS.ProcessEnv): void {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    try {
      fs.accessSync(join(directory, name), fs.constants.X_OK);
      return;
    } catch {
      /* next */
    }
  }
  throw new ExecutionError(`${name}_unavailable`);
}
export async function preflightOwned(
  runtime: Runtime,
  contract: SlotContract,
  options: RuntimeOptions & { envProfile?: string }
): Promise<void> {
  if (options.envProfile) throw new ExecutionError('unsupported_env_profile');
  executable('herdr', runtime.env);
  executable('pi', runtime.env);
  const key = `${await runtime.instance()}\0${runtime.env.PATH}`;
  let cached = integrations.get(key);
  if (!cached) {
    const out = await runtime.call(['integration', 'status']);
    const match = out.ok && /^\s*pi:\s+current\s+\(v([1-9][0-9]*)\)\s+\(([^\r\n]+)\)\s*$/m.exec(out.stdout);
    if (!match) throw new ExecutionError('herdr_pi_integration_missing: herdr integration install pi');
    const path = match[2]!;
    cached = { path, version: Number(match[1]), text: readOwnedText(path, 256 * 1024), identity: fileIdentity(path) };
    integrations.set(key, cached);
  }
  if (
    cached.path !== contract.herdr_integration.path ||
    cached.version !== contract.herdr_integration.version ||
    fileIdentity(cached.path) !== cached.identity ||
    readOwnedText(cached.path, 256 * 1024) !== cached.text
  )
    throw new ExecutionError('herdr_pi_integration_missing: herdr integration install pi');
  // validateSlotContract has independently verified the managed header/resource hashes.
}
function evidence(context: ContractContext, options: LaunchOptions): void {
  const home = join(context.jobDirectory, '../..');
  for (const path of [join(context.jobDirectory, 'receipt.json'), options.indexPath, options.associationPath]) {
    let raw: unknown;
    try {
      raw = JSON.parse(readOwnedText(path, 64 * 1024, home));
    } catch {
      throw new ExecutionError('transaction_missing');
    }
    if (!record(raw) || raw.job !== basename(context.jobDirectory)) throw new ExecutionError('transaction_missing');
  }
}
export function projectSession(runtime: Runtime, journal: Journal): void {
  if (!journal.tab || !journal.left) return;
  const text = [
    `TASK=${basename(runtime.context.jobDirectory)}`,
    `TAB=${journal.tab}`,
    `TAB_NAME=${journal.label}`,
    `LEFT=${journal.left}`,
    `RIGHT=${journal.right ?? ''}`,
    'ORCH=',
    `BASE=${journal.base ?? 'HEAD'}`,
    `PRIMARY=${journal.name}`,
    '',
  ].join('\n');
  const file = join(runtime.context.jobDirectory, 'SESSION.txt');
  // SESSION is projection only; never use it as launch/cleanup authority.
  try {
    if (readOwnedText(file, 8192, runtime.context.jobDirectory) === text) return;
  } catch {
    /* initial projection */
  }
  writePrivate(file, text);
}
export async function newJournal(runtime: Runtime, contract: SlotContract, parent?: Journal): Promise<Journal> {
  return runtime.admitted(async () => {
    const previous = runtime.journal(contract.slot);
    if (previous) {
      if (
        previous.schema !== 1 ||
        previous.job !== contract.job ||
        previous.slot !== contract.slot ||
        previous.session_id !== contract.session_id ||
        previous.instance !== (await runtime.instance())
      )
        throw new ExecutionError('launch_unknown');
      return previous;
    }
    const nonce = randomUUID().replace(/-/g, '').slice(0, 16);
    const journal: Journal = {
      schema: 1,
      job: contract.job,
      slot: contract.slot,
      session_id: contract.session_id,
      instance: await runtime.instance(),
      launcher: selfStamp(),
      label: parent?.label ?? `hud-${contract.job}-${nonce}`,
      name: `hud-${contract.job}-${contract.slot}-${nonce}`,
      terminals: { ...parent?.terminals },
      ...(parent ? { tab: parent.tab, left: parent.left, right: parent.right, pane: parent.right } : {}),
      steps: {},
    };
    if (!parent) {
      const git = await runCommand('git', ['-C', contract.cwd, 'rev-parse', 'HEAD'], runtime.env, {
        budgetMs: runtime.deadline.remaining(15_000),
        signal: runtime.deadline.signal,
      });
      journal.base = git.ok && /^[a-f0-9]{40,64}$/.test(git.stdout.trim()) ? git.stdout.trim() : 'HEAD';
    }
    runtime.writeJournal(journal);
    return journal;
  });
}
/** Shared primary/helper start gate. A CLI ack alone is never startup evidence. */
export async function startSlot(runtime: Runtime, contract: SlotContract, journal: Journal): Promise<void> {
  if (journal.steps.start?.state === 'sent') {
    // Read-only reconciliation only. Startup and exact session/pane corroborate a lost reply.
    await runtime.owner(contract, journal);
    journal.steps.start = { state: 'acked' };
    runtime.writeJournal(journal);
  } else {
    await runtime.effect(journal, 'start', buildWorkerArgv(contract, journal.name, journal.pane!), 30_000, async () => {
      const { panes, agents } = await runtime.tab(journal);
      if (!panes.some((p) => p.pane_id === journal.pane) || agents.some((a) => a.pane_id === journal.pane))
        throw new ExecutionError('pane_occupied');
      // A pre-existing intended session is a collision, never permission to resume it.
      fs.mkdirSync(contract.session_dir, { recursive: true, mode: 0o700 });
      if (fs.readdirSync(contract.session_dir).some((name) => name.endsWith(`_${contract.session_id}.jsonl`)))
        throw new ExecutionError('session_collision');
    });
  }
  for (;;) {
    try {
      await runtime.owner(contract, journal);
      break;
    } catch (error) {
      if (!(error instanceof ExecutionError) || !['startup_unknown', 'inventory_unknown'].includes(error.message))
        throw error;
      await runtime.deadline.pause();
    }
  }
  await submitPrompt(runtime, contract, journal);
}
export async function launchOwned(context: ContractContext, options: LaunchOptions): Promise<LaunchResult> {
  const runtime = new Runtime(
    context,
    options,
    new Deadline(Math.min(options.budgetMs ?? LAUNCH_BUDGET_MS, LAUNCH_BUDGET_MS), options.signal)
  );
  let journal: Journal | undefined;
  try {
    evidence(context, options);
    const contract = readSlotContract(slotPaths(context.jobDirectory, 'primary').contract, context);
    if (contract.slot !== 'primary') throw new ExecutionError('invalid_contract');
    await preflightOwned(runtime, contract, options);
    journal = await newJournal(runtime, contract);
    const created = await runtime.effect(journal, 'tab', [
      'tab',
      'create',
      '--cwd',
      contract.cwd,
      '--label',
      journal.label,
      '--no-focus',
    ]);
    if (
      !record(created.tab) ||
      !record(created.root_pane) ||
      typeof created.tab.tab_id !== 'string' ||
      typeof created.root_pane.pane_id !== 'string' ||
      created.tab.tab_id === options.callerTabId
    )
      throw new ExecutionError('launch_unknown');
    journal.tab = created.tab.tab_id;
    journal.left = created.root_pane.pane_id;
    journal.pane = journal.left;
    await runtime.rememberPane(journal, journal.left);
    runtime.writeJournal(journal);
    projectSession(runtime, journal);
    if (contract.role === 'implementer') {
      const split = await runtime.effect(
        journal,
        'split',
        ['pane', 'split', journal.left, '--direction', 'right', '--ratio', '0.5', '--cwd', contract.cwd, '--no-focus'],
        15_000,
        async () => {
          await runtime.tab(journal!);
        }
      );
      if (!record(split.pane) || typeof split.pane.pane_id !== 'string') throw new ExecutionError('launch_unknown');
      // An acknowledged initial split is history, not authority to undo a later replacement.
      journal.right ??= split.pane.pane_id;
      await runtime.rememberPane(journal, journal.right);
      runtime.writeJournal(journal);
      projectSession(runtime, journal);
    }
    await startSlot(runtime, contract, journal);
    return { state: 'acked', journal };
  } catch (error) {
    return { state: 'launch_unknown', reason: error instanceof Error ? error.message : 'unknown', journal };
  }
}
/** PR3 helper contracts use the same release inventory and validation as primary. */
export function persistContract(contract: SlotContract, context: ContractContext): SlotContract {
  const validated = validateSlotContract(contract, context);
  const file = slotPaths(context.jobDirectory, validated.slot).contract;
  if (fs.existsSync(file)) throw new ExecutionError('contract_exists');
  save(file, validated, context.jobDirectory);
  return validated;
}
