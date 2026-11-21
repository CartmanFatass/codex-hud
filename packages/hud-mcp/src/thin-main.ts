/** Local HUD role tools and Codex statusline, newline-delimited JSON-RPC over stdio. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { cliWorkerTools, procStat, readTurn, REPORT_READ_EXIT, reportSignature, saveTurn, withDonePrompt, workerAlive, writeTurn } from './cli-judge.js';
import { readCodexStatusline, statuslineResource, statuslineTool } from './codex-statusline.js';
import { editTickets } from './local-tickets.js';
import { launchThinking, nearestThinking } from './launch-thinking.js';
import { reapWorkerTree } from '../../../src/roles/worker-tree.js';
import { isCliDirTrusted, propagateCliTrust } from '../../../src/cli/trust.js';
import { addWorktree, gitSummary, planWorktree, populateWorktree, type ManagedWorktree } from './managed-worktree.js';
import { jobChanges, jobRow, readJobProgress, type JobRow } from '../../../src/collectors/thin-jobs.js';
import { PanelActionLog } from '../../../src/collectors/panel-actions.js';
import { TryLog } from '../../../src/collectors/try-records.js';
import { cliKinds, type CliAgent } from '../../../src/roles/cli-kinds.js';
import { herdrId, runCommand, runHerdr } from '../../../src/roles/herdr-run.js';
import {
  roleRegistry,
  harnessDefaults,
  recordFailureExhaustion,
  describePlace,
  isQuotaFailure,
  markExhausted,
  readExhausted,
  executable,
  piSwitches,
  type Role,
  type RolePlace,
} from '../../../src/roles/roster.js';
import { HarnessSwitchError } from '../../../src/roles/harness-switches.js';
import { ROLE_TOOLS as tools } from '../../../src/roles/tool-definitions.js';
import { takeLease } from '../../../src/roles/lease.js';

const jobDir = process.env.HUD_JOB_DIR;
const isWorker = jobDir !== undefined;
const hudHome = isWorker ? dirname(dirname(fs.realpathSync(jobDir))) : resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
if (isWorker) process.env.HUD_HOME = hudHome; // The watcher and other subprocesses inherit the worker's HUD home.
const jobsRoot = join(hudHome, 'jobs');
const { ensureQueueWatcher, paneInfo, watching } = await import(new URL('../../../../bin/hud-notify.mjs', import.meta.url).href);
const bundled = fileURLToPath(new URL('../../../../', import.meta.url));
const worker = isWorker ? await import(new URL('../../../../bin/worker-tools.mjs', import.meta.url).href) : undefined;
function registry(cwd: string) {
  return roleRegistry(hudHome, cwd, process.env, undefined, undefined, bundled);
}
function jobCwd(args: Args): string {
  return resolve(args.cwd === undefined ? process.cwd() : required(args, 'cwd'));
}
type PiOptions = Partial<Record<(typeof piSwitches)[number], boolean>> & { pi_args?: string[] };
type LaunchAttempt = { index: number; place: string; reason?: string };
interface Job extends PiOptions {
  job: string;
  role: string;
  request_key: string;
  cwd: string;
  herdr_pane: string;
  created_at: string;
  package?: string;
  preset?: string;
  context_files?: string[];
  from_jobs?: string[];
  repair_of?: string;
  task_length?: number;
  create_options?: Args;
  model?: string | null;
  thinking?: string | null;
  model_source?: string | null;
  read_at?: string;
  parent_job?: string;
  pi_sent_at?: string;
  observed_at?: string;
  reaped_at?: string;
  worktree?: ManagedWorktree;
  worktree_removed_at?: string;
  worktree_kept_reason?: string;
  place?: RolePlace;
  place_key?: string;
  exhaustion_marked?: boolean;
  bro?: RolePlace;
  jev?: Role;
  cli?: { agent: CliAgent; can_continue: boolean; idle_grace_s: number; state_trust?: 'turn' | 'advisory' };
  attempts?: LaunchAttempt[];
  used_place?: string;
  dispatch_exit_code: number | null;
  dispatch_code?: 'untrusted_cwd' | 'unsupported_harness' | 'invalid_arguments';
  dispatch_path?: string;
  stderr_tail: string;
  message_keys: string[];
  send_outcomes?: { key: string; derived_key?: string; recorded_at?: string; exit_code: number | null; stderr_tail: string }[];
  role_skills?: { name: string; path: string }[];
  skipped_skills?: { name: string; reason: string }[];
  worker_prompt?: string | null;
}
type Args = Record<string, unknown>;
function required(args: Args, key: string): string {
  if (typeof args[key] !== 'string' || !args[key]) throw new Error(`invalid_arguments: ${key}`);
  return args[key] as string;
}
function derivedKey(kind: string, ...parts: unknown[]): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}
const DERIVED_KEY_WINDOW_MS = 10 * 60_000;
function withinRetryWindow(recordedAt: string | undefined, now: number): boolean {
  const age = now - Date.parse(recordedAt ?? '');
  return age >= 0 && age < DERIVED_KEY_WINDOW_MS;
}
function json<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function entries(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
function slice(file: string, limit: number): { text: string; truncated: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(limit + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, Math.min(size, limit)).toString('utf8'), truncated: size > limit };
  } finally {
    fs.closeSync(fd);
  }
}
function directory(job: string): string {
  return join(jobsRoot, job);
}
function save(job: Job, newAttempt = false): void {
  const file = join(directory(job.job), 'job.json');
  // A waiting read can stamp the report while dispatch/send is awaiting a CLI.
  const existing = newAttempt ? null : json<Job>(file);
  for (const key of ['read_at', 'observed_at', 'pi_sent_at'] as const) {
    const at = existing?.[key];
    if (at && (!job[key] || at > job[key])) job[key] = at;
  }
  for (const key of ['reaped_at', 'worktree_removed_at', 'worktree_kept_reason'] as const) {
    if (existing?.[key]) job[key] = existing[key];
  }
  if (existing?.exhaustion_marked) job.exhaustion_marked = true;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
function jobs(): Job[] {
  return entries(jobsRoot)
    .filter((id) => /^j[0-9a-f]{16}$/.test(id))
    .map((id) => json<Job>(join(directory(id), 'job.json')))
    .filter((job): job is Job => job !== null);
}
function findJob(id: string): Job | null {
  return /^j[0-9a-f]{16}$/.test(id) ? json<Job>(join(directory(id), 'job.json')) : null;
}
function primary(dir: string): string | null {
  return (
    slice(join(dir, 'SESSION.txt'), 16384)
      ?.text.match(/^PRIMARY=(.*)$/m)?.[1]
      ?.trim() || null
  );
}
function created(job: Job) {
  const task_dir = directory(job.job);
  const { report_unread: _unread, report_mtime: _mtime, question_ids: _questions, ...row } = readRow(job).row;
  const watch = callerPane ? { watcher_alive: watching(callerPane, hudHome) } : {};
  const thinking = job.thinking == null ? {} : { thinking: job.thinking };
  const launch = { attempts: job.attempts, used_place: job.used_place ?? null };
  if (job.dispatch_exit_code !== null && job.dispatch_exit_code !== 0 && row.display_state === 'failed') {
    return {
      ok: false,
      code: job.dispatch_code ?? 'dispatch_failed',
      ...(job.dispatch_path ? { path: job.dispatch_path } : {}),
      ...(job.dispatch_code === 'unsupported_harness' || job.dispatch_code === 'invalid_arguments' ? { error: job.stderr_tail } : {}),
      ...row,
      reason: job.attempts && job.attempts.length > 1 && !job.used_place
        ? job.attempts.map((a) => `${a.place}: ${a.reason}`).join('; ')
        : row.reason ?? (job.stderr_tail.trim() || `launch exited ${job.dispatch_exit_code}`),
      task_dir,
      agent: primary(task_dir),
      ...launch, ...thinking, ...watch,
    };
  }
  return { ...row, task_dir, agent: primary(task_dir), ...launch, ...thinking, ...watch };
}
function run(
  command: string,
  argv: string[],
  cwd?: string
): Promise<{ exit_code: number; stdout: string; stderr: string; notStarted: boolean }> {
  return new Promise((done) => {
    const child = spawn(command, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      stdout = (stdout + data).slice(-65536);
    });
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      stderr = (stderr + data).slice(-4096);
    });
    child.on('error', (error) => {
      stderr = (stderr + error.message).slice(-4096);
    });
    child.on('close', (code) => done({ exit_code: code ?? -1, stdout, stderr, notStarted: child.pid === undefined }));
  });
}
function refusedBeforeInput(result: Awaited<ReturnType<typeof run>>): boolean {
  if (result.exit_code === 0) return false;
  if (result.notStarted) return true;
  let code;
  try { code = JSON.parse(result.stdout)?.error?.code; } catch { /* Herdr can also render the error on stderr. */ }
  code ??= /^(?:Error:\s*)?(agent_not_ready|agent_not_found)(?=[:\s]|$)/.exec(result.stderr.trim())?.[1];
  return code === 'agent_not_ready' || code === 'agent_not_found';
}
async function dispatchBase(cwd: string): Promise<string> {
  const git = await run('git', ['rev-parse', 'HEAD'], cwd);
  return git.exit_code === 0 ? git.stdout.trim() : 'HEAD';
}
async function workspaceArgs(job: Job): Promise<string[]> {
  const result = await run('herdr', ['pane', 'get', job.herdr_pane]);
  if (result.exit_code !== 0) return [];
  try {
    const workspace = JSON.parse(result.stdout).result.pane.workspace_id;
    return herdrId(workspace) ? ['--workspace', workspace] : [];
  } catch {
    return [];
  } // An unavailable caller lookup keeps herdr's default workspace.
}
function ensureWatcher(): void {
  fs.mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
  const script = fileURLToPath(new URL('../../../../bin/hud-watch.mjs', import.meta.url));
  try {
    const pid = Number(fs.readFileSync(join(hudHome, 'watch.pid'), 'utf8').trim());
    process.kill(pid, 0);
    if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(script)) return;
  } catch {
    /* No live watcher; races may safely start two. */
  }
  const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.error(`hud-watch: ${error.message}`));
  fs.writeFileSync(join(hudHome, 'watch.pid'), `${child.pid}\n`, { mode: 0o600 });
  child.unref();
}
const wideChar = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
function cut(text: string, max: number): string {
  const chars = [...text],
    wide = (char: string) => (wideChar.test(char) ? 2 : 1);
  let columns = chars.reduce((sum, char) => sum + wide(char), 0);
  if (columns <= max) return text;
  while (chars.length && columns > max - 1) columns -= wide(chars.pop()!);
  return chars.join('').trimEnd() + '…';
}
/**
 * The worker's herdr tab label: `<role> <package or brief title>` in about 28 columns, on one line (it is recorded as
 * TAB_NAME and pi-role-reap compares it with the tab). A short job suffix is added only when another open job's tab
 * already has the same label.
 */
function tabLabel(job: Job, task: string): string {
  const lines = Buffer.from(task.slice(0, 4096)).subarray(0, 4096).toString('utf8').split(/\r?\n/);
  const title =
    job.package?.trim() || (lines.find((line) => /^#{1,6}\s/.test(line)) ?? lines.find((line) => line.trim()) ?? '');
  const label = cut(
    `${job.role} ${title.replace(/^#{1,6}\s+/, '')}`.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(),
    28
  );
  const taken = jobs().flatMap((other) =>
    other.job === job.job || other.reaped_at
      ? []
      : [slice(join(directory(other.job), 'SESSION.txt'), 4096)?.text.match(/^TAB_NAME=(.*)$/m)?.[1]]
  );
  return taken.includes(label) ? `${cut(label, 23)} ${job.job.slice(-4)}` : label;
}
/** A skill name is one path segment under `.hud/skills`. Anything else is not a link we made. */
function plainSkillName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');
}
function skillReason(path: string): string | null {
  let link = false;
  try {
    link = fs.lstatSync(path).isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  try {
    return fs.statSync(path).isDirectory() ? null : 'not_directory';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return link && (code === 'ENOENT' || code === 'ENOTDIR') ? 'broken' : 'unreadable';
  }
}
/** Role skill dirs and the worker prompt, after `--` and before the caller's `pi_args`. */
function piSkillArgs(job: Job, role: Role, place: RolePlace): string[] {
  const gate = registry(job.worktree?.main_root ?? job.cwd).project();
  const role_skills: { name: string; path: string }[] = [];
  const skipped_skills: { name: string; reason: string }[] = [];
  const args: string[] = [];
  for (const name of place.skills ?? role.skills ?? []) {
    if (!isAbsolute(name)) {
      if (!gate.registered) {
        skipped_skills.push({ name, reason: 'unresolved' });
        continue;
      }
      if (!plainSkillName(name)) {
        skipped_skills.push({ name, reason: 'invalid' });
        continue;
      }
    }
    const path = isAbsolute(name) ? name : join(gate.root, '.hud', 'skills', name);
    const reason = skillReason(path);
    if (reason) {
      skipped_skills.push({ name, reason });
      continue;
    }
    role_skills.push({ name, path });
    args.push('--skill', path);
  }
  let worker_prompt: string | null = null;
  if (gate.registered) {
    const agents = join(gate.root, '.hud', 'agents');
    const prompt = join(agents, `${role.role}.md`);
    try {
      if (dirname(prompt) === agents && fs.statSync(prompt).isFile()) {
        worker_prompt = prompt;
        args.push('--append-system-prompt', prompt);
      }
    } catch {
      /* Missing or broken prompt: no flag, launch continues. */
    }
  }
  job.role_skills = role_skills;
  job.skipped_skills = skipped_skills;
  job.worker_prompt = worker_prompt;
  return args;
}
async function dispatchPi(job: Job, role: Role, place: RolePlace, task: string): Promise<DispatchResult> {
  let openedTab: string | undefined;
  let mayHaveInput = false;
  const reject = (result: DispatchResult) => rejectLaunch(result, openedTab);
  try {
    const resources = piSkillArgs(job, role, place);
    const launcher = executable('pi-role');
    if (!launcher) throw new Error('pi-role not found on PATH');
    const dir = directory(job.job),
      output = join(dir, 'report.md');
    const piRole = place.pi_role ?? role.instructions;
    if (!piRole) throw new Error('missing pi_role');
    const argv: string[] = [
      '--args-json',
      piRole,
      '--task-dir',
      dir,
      '--role-output',
      output,
      '--dispatch-slot',
      'primary',
      '--dispatch-label',
      job.role,
      '--allow-write',
      output,
      '--qa-dir',
      join(dir, 'qa'),
    ];
    if (job.herdr_pane) {
      const notify = fileURLToPath(new URL('../../../../bin/hud-notify.mjs', import.meta.url));
      argv.push('--notify', [process.execPath, notify, hudHome, job.herdr_pane, job.job].map(quote).join(' '));
    }
    const instructionsName = role.instructions ?? role.role;
    if (plainSkillName(instructionsName)) {
      const instructions = join(bundled, 'instructions', `${instructionsName}.md`);
      if (fs.existsSync(instructions)) argv.push('--hud-instructions', instructions);
    }
    argv.push('--hud-sonic-jobs', join(bundled, 'bin', 'sonic-jobs.mjs'));
    if (place.thinking !== undefined) argv.push('--dispatch-effort-source', 'orchestrator');
    for (const key of ['lens', 'mcp', 'tps'] as const)
      if (job[key] !== undefined) argv.push(`--${job[key] ? '' : 'no-'}${key}`);
    if (job.ui_ext === false) argv.push('--no-ui-ext');
    if (job.skills === true) argv.push('--skills');
    argv.push('--', '--tui-mode', 'regular', '--hud-worker-tools', '-e',
      join(bundled, '../../integrations/pi/package/extensions/hud.mjs'));
    for (const key of ['model', 'thinking'] as const) if (place[key] !== undefined) argv.push(`--${key}`, place[key]);
    argv.push(...resources, ...(job.pi_args ?? []));
    const built = await run(launcher, argv, job.cwd);
    if (built.exit_code !== 0) return reject(built);
    const piArgs: string[] = JSON.parse(built.stdout);
    fs.mkdirSync(join(dir, 'qa'), { recursive: true });
    const base = job.worktree?.base_head ?? await dispatchBase(job.cwd);
    const tabName = tabLabel(job, task),
      name = `${job.job}-primary`;
    const result = await run('herdr', [
      'tab',
      'create',
      ...(await workspaceArgs(job)),
      '--cwd',
      job.cwd,
      '--label',
      tabName,
      '--env',
      `HUD_JOB_DIR=${dir}`,
      '--env',
      `HUD_HOME=${hudHome}`,
      '--no-focus',
    ]);
    if (result.exit_code !== 0) return reject(result);
    const { tab, root_pane } = JSON.parse(result.stdout).result;
    if (herdrId(tab?.tab_id)) openedTab = tab.tab_id;
    const left = root_pane?.pane_id;
    if (!openedTab || !herdrId(left)) throw new Error('tab create did not return tab/root pane ids');
    let right = '';
    const record = () => {
      const fields = {
        TASK: job.job,
        TAB: tab.tab_id,
        TAB_NAME: tabName,
        LEFT: left,
        RIGHT: right,
        ORCH: job.herdr_pane,
        BASE: base,
        PRIMARY: name,
      };
      if (Object.values(fields).some((value) => /[\r\n]/.test(value))) throw new Error('newlines in SESSION values');
      fs.writeFileSync(
        join(dir, 'SESSION.txt'),
        Object.entries(fields)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(''),
        { mode: 0o600 }
      );
    };
    record();
    if (job.split) {
      const split = await run('herdr', [
        'pane',
        'split',
        left,
        '--direction',
        'right',
        '--ratio',
        '0.5',
        '--cwd',
        job.cwd,
        '--no-focus',
      ]);
      if (split.exit_code !== 0) return reject(split);
      right = JSON.parse(split.stdout).result.pane.pane_id;
      if (!herdrId(right)) throw new Error('split did not return a pane id');
      record();
    }
    const started = await run('herdr', ['agent', 'start', name, '--kind', 'pi', '--pane', left, '--', ...piArgs]);
    if (started.exit_code !== 0) return reject(await startupFailure(started, left));
    const prompt = `Read ${join(dir, 'brief.md')} and do exactly what it asks.`;
    job.pi_sent_at = new Date().toISOString();
    save(job);
    mayHaveInput = true;
    const submitted = await run('herdr', [
      'agent',
      'prompt',
      name,
      prompt,
      '--wait',
      '--until',
      'working',
      '--timeout',
      '30000',
    ]);
    const status = json<{ task_dir?: string; slot?: string; state?: string; output_written?: boolean }>(
      join(dir, 'STATUS.json')
    );
    const completed = status?.task_dir === dir && status.slot === 'primary' && status.state === 'closed' && status.output_written;
    if (submitted.exit_code !== 0 && !completed) {
      if (refusedBeforeInput(submitted)) return reject(submitted);
      if (!(submitted.stderr + submitted.stdout).includes('agent_prompt_stalled')) return submitted;
      return run(process.execPath, [join(dirname(launcher), 'prompt-stall.mjs'), dir, name, left, prompt, '120000']);
    }
    return { ...submitted, exit_code: 0 };
  } catch (error) {
    const result = launchError(String(error));
    return mayHaveInput ? result : reject(result);
  }
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
async function dispatchBro(job: Job, task: string): Promise<DispatchResult> {
  const dir = directory(job.job),
    tabName = tabLabel(job, task);
  const result = await run('herdr', [
    'tab',
    'create',
    ...(await workspaceArgs(job)),
    '--cwd',
    job.cwd,
    '--label',
    tabName,
    '--env',
    `HUD_JOB_DIR=${dir}`,
    '--env',
    `HUD_HOME=${hudHome}`,
    '--no-focus',
  ]);
  if (result.exit_code !== 0) return rejectLaunch(result);
  let created;
  try {
    created = JSON.parse(result.stdout).result;
  } catch (error) {
    return { ...result, exit_code: 1, stderr: `herdr tab create: ${String(error)}` };
  }
  const { tab, root_pane } = created;
  if (!herdrId(tab?.tab_id) || !herdrId(root_pane?.pane_id)) throw new Error('tab create missing ids');
  fs.writeFileSync(
    join(dir, 'SESSION.txt'),
    `TASK=${job.job}\nTAB=${tab.tab_id}\nTAB_NAME=${tabName}\nLEFT=${root_pane.pane_id}\nORCH=${job.herdr_pane}\n`,
    { mode: 0o600 }
  );
  const script = fileURLToPath(new URL('../../../../bin/hud-jev.mjs', import.meta.url));
  return run('herdr', ['pane', 'run', root_pane.pane_id, [process.execPath, script, dir, String(task.length)].map(quote).join(' ')]);
}
function paneText(stdout: string): string {
  try {
    const result = JSON.parse(stdout).result;
    if (typeof result?.read?.text === 'string') return result.read.text;
    if (typeof result?.text === 'string') return result.text;
  } catch {
    /* A plain-text screen is the text itself. */
  }
  return stdout;
}
async function startupFailure(result: DispatchResult, pane: string): Promise<DispatchResult> {
  if (result.stderr.trim() && !/timed? out|timeout|agent_not_ready/i.test(result.stderr)) return result;
  const read = await runHerdr(['pane', 'read', pane, '--source', 'recent'], process.env, { budgetMs: 2000 });
  const reason = read.ok && paneText(read.stdout).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n')
    .reverse().map((line) => line.trim()).find((line) =>
      /^(?:\[roles\]|(?:\w*Error|fatal):)\s+\S/i.test(line) || isQuotaFailure(line));
  return reason ? { ...result, stderr: reason } : result;
}
function agentStatus(stdout: string): string | null {
  try {
    const status = JSON.parse(stdout).result?.agent?.agent_status;
    return typeof status === 'string' ? status : null;
  } catch {
    return null;
  }
}
/**
 * A startup spinner is `working`, then `done`, with no prompt. Prompting while it is still
 * working would accept that working; the following done must not be taken as a finished turn.
 * Returns a failed herdr result, or null when there is nothing to wait for or the wait settled.
 */
async function settlePhantomWorking(name: string) {
  const got = await run('herdr', ['agent', 'get', name]);
  if (agentStatus(got.stdout) !== 'working') return null;
  const waited = await run('herdr', [
    'agent',
    'wait',
    name,
    '--until',
    'done',
    '--until',
    'idle',
    '--timeout',
    '60000',
  ]);
  return waited.exit_code === 0 ? null : waited;
}
function supervisorPid(dir: string, status: Record<string, unknown> | null): number | null {
  try {
    const fromFile = Number(fs.readFileSync(join(dir, 'supervisor.pid'), 'utf8').trim());
    if (Number.isInteger(fromFile) && fromFile > 1) return fromFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const fromStatus = status?.supervisor_pid;
  return typeof fromStatus === 'number' && Number.isInteger(fromStatus) && fromStatus > 1 ? fromStatus : null;
}
function supervisorAlive(pid: number): boolean {
  const info = procStat(pid);
  if (info) return info.state !== 'Z';
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
function spawnCliSupervisor(dir: string): number | null {
  const script = fileURLToPath(new URL('../../../../bin/hud-cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, dir], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.error(`hud-cli: ${error.message}`));
  if (child.pid) fs.writeFileSync(join(dir, 'supervisor.pid'), `${child.pid}\n`, { mode: 0o600 });
  child.unref();
  return child.pid ?? null;
}
/** Trust refusals use the same STATUS keys as hud-cli.mjs if this is the last attempt. */
function failCli(dir: string, job: Job, place: RolePlace, reason: string) {
  const now = new Date().toISOString();
  const status = {
    version: 1,
    task_dir: fs.realpathSync(dir),
    slot: 'primary',
    harness: 'cli',
    agent: place.agent,
    role: job.role,
    model: job.model ?? null,
    thinking: job.thinking ?? null,
    state: 'failed',
    output_path: join(dir, 'report.md'),
    output_written: false,
    pid: null,
    pid_start_time: null,
    agent_session_id: null,
    started_at: now,
    settled_at: now,
    idle_deadline_at: null,
    ended_at: now,
    exit_reason: reason,
    error: reason,
    updated_at: now,
  };
  return { ...launchError(reason), status };
}
type DispatchResult = {
  exit_code: number; stdout: string; stderr: string; code?: Job['dispatch_code'];
  preInput?: boolean; cleanupFailed?: boolean; status?: object; path?: string;
};
const launchError = (stderr: string, code?: Job['dispatch_code']): DispatchResult => ({ exit_code: 1, stdout: '', stderr, code });
async function rejectLaunch(result: DispatchResult, tab?: string): Promise<DispatchResult> {
  const cleanup = tab && await runHerdr(['tab', 'close', tab], process.env, { budgetMs: 3000 });
  return { ...result, preInput: true, cleanupFailed: Boolean(cleanup && !cleanup.ok) };
}
async function dispatchCli(job: Job, place: RolePlace, instructions: string, task: string): Promise<DispatchResult> {
  let openedTab: string | undefined;
  let mayHaveInput = false;
  const reject = (result: DispatchResult) => rejectLaunch(result, openedTab);
  try {
    const kind = cliKinds[place.agent as CliAgent];
    const dir = directory(job.job);
    const untrusted = `${place.agent} has not trusted ${job.cwd}; run hud trust ${job.cwd}`;
    if (!isCliDirTrusted(place.agent!, job.cwd, process.env)) {
      return reject({ ...failCli(dir, job, place, untrusted), code: 'untrusted_cwd' });
    }
    const base = job.worktree?.base_head ?? await dispatchBase(job.cwd);
    const tabName = tabLabel(job, task),
      name = `${job.job}-primary`;
    const result = await run('herdr', [
      'tab',
      'create',
      ...(await workspaceArgs(job)),
      '--cwd',
      job.cwd,
      '--label',
      tabName,
      '--env',
      `HUD_JOB_DIR=${dir}`,
      '--env',
      `HUD_HOME=${hudHome}`,
      '--no-focus',
    ]);
    if (result.exit_code !== 0) return reject(result);
    const { tab, root_pane } = JSON.parse(result.stdout).result;
    if (herdrId(tab?.tab_id)) openedTab = tab.tab_id;
    const left = root_pane?.pane_id;
    if (!openedTab || !herdrId(left)) throw new Error('tab create did not return tab/root pane ids');
    const fields = {
      TASK: job.job,
      TAB: tab.tab_id,
      TAB_NAME: tabName,
      LEFT: left,
      RIGHT: '',
      ORCH: job.herdr_pane,
      BASE: base,
      PRIMARY: name,
    };
    if (Object.values(fields).some((value) => /[\r\n]/.test(value))) throw new Error('newlines in SESSION values');
    fs.writeFileSync(
      join(dir, 'SESSION.txt'),
      Object.entries(fields)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(''),
      { mode: 0o600 }
    );
    const argv = ['agent', 'start', name, '--kind', place.agent!, '--pane', left];
    if (kind.startTimeoutMs) argv.push('--timeout', String(kind.startTimeoutMs));
    argv.push(
      '--',
      ...(place.model ? kind.model(place.model) : []),
      ...(place.thinking ? kind.effort(place.thinking) : []),
      ...kind.bypass,
      ...(place.args ?? [])
    );
    const started = await run('herdr', argv);
    const notReady = started.exit_code !== 0 && `${started.stdout}\n${started.stderr}`.includes('agent_not_ready');
    if (started.exit_code !== 0 && !notReady) return reject(await startupFailure(started, left));
    if (kind.trust?.text) {
      const read = await run('herdr', ['pane', 'read', left, '--source', 'recent']);
      if (read.exit_code !== 0) return reject(notReady ? started : read);
      if (paneText(read.stdout).includes(kind.trust.text)) {
        const declined = await run('herdr', ['pane', 'send-keys', left, ...kind.trust.decline]);
        if (declined.exit_code !== 0) return reject(declined);
        await run('herdr', ['agent', 'wait', name, '--until', 'idle', '--until', 'unknown', '--timeout', '15000']);
        return reject(failCli(dir, job, place, untrusted));
      }
    }
    if (notReady) return reject(await startupFailure(started, left));
    if (kind.startupQuirk === 'phantom-working') {
      const settled = await settlePhantomWorking(name);
      if (settled) return reject(settled);
    }
    const turn = writeTurn(dir);
    const prompt = withDonePrompt(`Read ${instructions} and then ${join(dir, 'brief.md')} and do exactly what the brief asks.`, bundled, dir, turn, place.agent!);
    mayHaveInput = true;
    const submitted = await run('herdr', [
      'agent',
      'prompt',
      name,
      prompt,
      '--wait',
      '--until',
      'working',
      '--timeout',
      '30000',
    ]);
    if (refusedBeforeInput(submitted) && reportSignature(dir) === turn.report_sig) return reject(submitted);
    // An ambiguous submission still needs supervision; it is not worker death.
    if (!spawnCliSupervisor(dir)) return { exit_code: 1, stdout: '', stderr: 'hud-cli did not start' };
    return { exit_code: 0, stdout: '', stderr: '' };
  } catch (error) {
    const result = launchError(String(error));
    return mayHaveInput ? result : reject(result);
  }
}
function readRow(job: Job, markExhaustion = true) {
  const dir = directory(job.job);
  const file = join(dir, 'STATUS.json');
  let status = json<Record<string, unknown> & { state?: string; exit_reason?: string | null; error?: string | null }>(file);
  let row = jobRow(job, status, { dir });
  if (markExhaustion && row.display_state === 'failed' && !job.exhaustion_marked && status && row.reason) {
    const outcome = recordFailureExhaustion(hudHome, bundled, dir, job, row.reason);
    if (outcome.marked) {
      job.exhaustion_marked = true;
      status = {
        ...status,
        exit_reason: outcome.reason,
        ...(status.error ? { error: outcome.reason } : {}),
      };
      try {
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(status) + '\n', { mode: 0o600 });
        fs.renameSync(temp, file);
      } catch {
        /* Ignore transient STATUS.json write error. */
      }
      row = jobRow(job, status, { dir });
    }
  }
  return { row, status };
}

function failureUnobserved(job: Job): boolean {
  const observed = Date.parse(job.observed_at ?? '');
  if (!Number.isFinite(observed)) return true;
  try {
    const status = fs.statSync(join(directory(job.job), 'STATUS.json'), { throwIfNoEntry: false });
    return status !== undefined && Math.floor(status.mtimeMs) > observed;
  } catch { return true; }
}

function compactRow(row: JobRow) {
  const reason = row.blocked || row.state === 'waiting_orchestrator' || row.display_state === 'failed' ? row.reason : null;
  return {
    job: row.job,
    role: row.role,
    state: row.state ?? row.display_state,
    ...(row.report_unread ? { report_unread: true } : {}),
    ...(row.blocked ? { blocked: true } : {}),
    ...(row.question_ids.length ? { question_ids: row.question_ids } : {}),
    ...(reason ? { reason } : {}),
  };
}

async function peekJob(job: Job, { lines, detail }: Args) {
  const dir = directory(job.job);
  const { row } = readRow(job, false);
  const summary = {
    status: compactRow(row),
    ...readJobProgress(dir),
    ...(detail === true ? { diagnostics: { ...jobDiagnostics(job), display_state: row.display_state } } : {}),
  };
  if (lines === undefined) return summary;
  if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > 120)
    throw new Error('invalid_arguments: lines');
  let pane: string | undefined;
  try {
    const session = slice(join(dir, 'SESSION.txt'), 16384);
    if (!session?.truncated) pane = session?.text.split(/\r?\n/).find((line) => line.startsWith('LEFT='))?.slice(5);
  } catch { /* No readable pane receipt. */ }
  if (!herdrId(pane) || pane.startsWith('-')) return { ...summary, pane_lines: null, pane_reason: 'no pane' };
  const result = await runHerdr(['pane', 'read', pane, '--source', 'recent'], process.env, { budgetMs: 1000 });
  if (!result.ok) return { ...summary, pane_lines: null, pane_reason: result.reason };
  const output = paneText(result.stdout).replace(/\r?\n$/, '');
  return { ...summary, pane_lines: output ? output.split(/\r?\n/).slice(-lines) : [] };
}

function listJobs(recent: boolean) {
  const newest = jobs().sort((a, b) => b.created_at.localeCompare(a.created_at));
  const recentLimit = 20;
  if (recent) {
    return newest.slice(0, recentLimit).map((job) => {
      const { row } = readRow(job, !isWorker);
      return {
        job: row.job,
        role: row.role,
        state: row.state,
        display_state: row.display_state,
        reason: row.reason,
        blocked: row.blocked,
        open_questions: row.open_questions,
        report_present: row.report_present,
        report_unread: row.report_unread,
        created_at: job.created_at,
      };
    });
  }
  return newest.flatMap((job, index) => {
    // Scanning beyond recent history must not widen the list's quota side effects.
    const { row } = readRow(job, !isWorker && index < recentLimit);
    const failed = row.display_state === 'failed';
    if (
      row.display_state !== 'working' &&
      !row.blocked &&
      !row.report_unread &&
      !row.question_ids.length &&
      !(failed && failureUnobserved(job))
    ) return [];
    return [compactRow(row)];
  });
}

const settled = (state: string | null) => ['idle_grace', 'closed', 'done', 'failed', 'stopped'].includes(state ?? '');

async function waitJobs({ jobs: ids, mode = 'any', wait_ms = 60000 }: Args) {
  if (mode !== 'any' && mode !== 'all') throw new Error('invalid_arguments: mode');
  if (typeof wait_ms !== 'number' || !Number.isInteger(wait_ms) || wait_ms < 0 || wait_ms > 120000)
    throw new Error('invalid_arguments: wait_ms');
  const deadline = performance.now() + wait_ms;
  const readJob = (id: string) => json<Job>(join(directory(id), 'job.json'));
  let initial: JobRow[];
  if (ids === undefined) {
    initial = jobs().filter(isSessionJob).map((job) => readRow(job, false).row).filter((row) => !settled(row.state));
  } else {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !/^j[0-9a-f]{16}$/.test(id)))
      throw new Error('invalid_arguments: jobs');
    initial = [...new Set<string>(ids)].map((id) => {
      const job = readJob(id);
      if (!job) throw new Error(`invalid_arguments: unknown job ${id}`);
      return readRow(job, false).row;
    });
  }
  const targets = new Set(initial.map((row) => row.job));
  function result(rows: JobRow[]) {
    const allSettled = mode === 'all' && rows.length === targets.size && rows.every((row) => settled(row.state));
    const triggered = rows.filter((row) => allSettled || (mode === 'any' && settled(row.state)) ||
      row.blocked || row.state === 'waiting_orchestrator' || row.display_state === 'failed' || row.open_questions > 0
    ).map((row) => row.job);
    const ready = targets.size === 0 || triggered.length > 0;
    return { ready, timed_out: !ready && performance.now() >= deadline, triggered, jobs: rows.map(compactRow) };
  }
  const current = result(initial);
  if (current.ready || current.timed_out) return current;

  let watcher: fs.FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ReturnType<typeof result>>((resolve, reject) => {
      function check() {
        try {
          const rows = [...targets].flatMap((id) => {
            const job = readJob(id);
            return job ? [readRow(job, false).row] : [];
          });
          const next = result(rows);
          if (!next.ready && !next.timed_out) return false;
          resolve(next);
        } catch (error) {
          reject(error);
        }
        return true;
      }
      function tick() {
        if (!check()) timer = setTimeout(tick, Math.min(5000, Math.max(0, Math.ceil(deadline - performance.now()))));
      }
      try {
        watcher = fs.watch(jobsRoot, { recursive: true }, (_event, name) => {
          const [id, file] = name?.split('/') ?? [];
          if (!id || (targets.has(id) && (!file || ['job.json', 'STATUS.json', 'report.md', 'qa'].includes(file)))) check();
        });
        watcher.on('error', () => { watcher?.close(); watcher = undefined; });
      } catch { /* The safety timer still checks the target jobs. */ }
      tick(); // Check again after attaching so a change during setup cannot be missed.
    });
  } finally {
    watcher?.close();
    clearTimeout(timer);
  }
}

function openQuestions(dir: string): string[] {
  const qa = join(dir, 'qa');
  return entries(qa)
    .filter((name) => /^q\d+\.md$/.test(name))
    .filter((name) => !fs.existsSync(join(qa, name.replace('.md', '.answer.md'))))
    .sort();
}
function jobDiagnostics(job: Job) {
  return {
    cwd: job.cwd,
    ...(job.attempts ? { attempts: job.attempts, used_place: job.used_place ?? null } : {}),
    place: job.place,
    ...(job.preset !== undefined ? { preset: job.preset } : {}),
    model: job.model,
    thinking: job.thinking,
    model_source: job.model_source,
    ...(job.cli ? { idle_grace_s: job.cli.idle_grace_s } : {}),
    ...Object.fromEntries([...piSwitches, 'pi_args' as const].map((key) => [key, job[key]])),
    ...(job.role_skills !== undefined
      ? {
          role_skills: job.role_skills,
          skipped_skills: job.skipped_skills ?? [],
          worker_prompt: job.worker_prompt ?? null,
        }
      : {}),
    dispatch_exit_code: job.dispatch_exit_code,
    stderr_tail: job.stderr_tail,
  };
}
function observation(job: Job, full: boolean, detail: boolean) {
  const dir = directory(job.job);
  const { row, status } = readRow(job, !isWorker);
  const report = row.report_unread || full ? slice(join(dir, 'report.md'), 65536) : null;
  const questions = openQuestions(dir).map((name) => ({
    id: name.slice(0, -3),
    text: slice(join(dir, 'qa', name), 2048)?.text ?? '',
  }));
  const progress = readJobProgress(dir);
  const exit_reason = typeof status?.exit_reason === 'string' ? status.exit_reason : null;
  return {
    job: job.job,
    role: job.role,
    state: detail ? row.state : row.state ?? row.display_state,
    ...(detail || (row.state !== null && row.state !== row.display_state) ? { display_state: row.display_state } : {}),
    ...(detail || row.reason ? { reason: row.reason } : {}),
    ...(detail || row.blocked ? { blocked: row.blocked } : {}),
    ...(detail || exit_reason ? { exit_reason } : {}),
    ...(status?.quiet_decision && typeof status.quiet_decision === 'object' ? { quiet_decision: status.quiet_decision } : {}),
    ...(detail ? jobDiagnostics(job) : {}),
    ...(job.worktree ? { worktree: job.worktree } : {}),
    ...(job.worktree_removed_at ? { worktree_removed_at: job.worktree_removed_at } : {}),
    ...(job.worktree_kept_reason ? { worktree_kept_reason: job.worktree_kept_reason } : {}),
    report_exists: row.report_present,
    ...(detail || row.report_unread ? { report_unread: row.report_unread } : {}),
    ...(detail || progress.latest_progress ? progress : {}),
    ...(row.report_present && !report ? { report_unchanged: true } : {
      ...(detail || report ? { report: report?.text ?? null } : {}),
      ...(detail || report?.truncated ? { report_truncated: report?.truncated ?? false } : {}),
    }),
    ...(detail || questions.length ? { questions } : {}),
  };
}
async function readContextFile(path: string, limit: number | undefined) {
  const file = await fs.promises.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    if (limit !== undefined && stat.size > limit) return null;
    // Validate the whole file, but only keep the body for browser briefs.
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let content = '', bytes = 0;
    while (true) {
      const length = limit === undefined ? buffer.length : Math.min(buffer.length, limit - bytes + 1);
      const { bytesRead } = await file.read(buffer, 0, length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (limit !== undefined && bytes > limit) return null;
      const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      if (/[\x00-\x08\x0e-\x1f\x7f]/.test(text)) throw new Error('binary content');
      if (limit !== undefined) content += text;
    }
    decoder.decode(); // Reject an incomplete final UTF-8 sequence.
    return { bytes, content };
  } finally {
    await file.close();
  }
}

async function assembleContext(args: Args, cwd: string, inline: boolean, projectRoot: string, repairOf?: string) {
  const metadata: Pick<Job, 'context_files' | 'from_jobs'> = {};
  const sections: string[] = [];
  let remaining = 256 * 1024;
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside its root');
  };
  const append = async (path: string, label: string) => {
    const file = await readContextFile(path, inline ? Math.min(64 * 1024, remaining) : undefined);
    if (!file) return false;
    if (inline) {
      remaining -= file.bytes;
      let length = 3;
      for (const run of file.content.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
      const fence = '`'.repeat(length);
      sections.push(`### ${label}\n\n${fence}\n${file.content}${file.content.endsWith('\n') ? '' : '\n'}${fence}`);
    } else sections.push(`- ${label}`);
    return true;
  };
  const standingPath = join(projectRoot, '.hud', 'brief.md');
  let standing: string | undefined;
  let reference = '';
  try {
    const path = await fs.promises.realpath(standingPath);
    inside(projectRoot, path);
    if (inline) {
      if (!(await append(path, JSON.stringify(standingPath))))
        return { ok: false, code: 'context_too_large', error: standingPath } as const;
    } else {
      if (!(await fs.promises.stat(path)).isFile()) throw new Error('not a regular file');
      // A heading here could replace the title of a task written without one.
      reference = `Read the project standing brief: ${JSON.stringify(standingPath)}.\n\n`;
    }
    standing = path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      return { ok: false, code: 'invalid_arguments', error: `${standingPath} must resolve to a readable text file inside ${projectRoot}` } as const;
  }
  for (const [key, root, max] of [['context_files', cwd, 32], ['from_jobs', jobsRoot, 16]] as const) {
    const given = args[key];
    const repair = key === 'from_jobs' ? repairOf : undefined;
    if (given === undefined && !repair) continue;
    const values = given === undefined ? [] : given;
    if (!Array.isArray(values) || values.length > max || values.some((v) =>
      typeof v !== 'string' || !v || v.includes('\0') || (key === 'from_jobs' && !/^j[0-9a-f]{16}$/.test(v)))) {
      return { ok: false, code: 'invalid_arguments', error: `invalid ${key} (maximum ${max} entries)` } as const;
    }
    const recorded: string[] = metadata[key] = [];
    if (!values.length && !repair) continue;
    let source: string = key;
    try {
      const base = await fs.promises.realpath(root);
      const files = values.map((value) => ({ value, name: key === 'from_jobs' ? 'report' : '' }));
      if (repair) {
        if (!values.includes(repair)) files.push({ value: repair, name: 'report' });
        files.push({ value: repair, name: 'brief' });
      }
      for (const { value, name } of files) {
        source = `${key}: ${JSON.stringify(value)}`;
        const path = await fs.promises.realpath(resolve(root, name ? join(value, `${name}.md`) : value));
        inside(base, path);
        const label = `${name ? `${value} ${name}: ` : ''}${JSON.stringify(path)}`;
        if (path === standing) {
          if (!inline) await readContextFile(path, undefined); // Explicit context still requires UTF-8 text.
        } else if (!(await append(path, label))) {
          return { ok: false, code: 'context_too_large', error: source } as const;
        }
        if (!name || (name === 'report' && (value !== repair || values.includes(value)))) recorded.push(name ? value : path);
      }
    } catch {
      return { ok: false, code: 'invalid_arguments', error: `${source} must resolve to a readable UTF-8 text file inside ${root}` } as const;
    }
  }
  const block = !sections.length ? '' : inline
    ? `\n## Context\n\n${sections.join('\n\n')}\n`
    : `## Context References\n\nRead these files for task context:\n\n${sections.join('\n')}\n\n`;
  return { metadata, block: reference + block };
}

export async function sonicThinking(cwd: string) {
  const found = registry(cwd);
  const role = found.roles().get('sonic');
  if (!role) return;
  const active = found.assignment(role).places.find((place) => place.state === 'active');
  if (active) return launchThinking(hudHome, active.place.harness, active.model.value);
}

function placeOptions(args: Args, configured: RolePlace) {
  const place = { ...configured };
  const invalid = (error?: string) => ({ ok: false, code: 'invalid_arguments', error } as const);
  if (args.idle_grace_s !== undefined) {
    if (!Number.isInteger(args.idle_grace_s) || (args.idle_grace_s as number) < 60 || (args.idle_grace_s as number) > 3600)
      return invalid('idle_grace_s must be an integer from 60 to 3600');
    if (place.harness !== 'cli') return invalid(place.harness === 'pi'
      ? "idle_grace_s is CLI-only; pi grace follows the model's cache lifetime inside pi-roles"
      : 'idle_grace_s is CLI-only; browser jobs have no idle grace');
  }
  if (args.kind !== undefined) {
    if (place.harness !== 'bro' || place.tool !== 'jev-flow' || (args.kind !== 'image' && args.kind !== 'video')) return invalid();
    place.kind = args.kind;
  } else if (place.harness === 'bro' && place.tool === 'jev-flow' && !place.kind) place.kind = 'image';
  if (place.harness === 'bro' && (args.model !== undefined || args.thinking !== undefined || args.isolation === 'worktree'))
    return invalid(args.isolation === 'worktree' ? 'worktree isolation is local-only' : undefined);
  if (args.thinking !== undefined) place.thinking = required(args, 'thinking');
  const options: PiOptions = place.harness === 'pi' ? { split: place.split ?? false, pi_args: place.pi_args ?? [] } : {};
  for (const key of piSwitches) {
    const value = args[key];
    if (value !== undefined) {
      if (place.harness !== 'pi' || typeof value !== 'boolean') return invalid();
      options[key] = value;
    } else if (key !== 'skills' && place.harness === 'pi' && place[key] !== undefined) options[key] = place[key];
  }
  if (args.pi_args !== undefined) {
    if (place.harness !== 'pi' || !Array.isArray(args.pi_args) || args.pi_args.length > 128 ||
      args.pi_args.some((value) => typeof value !== 'string' || value.length > 4096)) return invalid();
    if (args.pi_args.some((value) => /^--(?:orchestrator|notify)(?:=|$)/.test(value)))
      return invalid('pi_args cannot override --orchestrator or --notify caller binding');
    options.pi_args = args.pi_args;
  }
  return { place, options };
}

const piOptionKeys = [...piSwitches, 'pi_args'] as const;
const replayOptions = ['on', 'model', 'thinking', 'isolation', 'idle_grace_s', 'kind', 'context_files', ...piOptionKeys] as const;
function jobOptions(job: Job): Args {
  return {
    role: job.role, cwd: job.worktree?.main_root ?? job.cwd, package: job.package, preset: job.preset,
    context_files: job.context_files, from_jobs: job.from_jobs,
    ...(job.create_options ?? {
      isolation: job.worktree ? 'worktree' : undefined,
      model: job.model_source === 'hud_create' ? job.model : undefined,
      thinking: job.thinking ?? undefined, idle_grace_s: job.cli?.idle_grace_s, kind: job.bro?.kind,
      ...Object.fromEntries(piOptionKeys.map((key) => [key, job[key]])),
    }),
  };
}
function originalTask(job: Job): string {
  const brief = fs.readFileSync(join(directory(job.job), 'brief.md'), 'utf8');
  if (job.task_length !== undefined) return brief.slice(0, job.task_length);
  // Old receipts only have the assembled brief. Strip HUD-generated context and instructions.
  return brief.split(/\n## Context References\n\nRead these files for task context:\n|\n## Context\n\n### |\nFinish with `hud_report`\.\n$|\nThis harness uses the commands below instead of the worker tools named in your role\./, 1)[0].trimEnd();
}

export async function dispatchJob(input: Args, pane: string | undefined, parentJob?: string, repair?: { job: string; derived: boolean }) {
  const retryOf = input.retry_of === undefined ? undefined : required(input, 'retry_of');
  let args = input;
  let repairOf = repair?.job;
  if (retryOf) {
    const source = findJob(retryOf);
    if (!source) return { ok: false, code: 'job_not_found' };
    const { row } = readRow(source);
    if (row.state !== 'failed' && row.state !== 'stopped') return { ok: false, code: 'not_retryable' };
    const inherited = jobOptions(source);
    delete inherited.on; // Retry through the role's chain instead of pinning the previous harness.
    if (input.on !== undefined) delete inherited.preset;
    args = { ...inherited, task: input.task === undefined ? originalTask(source) : input.task, ...input };
    repairOf = input.from_jobs === undefined ? source.repair_of : undefined;
  }
  const role = required(args, 'role');
  const cwd = jobCwd(args);
  // An explicit key can retrieve a prior job even when other arguments in the retry differ.
  const requestKey = args.request_key === undefined
    ? derivedKey(retryOf ? 'retry' : 'create', pane, role, cwd, required(args, 'task'), retryOf)
    : required(args, 'request_key');
  const windowedKey = args.request_key === undefined || repair?.derived === true;
  return keyLock(`request:${requestKey}`, () =>
    dispatchWithKey(args, pane, requestKey, windowedKey, parentJob, repairOf, retryOf ? input : undefined));
}

async function dispatchWithKey(args: Args, pane: string | undefined, request_key: string, windowedKey: boolean, parentJob?: string, repairOf?: string, retryInput?: Args) {
  const asked = required(args, 'role');
  const cwd = jobCwd(args);
  const found = registry(cwd);
  // `architect` names oracle unless a role file defines its own architect.
  const role = asked === 'architect' && !found.roles().has(asked) ? 'oracle' : asked;
  const definition = found.roles().get(role);
  if (!definition) {
    const invalid = found.invalidRole(role);
    return { ok: false, code: 'role_unavailable', reason: `Role ${asked} is not configured or is hidden in this project`, ...invalid };
  }
  const now = Date.now();
  const existing = jobs().find((job) =>
    job.request_key === request_key && (!windowedKey || withinRetryWindow(job.created_at, now)));
  if (existing) {
    ensureWatcher();
    ensureQueueWatcher(pane, hudHome);
    return created(existing);
  }
  const isolation = args.isolation === undefined ? 'none' : args.isolation;
  if (isolation !== 'none' && isolation !== 'worktree') return { ok: false, code: 'invalid_arguments', error: 'invalid isolation' };
  const task = required(args, 'task');
  if (args.package !== undefined && typeof args.package !== 'string') throw new Error('invalid_arguments: package');
  if (args.preset !== undefined && args.on !== undefined) {
    return { ok: false, code: 'invalid_arguments', error: 'preset and on are mutually exclusive' };
  }
  const presetName = args.preset === undefined ? undefined : required(args, 'preset');
  const preset = definition.presets?.find((p) => p.name === presetName);
  if (presetName !== undefined && !preset) {
    return { ok: false, code: 'invalid_arguments', error: `unknown preset: ${presetName}` };
  }
  let routing;
  try { routing = found.routing(now); }
  catch (error) {
    if (error instanceof HarnessSwitchError) return harnessSwitchFailure(error);
    throw error;
  }
  const onName = args.on !== undefined ? required(args, 'on') : null;
  const defaults = onName ? harnessDefaults(hudHome, bundled) : null;
  const onEntry = onName ? defaults?.[onName] : undefined;
  if (onName && !onEntry) {
    return { ok: false, code: 'invalid_arguments', error: `unknown harness: ${onName}` };
  }
  const matchPlace = (p: RolePlace, target: RolePlace) =>
    p.harness === target.harness &&
    (target.harness !== 'cli' || p.agent === target.agent) &&
    (target.harness !== 'bro' || (p.tool === target.tool && (!target.provider || p.provider === target.provider)));
  const modelOverride = args.model === undefined ? undefined : required(args, 'model');
  if (onEntry?.harness === 'bro' && modelOverride !== undefined) return { ok: false, code: 'invalid_arguments' };
  const choice = onEntry ? { run: [{ ...definition.run.find((p) => matchPlace(p, onEntry)), ...onEntry }] }
    : presetName !== undefined ? { preset: presetName } : undefined;
  const effective = found.assignment(definition, now, modelOverride, routing, choice, !!retryInput && retryInput.model === undefined);
  const details = effective.places.find((p) => p.state === 'active');
  if (!details) {
    return { ok: false, code: 'no_available_place', reason: effective.reason, places: effective.places, exhausted: effective.exhausted };
  }
  const argsFor = (place: RolePlace) => {
    if (!retryInput) return args;
    const compatible = { ...args };
    const unused = [...(place.harness === 'pi' ? [] : piOptionKeys),
      ...(place.harness === 'cli' ? [] : ['idle_grace_s']),
      ...(place.harness === 'bro' && place.tool === 'jev-flow' ? [] : ['kind'])];
    for (const key of unused) if (retryInput[key] === undefined) delete compatible[key];
    return compatible;
  };
  const initial = placeOptions(argsFor(details.place), details.place);
  if ('code' in initial) return initial;
  if (!herdrId(pane)) return { ok: false, code: 'herdr_required' };
  const id = 'j' + randomBytes(8).toString('hex');
  let worktree: ManagedWorktree | undefined;
  if (isolation === 'worktree') {
    try { worktree = await planWorktree(cwd, id, (args.package as string | undefined) || role); }
    catch { return { ok: false, code: 'invalid_arguments', error: 'worktree isolation requires a Git checkout with a HEAD commit' }; }
  }
  const inline = initial.place.harness === 'bro';
  const projectRoot = found.project().root;
  const context = await assembleContext(args, cwd, inline, projectRoot, repairOf);
  if ('code' in context) return context;
  let overrideHarnesses: Record<string, { model?: string }> | null = null;
  if (onName) {
    try {
      overrideHarnesses = json<Record<string, { model?: string }>>(join(hudHome, 'harnesses.json'));
    } catch {
      overrideHarnesses = null;
    }
  }
  const harnessesSource =
    onName && overrideHarnesses?.[onName]?.model !== undefined
      ? join(hudHome, 'harnesses.json')
      : join(bundled, 'harnesses.json');
  const attempts: LaunchAttempt[] = [];
  const base: Job = {
    job: id,
    role,
    request_key,
    cwd,
    herdr_pane: pane,
    created_at: new Date().toISOString(),
    task_length: task.length,
    ...(repairOf ? { repair_of: repairOf } : {}),
    ...(parentJob ? { parent_job: parentJob } : {}),
    ...(args.package === undefined ? {} : { package: args.package as string }),
    ...(presetName === undefined ? {} : { preset: presetName }),
    attempts,
    dispatch_exit_code: null,
    stderr_tail: '',
    message_keys: [],
  };
  const dir = directory(id);
  const selected = definition.presets?.some((p) => p.run === definition.run);
  const candidates = effective.places.filter((p) => p === details || p.state === 'standby');
  // Reads can reveal the persisted ID before launch ends; serialize its mutations with launch too.
  return keyLock(`job:${id}`, async () => {
    let job = base;
    let result: DispatchResult = launchError('no launch attempted');
    let reason = '';
    for (const candidate of candidates) {
      const launchArgs = argsFor(candidate.place);
      const prepared = candidate === details ? initial : placeOptions(launchArgs, candidate.place);
      if ('code' in prepared) continue; // Explicit harness-only options still constrain this dispatch.
      if (attempts.length) {
        const exhausted = readExhausted(hudHome);
        const quota = isQuotaFailure(reason);
        if ((quota && candidate.key === job.place_key) || exhausted.has(candidate.key)) continue;
        if (quota && !exhausted.has(job.place_key!)) markExhausted(hudHome, job.place_key!, reason);
        // The previous tab is closed. Keep the job, but do not carry its launch/turn state into a new worker.
        for (const file of ['SESSION.txt', 'STATUS.json', 'turn.json']) fs.rmSync(join(dir, file), { force: true });
      } else fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

      const { place, options } = prepared;
      const attempt: LaunchAttempt = { index: candidate.index, place: describePlace(place, candidate.model.value) };
      job = {
        ...base, ...options, place, place_key: candidate.key,
        create_options: {
          cwd, ...Object.fromEntries(replayOptions.filter((key) => launchArgs[key] !== undefined).map((key) => [key, launchArgs[key]])),
        },
        ...(job.worktree ? { worktree: job.worktree, cwd: job.cwd } : {}),
        ...(place.harness === 'bro' ? { bro: place } : {
          model: candidate.model.value, thinking: place.thinking ?? candidate.thinking.value,
          model_source: modelOverride !== undefined ? 'hud_create' : onEntry?.model !== undefined ? harnessesSource : candidate.model.source,
        }),
        ...(place.harness === 'cli' ? { cli: {
          agent: place.agent!, can_continue: (effective.harness === 'bro' ? definition.can_continue : effective.can_continue) === true,
          idle_grace_s: (args.idle_grace_s as number | undefined) ?? definition.idle_grace_s ?? 600,
          state_trust: candidate.state_trust ?? 'advisory',
        } } : {}),
      };
      const briefContext = inline === (place.harness === 'bro') ? context : await assembleContext(args, cwd, place.harness === 'bro', projectRoot, repairOf);
      if (!('code' in briefContext)) {
        Object.assign(job, briefContext.metadata);
        writeBrief(job, dir, task, briefContext.block, attempts.length === 0);
      }
      // Persist before dispatch: an interrupted launch must not dispatch again on retry.
      save(job, attempts.length > 0);
      if (attempts.length === 0) {
        if (parentJob) {
          const children = join(directory(parentJob), '.sonic');
          fs.mkdirSync(children, { recursive: true, mode: 0o700 });
          fs.writeFileSync(join(children, id), '', { mode: 0o600, flag: 'wx' });
        } else createdJobs.add(id);
        ensureWatcher();
        ensureQueueWatcher(pane, hudHome);
      }
      const launchRole = preset || selected ? { ...definition, skills: place.skills } : definition;
      if ('code' in briefContext) result = { ...launchError(briefContext.error ?? 'could not prepare launch context'), preInput: true };
      else result = await launchPlace(job, launchRole, place, dir, task, worktree);
      reason = result.exit_code === 0 ? '' : launchReason(result);
      if (reason) attempt.reason = reason;
      attempts.push(attempt);
      if (result.exit_code === 0 || (!result.preInput && fs.existsSync(join(dir, 'STATUS.json')))) job.used_place = attempt.place;
      if (!result.preInput || result.cleanupFailed) break;
      save(job);
    }
    return finishLaunch(job, dir, result, reason);
  });
}

function writeBrief(job: Job, dir: string, task: string, block: string, first: boolean) {
  const place = job.place!;
  let brief = `${task}${place.harness === 'bro' ? '\n' : '\n\n'}${block}`;
  if (place.harness === 'pi') brief += 'Finish with `hud_report`.\n';
  else if (place.harness === 'cli' && !cliWorkerTools(place.agent!)) {
    const command = (bin: string) => `node ${JSON.stringify(join(bundled, 'bin', `${bin}.mjs`))}`;
    const own = `--dir ${JSON.stringify(dir)}`;
    brief += 'This harness uses the commands below instead of the worker tools named in your role.\n' +
      `Write your report to ${join(dir, 'report.md')}; then run the --done command from the prompt you are answering.\n` +
      `Ask the orchestrator with: ${command('hud-ask')} ${own} --question "..." --default "..."\n`;
    if (job.role !== 'sonic') brief +=
      `Sonic command: ${command('hud-sonic')} start ${own} --task <text> | --task-file <file> [--thinking off|low|medium|high]\n` +
      `Collect: ${command('hud-sonic')} wait ${own} --job <id>\n`;
    brief += `Optional milestone: ${command('hud-progress')} ${own} "message"\n`;
  }
  // Standing brief and context references follow the task; labels read the brief's opening lines.
  fs.writeFileSync(join(dir, 'brief.md'), brief, { flag: first ? 'wx' : 'w', mode: 0o600 });
}

async function launchPlace(job: Job, definition: Role, place: RolePlace, dir: string, task: string, worktree?: ManagedWorktree): Promise<DispatchResult> {
  let instructionsPath = '';
  try {
    if (job.pi_args?.some((value) => /^--(?:orchestrator|notify)(?:=|$)/.test(value)))
      return rejectLaunch(launchError('pi_args cannot override --orchestrator or --notify caller binding', 'invalid_arguments'));
    if (job.thinking != null) {
      const supported = await launchThinking(hudHome, place.harness, job.model ?? null);
      if (supported && !supported.includes(job.thinking)) {
        const thinking = nearestThinking(job.thinking, supported);
        if (!thinking) return rejectLaunch(launchError(`no supported thinking level for ${job.model}`, 'invalid_arguments'));
        job.thinking = place.thinking = thinking;
      }
    }
    if (place.harness === 'cli') {
      const name = definition.instructions ?? definition.role;
      if (!plainSkillName(name)) return rejectLaunch(launchError(`invalid instructions name: ${name}`, 'unsupported_harness'));
      instructionsPath = join(bundled, 'instructions', `${name}.md`);
      if (!fs.existsSync(instructionsPath))
        return rejectLaunch({ ...launchError(`missing CLI instructions file: ${instructionsPath}`, 'unsupported_harness'), path: instructionsPath });
      if (worktree && !isCliDirTrusted(place.agent!, worktree.main_root)) {
        const reason = `${place.agent} has not trusted ${worktree.main_root}; run hud trust ${worktree.main_root}`;
        return rejectLaunch({ ...failCli(dir, job, place, reason), code: 'untrusted_cwd' });
      }
    }
    if (worktree && !job.worktree) {
      await addWorktree(worktree);
      job.worktree = worktree;
      job.cwd = worktree.root;
      save(job);
      await populateWorktree(worktree);
    }
    if (worktree && place.harness === 'cli') propagateCliTrust(place.agent!, worktree.main_root, worktree.root);
    save(job);
  } catch (error) {
    // Worktree setup is shared; another place cannot repair it.
    return launchError(String(error));
  }
  if (place.harness === 'cli') return dispatchCli(job, place, instructionsPath, task);
  if (place.harness === 'pi') return dispatchPi(job, definition, place, task);
  try { return await dispatchBro(job, task); }
  catch (error) { return launchError(String(error)); }
}

function launchReason(result: DispatchResult) {
  let detail = result.stderr.trim();
  if (!detail) {
    try {
      const error = JSON.parse(result.stdout)?.error;
      if (typeof error?.message === 'string') detail = [error.code, error.message].filter(Boolean).join(': ');
    } catch { /* The command may return plain text. */ }
  }
  return (detail || result.stdout.trim().split(/\r?\n/, 1)[0] || `launch exited ${result.exit_code}`).slice(0, 500);
}

function finishLaunch(job: Job, dir: string, result: DispatchResult, reason: string) {
  job.dispatch_exit_code = result.exit_code;
  if (result.code) job.dispatch_code = result.code;
  if (result.path) job.dispatch_path = result.path;
  job.stderr_tail = result.stderr;
  const statusFile = join(dir, 'STATUS.json');
  if (result.exit_code !== 0 && (result.preInput || !fs.existsSync(statusFile))) {
    const outcome = recordFailureExhaustion(hudHome, bundled, dir, job, reason);
    if (outcome.marked) job.exhaustion_marked = true;
    fs.writeFileSync(
      `${statusFile}.${process.pid}.tmp`,
      JSON.stringify({
        ...result.status,
        state: 'failed',
        harness: job.place?.harness,
        ...(job.bro ? { provider: job.bro.provider === 'chatgpt' ? 'openai' : 'gemini' } : {}),
        exit_reason: outcome.reason,
        ended_at: new Date().toISOString(),
      }) + '\n',
      { mode: 0o600 }
    );
    fs.renameSync(`${statusFile}.${process.pid}.tmp`, statusFile);
  }
  save(job);
  const out = created(job);
  if (!job.parent_job) cursor.set(job.job, readRow(job).row);
  return out;
}

function harnessSwitchFailure(error: HarnessSwitchError) {
  return { ok: false, code: error.code, error: error.message, path: error.path };
}

function compactAssignment(assignment: ReturnType<ReturnType<typeof registry>['assignment']>) {
  const { role, instructions, available, can_continue, runs_on, model, thinking, reason, places, preset, preset_missing } = assignment;
  const place = runs_on && {
    harness: runs_on.harness,
    pi_role: runs_on.pi_role,
    agent: runs_on.agent,
    tool: runs_on.tool,
    provider: runs_on.provider,
    kind: runs_on.kind,
    effort: runs_on.effort,
    model: model ?? undefined,
    thinking: thinking ?? undefined,
  };
  return {
    role, available, can_continue, runs_on: place,
    ...(preset ? { preset } : {}),
    ...(preset_missing ? { preset_missing } : {}),
    places: places.map(({ index, state, off_by, until, missing, provider, provider_source }) =>
      ({ index, state, off_by, until, missing, provider, provider_source })),
    ...(instructions && instructions !== role && instructions !== runs_on?.pi_role ? { instructions } : {}),
    ...(reason ? { reason } : {}),
  };
}

function ticketGuide(args: Args): boolean {
  return args.op === undefined || args.op === 'guide';
}
async function sendJob(id: string, message: string, explicitKey: string | undefined, workingOnly: boolean) {
  const matchKey = explicitKey ?? derivedKey('send', id, message);
  const current = findJob(id);
  if (!current) return { ok: false, code: 'job_not_found' };
  const dir = directory(current.job);
  const now = Date.now();
  const duplicate = explicitKey === undefined
    ? current.send_outcomes?.find((attempt) => attempt.derived_key === matchKey && withinRetryWindow(attempt.recorded_at, now))
    : current.send_outcomes?.find((attempt) => attempt.key === explicitKey);
  if (duplicate || (explicitKey !== undefined && current.message_keys.includes(explicitKey))) {
    if (duplicate?.exit_code === 0) ensureQueueWatcher(process.env.HERDR_PANE_ID, hudHome);
    return duplicate?.exit_code === 0
      ? { ok: true, sent: false }
      : { ok: false, sent: false, code: 'send_failed',
          ...(duplicate && { key: duplicate.key, exit_code: duplicate.exit_code, stderr_tail: duplicate.stderr_tail }) };
  }
  const { row, status } = readRow(current);
  const state = row.state ?? '';
  if (!workingOnly && state === 'closed' && status?.exit_reason === REPORT_READ_EXIT) {
    const repair = await dispatchJob({ ...jobOptions(current), task: message, request_key: derivedKey('repair', id, matchKey) },
      process.env.HERDR_PANE_ID, undefined, { job: id, derived: explicitKey === undefined });
    return 'job' in repair && repair.job ? { ...repair, continued_as: repair.job } : repair;
  }
  const agent = primary(dir);
  // A working pi or CLI job queues the message (the worker takes it after its current step); a settled one
  // continues in its idle grace when the role allows (owner, 2026-11-11).
  const queued = ['working', 'waiting_helper', 'waiting_orchestrator'].includes(state);
  const readReport = row.report_mtime !== null && !row.report_unread;
  if (
    current.bro ||
    current.jev ||
    !agent ||
    !(queued || (!workingOnly && state === 'idle_grace' && !readReport && registry(current.worktree?.main_root ?? current.cwd).roles().get(current.role)?.can_continue))
  )
    return { ok: false, code: 'not_continuable' };
  // Record the attempt first. A fresh derived send needs its own key for CLI turn tracking.
  const key = explicitKey ?? `${matchKey}:${randomBytes(8).toString('hex')}`;
  const recorded_at = new Date().toISOString();
  const outcome = { key, ...(explicitKey === undefined ? { derived_key: matchKey } : {}), recorded_at,
    exit_code: null as number | null, stderr_tail: '' };
  current.message_keys.push(key);
  (current.send_outcomes ??= []).push(outcome);
  if (!current.cli) current.pi_sent_at = recorded_at;
  save(current);
  // Read the rollback baseline at mutation time, with no pane query between it and the write.
  const prior = current.cli ? readTurn(dir) : null;
  const turn = current.cli ? writeTurn(dir, false, { key, pid: process.pid, start: procStat(process.pid)?.start ?? null }) : null;
  const result = await run('herdr', ['agent', 'prompt', agent, turn ? withDonePrompt(message, bundled, dir, turn, current.cli!.agent) : message]);
  if (turn && refusedBeforeInput(result)) {
    const active = readTurn(dir);
    if (active?.seq === turn.seq && active.send?.key === key && active.send.pid === process.pid) {
      if (prior) saveTurn(dir, prior);
      else fs.unlinkSync(join(dir, 'turn.json'));
    }
  }
  const latest = json<Job>(join(dir, 'job.json')) ?? current;
  const attempted = latest.send_outcomes?.find((attempt) => attempt.key === key) ?? outcome;
  attempted.exit_code = result.exit_code;
  attempted.stderr_tail = result.stderr;
  save(latest);
  if (result.exit_code === 0) ensureQueueWatcher(process.env.HERDR_PANE_ID, hudHome);
  if (result.exit_code === 0 && current.cli) {
    const supPid = supervisorPid(dir, status);
    if (
      supPid &&
      !supervisorAlive(supPid) &&
      workerAlive(
        typeof status?.pid === 'number' ? status.pid : null,
        typeof status?.pid_start_time === 'string' ? status.pid_start_time : null
      ) === true
    ) {
      spawnCliSupervisor(dir);
    }
  }
  return {
    ...(result.exit_code === 0 ? {} : { code: 'send_failed' }),
    ok: result.exit_code === 0,
    sent: result.exit_code === 0,
    ...(queued ? { queued: true } : {}),
    exit_code: result.exit_code,
    stderr_tail: result.stderr,
  };
}

async function sendJobs(args: Args) {
  const text = required(args, 'text');
  const key = args.message_key === undefined ? undefined : required(args, 'message_key');
  const send = (id: string, workingOnly: boolean) => keyLock(`job:${id}`, () => sendJob(id, text, key, workingOnly));
  if (args.jobs === undefined) return send(required(args, 'job'), false);
  if (args.job !== undefined || !Array.isArray(args.jobs) || !args.jobs.length ||
      args.jobs.some((id) => typeof id !== 'string' || !id)) throw new Error('invalid_arguments: jobs');
  const results = await Promise.all([...new Set<string>(args.jobs)].map(async (job) => ({ job, result: await send(job, true) })));
  const sent: string[] = [], skipped: { job: string; reason: string }[] = [];
  for (const { job, result } of results) {
    if ('sent' in result && result.sent) sent.push(job);
    else skipped.push({ job, reason: ('code' in result && result.code) || 'already_sent' });
  }
  return { sent, skipped };
}

async function call(name: string, args: Args): Promise<unknown> {
  if (name === 'hud_lease') return takeLease(args, { home: hudHome, cwd: process.cwd(), holder: callerPane });
  if (name === 'hud_tickets') {
    if (ticketGuide(args)) return fs.readFileSync(join(bundled, '../../integrations/tickets/method.md'), 'utf8');
    return editTickets(jobCwd(args), args);
  }
  if (args.detail !== undefined && typeof args.detail !== 'boolean') throw new Error('invalid_arguments: detail');
  const detail = args.detail === true;
  if (name === 'hud_roster') {
    if (args.convention_version !== undefined && typeof args.convention_version !== 'string')
      throw new Error('invalid_arguments: convention_version');
    const found = registry(jobCwd(args));
    const { root, registered } = found.project();
    const project = { root, registered };
    const ignored = found.projectConfigIgnored();
    const invalid = found.invalid();
    const convention = found.convention();
    // Include the project and source. For a capped file, invalidate on changes beyond the returned prefix too.
    const stat = convention.truncated ? fs.statSync(convention.path, { bigint: true, throwIfNoEntry: false }) : undefined;
    const beyondCap = stat && `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const convention_version = createHash('sha256').update(JSON.stringify([project, convention, beyondCap])).digest('hex');
    const now = Date.now();
    let routing;
    try { routing = found.routing(now); }
    catch (error) {
      if (error instanceof HarnessSwitchError) return harnessSwitchFailure(error);
      throw error;
    }
    const roles = [...found.roles().values()].map((role) => {
      const assignment = found.assignment(role, now, undefined, routing);
      return detail ? assignment : compactAssignment(assignment);
    });
    const watcherAlive = !!callerPane && watching(callerPane, hudHome);
    const unchanged = (args.convention_version ?? sentConventionVersion) === convention_version;
    if (!unchanged) sentConventionVersion = convention_version;
    return {
      roles,
      ...(detail || invalid.length ? { invalid } : {}),
      convention_version,
      ...(unchanged ? { convention_unchanged: true } : { convention }),
      project,
      ...(callerPane ? { watcher_alive: watcherAlive } : {}),
      hint: deliveryHint(watcherAlive),
      ...(ignored ? { project_config_ignored: ignored } : {}),
    };
  }
  if (name === 'hud_create') {
    const result = await dispatchJob(args, process.env.HERDR_PANE_ID);
    if (sentCreateHint) return result;
    sentCreateHint = true;
    const watcherAlive = 'watcher_alive' in result ? result.watcher_alive === true : !!callerPane && watching(callerPane, hudHome);
    return { ...result, hint: deliveryHint(watcherAlive) };
  }
  if (name === 'hud_send') return sendJobs(args);
  if (name === 'hud_wait') return waitJobs(args);
  if (name === 'hud_read') {
    const { view } = args;
    if (view !== undefined) {
      if (view !== 'compact' && view !== 'recent') throw new Error('invalid_arguments: view');
      if (args.job !== undefined) throw new Error('invalid_arguments: view is list-only');
    }
    if (args.job === undefined) {
      if (args.detail !== undefined) throw new Error('invalid_arguments: detail requires job');
      return { jobs: listJobs(view === 'recent') };
    }
  }
  if (!tools.some((tool) => tool.name === name)) throw new Error('unknown_tool');
  const id = required(args, 'job');
  const job = findJob(id);
  if (!job) return { ok: false, code: 'job_not_found' };
  if (name === 'hud_peek') return job.job === id ? peekJob(job, args) : { ok: false, code: 'job_not_found' };
  const dir = directory(job.job);
  if (name === 'hud_read') {
    if (args.full !== undefined && typeof args.full !== 'boolean') throw new Error('invalid_arguments: full');
    if (args.wait_ms !== undefined && (typeof args.wait_ms !== 'number' || !Number.isFinite(args.wait_ms)))
      throw new Error('invalid_arguments: wait_ms');
    const end = Date.now() + Math.max(0, Math.min(120000, (args.wait_ms as number | undefined) ?? 0));
    const initial = readRow(job, !isWorker).row;
    const ready = (row: JobRow) =>
      settled(row.state) ||
      row.state === 'waiting_orchestrator' ||
      row.blocked ||
      row.open_questions > 0 ||
      jobChanges([initial], [row]).length > 0 ||
      Date.now() >= end;
    while (true) {
      const { row } = readRow(job, !isWorker);
      if (Date.now() >= end || ready(row)) {
        const receipt = json<Job>(join(dir, 'job.json')) ?? job;
        const git = receipt.worktree ? { git_summary: await gitSummary(receipt.worktree) } : {};
        const result = observation(json<Job>(join(dir, 'job.json')) ?? receipt, args.full === true, detail);
        // A question may have been answered or a settled job continued since the lightweight poll.
        const currentRow = jobRow(job, json<Record<string, unknown>>(join(dir, 'STATUS.json')), {
          dir,
          openQuestions: result.questions?.length ?? 0,
          reportPresent: result.report_exists,
        });
        // The full read disagrees with the quick one (answered or continued meanwhile): wait, never spin.
        if (!ready(currentRow)) {
          await sleep(Math.max(0, Math.min(200, end - Date.now())));
          continue;
        }
        const collected = 'report' in result && result.report_exists;
        const observed = result.blocked || result.state === 'failed';
        if (!isWorker && (collected || observed)) {
          const latest = json<Job>(join(dir, 'job.json'))!;
          const at = new Date().toISOString();
          if (collected) latest.read_at = at;
          if (observed) latest.observed_at = at;
          save(latest);
        }
        return { ...result, ...git };
      }
      await sleep(Math.min(500, end - Date.now()));
    }
  }
  if (name === 'hud_respond') {
    const request = required(args, 'request_id');
    if (!/^q\d+$/.test(request)) throw new Error('invalid_arguments: request_id');
    const answer = required(args, 'answer');
    fs.mkdirSync(join(dir, 'qa'), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(join(dir, 'qa', `${request}.answer.md`), answer, { flag: 'wx', mode: 0o600 });
      return { ok: true, written: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return { ok: true, written: false };
    }
  }
  const { row, status } = readRow(job);
  const { result, complete, issue } = await reapWorkerTree(dir, status, () => {
    // Idle grace already finished: reap quits and the supervisor closes. A working job is stopped.
    if (job.cli && row.state === 'idle_grace') {
      try {
        fs.writeFileSync(join(dir, 'STATUS.json.close-requested'), '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return runCommand('pi-role-reap', [dir], process.env, { budgetMs: 135_000 });
  }, (run) => run.ok);
  if (issue) ensureWatcher();
  if (!isWorker && complete && row.display_state === 'failed') {
    const latest = json<Job>(join(dir, 'job.json')) ?? job;
    save({ ...latest, observed_at: new Date().toISOString() });
  }
  return {
    exit_code: complete ? 0 : result.exitCode || 1,
    last_line: issue ?? (result.reason === 'timeout' ? 'pi-role-reap timed out' :
      (result.stdout.trim() || result.stderr.trim()).split('\n').at(-1) ?? ''),
  };
}

const callerPane = herdrId(process.env.HERDR_PANE_ID) ? process.env.HERDR_PANE_ID! : null;
let callerHarness: 'claude' | 'codex' | 'pi' | undefined;
let sentConventionVersion: string | undefined;
let sentCreateHint = false;
function deliveryHint(watcherAlive: boolean): string {
  if (!callerHarness && callerPane) {
    const agent = paneInfo(callerPane)?.agent;
    if (agent === 'claude' || agent === 'codex' || agent === 'pi') callerHarness = agent;
  }
  const fallback = 'Without live delivery, questions may be typed; use `hud_wait` for settlement or attention.';
  const live = 'Keep working until notified, then collect reports with `hud_read`.';
  switch (callerHarness) {
    case 'claude':
      return `Claude Code: ${watcherAlive ? '`hud watch` is live under Monitor' : 'run `hud watch` under Monitor'}; re-arm after expiry. ${live}`;
    case 'codex':
      return 'Codex: events are queued automatically; no Monitor is needed. Missing thread ID or queue failure falls back to typing.';
    case 'pi':
      return watcherAlive
        ? `pi: native HUD notices wake an idle session or arrive before the next model request, without touching drafts. ${live}`
        : `pi: the native HUD watch is not active. ${fallback}`;
    default:
      return watcherAlive ? `HUD watch is live. ${live}` : fallback;
  }
}
const createdJobs = new Set<string>();
const isSessionJob = (job: Job) => (callerPane ? job.herdr_pane === callerPane : createdJobs.has(job.job));
function sessionRows(markExhaustion: boolean): JobRow[] {
  return jobs()
    .filter(isSessionJob)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.job.localeCompare(b.job))
    .slice(0, 200)
    .map((job) => readRow(job, markExhaustion).row);
}
let cursor: Map<string, JobRow>;
const tries = new TryLog(hudHome), answers = new PanelActionLog(hudHome);
function withChanges(value: unknown, markExhaustion: boolean): unknown {
  // Snapshot, diff and advance the shared cursors synchronously, in response order.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const rows = sessionRows(markExhaustion);
  const changes = [...jobChanges(cursor, rows), ...tries.changes(process.cwd()), ...answers.changes(new Set(rows.map((row) => row.job)))];
  cursor = new Map(rows.map((row) => [row.job, row]));
  return changes.length ? { ...(value as Record<string, unknown>), changes } : value;
}

// Only calls touching the same request key or job wait on one another.
const locks = new Map<string, Promise<unknown>>();
async function keyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}
function mutationKey(name: string, args: Args): string | null {
  if (name === 'hud_tickets' && !ticketGuide(args))
    return isWorker ? 'tickets' : `tickets:${fs.realpathSync(jobCwd(args))}`;
  if (name !== 'hud_respond' && name !== 'hud_close') return null;
  const id = args.job;
  // Leave validation to the tool, without making invalid calls wait for one another.
  if (typeof id !== 'string' || !id) return `invalid:${randomBytes(8).toString('hex')}`;
  return `job:${id}`;
}
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const rpcError = (id: unknown, code: number, message: string) =>
  write({ jsonrpc: '2.0', id, error: { code, message } });
async function receive(line: string): Promise<void> {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    rpcError(null, -32700, 'Parse error');
    return;
  }
  if (
    !request ||
    request.jsonrpc !== '2.0' ||
    typeof request.method !== 'string' ||
    (request.id !== undefined && request.id !== null && !['string', 'number'].includes(typeof request.id))
  ) {
    rpcError(null, -32600, 'Invalid Request');
    return;
  }
  if (request.id === undefined) return; // Includes notifications/initialized.
  let result: unknown;
  switch (request.method) {
    case 'initialize':
      if (request.params?.clientInfo?.name === 'hud-pi') callerHarness = 'pi';
      result = {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'hud-mcp-thin', version: '0.1.4' },
        instructions: worker ? 'Use the worker tools for your own HUD job. Finish with hud_report.' :
          'Call hud_roster when project dispatch context is missing or stale. With live watch, keep working until notified, then collect with hud_read.',
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools: worker ? await worker.listWorkerTools(true) : [...tools, statuslineTool] };
      break;
    case 'resources/list':
      result = { resources: worker ? [] : [statuslineResource] };
      break;
    case 'resources/templates/list':
      result = { resourceTemplates: [] };
      break;
    case 'resources/read':
      if (typeof request.params?.uri !== 'string') {
        rpcError(request.id, -32602, 'Invalid resource URI');
        return;
      }
      if (worker || request.params.uri !== statuslineResource.uri) {
        rpcError(request.id, -32002, 'Resource not found');
        return;
      }
      result = readCodexStatusline(request.params._meta, hudHome, callerPane);
      break;
    case 'tools/call': {
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
        rpcError(request.id, -32602, 'Invalid params');
        return;
      }
      if (worker) {
        if (!worker.workerTools(true).some((tool: { name: string }) => tool.name === name)) {
          result = { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'worker_cannot_dispatch' }) }], isError: true };
        } else {
          try {
            const value = await worker.callWorkerTool(name, args);
            result = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
          } catch (error) {
            result = { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'tool_error', error: String(error) }) }], isError: true };
          }
        }
        break;
      }
      if (name === statuslineTool.name) {
        result = { content: [{ type: 'text', text: `Codex statusline resource: ${statuslineResource.uri}` }] };
        break;
      }
      const invoke = () => call(name, args);
      try {
        const key = mutationKey(name, args);
        const value = key === null ? await invoke() : await keyLock(key, invoke);
        const markExhaustion = name !== 'hud_peek';
        if (typeof value === 'string') {
          const content = [{ type: 'text', text: value }];
          const delta = withChanges({}, markExhaustion) as { changes?: unknown[] };
          if (delta.changes) content.push({ type: 'text', text: JSON.stringify(delta) });
          result = { content };
        } else {
          result = { content: [{ type: 'text', text: JSON.stringify(withChanges(value, markExhaustion)) }] };
        }
      } catch (error) {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                code: 'tool_error',
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
      break;
    }
    default:
      rpcError(request.id, -32601, 'Method not found');
      return;
  }
  write({ jsonrpc: '2.0', id: request.id, result });
}
export function serveMcp() {
  if (!worker) cursor = new Map(sessionRows(false).map((row) => [row.job, row]));
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    void receive(line);
  });
}
