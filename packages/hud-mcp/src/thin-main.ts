/** Local HUD role tools and Codex statusline, newline-delimited JSON-RPC over stdio. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { procStat, readTurn, saveTurn, withDonePrompt, workerAlive, writeTurn } from './cli-judge.js';
import { readCodexStatusline, statuslineResource, statuslineTool } from './codex-statusline.js';
import { editTickets } from './local-tickets.js';
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
  executable,
  piSwitches,
  type Role,
  type RolePlace,
} from '../../../src/roles/roster.js';
import { HarnessSwitchError } from '../../../src/roles/harness-switches.js';
import { ROLE_TOOLS as tools } from '../../../src/roles/tool-definitions.js';

const hudHome = resolve(process.env.HUD_HOME || join(homedir(), '.hud'));
const jobsRoot = join(hudHome, 'jobs');
const isWorker = process.env.HUD_JOB_DIR !== undefined;
const { ensureQueueWatcher, watching } = await import(new URL('../../../../bin/hud-notify.mjs', import.meta.url).href);
const bundled = fileURLToPath(new URL('../../../../', import.meta.url));
function registry(cwd: string) {
  return roleRegistry(hudHome, cwd, process.env, undefined, undefined, bundled);
}
function jobCwd(args: Args): string {
  return resolve(args.cwd === undefined ? process.cwd() : required(args, 'cwd'));
}
type PiOptions = Partial<Record<(typeof piSwitches)[number], boolean>> & { pi_args?: string[] };
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
  dispatch_exit_code: number | null;
  dispatch_code?: 'untrusted_cwd';
  stderr_tail: string;
  message_keys: string[];
  send_outcomes?: { key: string; exit_code: number | null; stderr_tail: string }[];
  role_skills?: { name: string; path: string }[];
  skipped_skills?: { name: string; reason: string }[];
  worker_prompt?: string | null;
}
type Args = Record<string, unknown>;
function required(args: Args, key: string): string {
  if (typeof args[key] !== 'string' || !args[key]) throw new Error(`invalid_arguments: ${key}`);
  return args[key] as string;
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
function save(job: Job): void {
  const file = join(directory(job.job), 'job.json');
  // A waiting read can stamp the report while dispatch/send is awaiting a CLI.
  const existing = json<Job>(file);
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
  if (job.dispatch_exit_code !== null && job.dispatch_exit_code !== 0 && row.display_state === 'failed') {
    return {
      ok: false,
      code: job.dispatch_code ?? 'dispatch_failed',
      ...row,
      reason: row.reason ?? (job.stderr_tail.trim() || `launch exited ${job.dispatch_exit_code}`),
      task_dir,
      agent: primary(task_dir),
      ...watch,
    };
  }
  return {
    ...row, task_dir, agent: primary(task_dir), ...watch,
    ...(watch.watcher_alive ? {} : { hint: 'Claude Code: run `hud watch` under Monitor' }),
  };
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
async function dispatchPi(job: Job, role: Role, place: RolePlace, task: string) {
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
    argv.push('--', '--tui-mode', 'regular');
    for (const key of ['model', 'thinking'] as const) if (place[key] !== undefined) argv.push(`--${key}`, place[key]);
    argv.push(...resources, ...(job.pi_args ?? []));
    const built = await run(launcher, argv, job.cwd);
    if (built.exit_code !== 0) return built;
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
    if (result.exit_code !== 0) return result;
    const { tab, root_pane } = JSON.parse(result.stdout).result;
    const left = root_pane.pane_id;
    if (!herdrId(tab.tab_id) || !herdrId(left)) throw new Error('tab create did not return tab/root pane ids');
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
      if (split.exit_code !== 0) return split;
      right = JSON.parse(split.stdout).result.pane.pane_id;
      if (!herdrId(right)) throw new Error('split did not return a pane id');
      record();
    }
    const started = await run('herdr', ['agent', 'start', name, '--kind', 'pi', '--pane', left, '--', ...piArgs]);
    if (started.exit_code !== 0) return started;
    const prompt = `Read ${join(dir, 'brief.md')} and do exactly what it asks.`;
    job.pi_sent_at = new Date().toISOString();
    save(job);
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
    if (
      submitted.exit_code !== 0 &&
      !(status?.task_dir === dir && status.slot === 'primary' && status.state === 'closed' && status.output_written)
    ) {
      if (!(submitted.stderr + submitted.stdout).includes('agent_prompt_stalled')) return submitted;
      return run(process.execPath, [join(dirname(launcher), 'prompt-stall.mjs'), dir, name, left, prompt, '120000']);
    }
    return { ...submitted, exit_code: 0 };
  } catch (error) {
    return { exit_code: 1, stdout: '', stderr: String(error) };
  }
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
async function dispatchBro(job: Job, task: string) {
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
  if (result.exit_code !== 0) return result;
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
/** Trust refusal is the one STATUS write before the supervisor starts. Same keys as hud-cli.mjs. */
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
  const file = join(dir, 'STATUS.json');
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(status) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
  return { exit_code: 1, stdout: '', stderr: reason };
}
type DispatchResult = { exit_code: number; stdout: string; stderr: string; code?: 'untrusted_cwd' };
async function dispatchCli(job: Job, place: RolePlace, instructions: string, task: string): Promise<DispatchResult> {
  let openedTab: string | null = null;
  const reject = async (result: DispatchResult) => {
    if (openedTab) await run('herdr', ['tab', 'close', openedTab]);
    return result;
  };
  try {
    const kind = cliKinds[place.agent as CliAgent];
    const dir = directory(job.job);
    const untrusted = `${place.agent} has not trusted ${job.cwd}; run hud trust ${job.cwd}`;
    if (!isCliDirTrusted(place.agent!, job.cwd, process.env)) {
      return { ...failCli(dir, job, place, untrusted), code: 'untrusted_cwd' };
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
    if (result.exit_code !== 0) return result;
    const { tab, root_pane } = JSON.parse(result.stdout).result;
    const left = root_pane.pane_id;
    if (!herdrId(tab.tab_id) || !herdrId(left)) throw new Error('tab create did not return tab/root pane ids');
    openedTab = tab.tab_id;
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
    if (started.exit_code !== 0 && !notReady) return reject(started);
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
    if (notReady) return reject(started);
    if (kind.startupQuirk === 'phantom-working') {
      const settled = await settlePhantomWorking(name);
      if (settled) return reject(settled);
    }
    const prompt = withDonePrompt(`Read ${instructions} and then ${join(dir, 'brief.md')} and do exactly what the brief asks.`, bundled, dir, writeTurn(dir));
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
    if (submitted.exit_code !== 0 && !/agent_prompt_stalled|timeout|timed out/i.test(submitted.stdout + submitted.stderr)) return reject(submitted);
    // A stall after submission still needs supervision; it is not worker death.
    openedTab = null;
    if (!spawnCliSupervisor(dir)) return { exit_code: 1, stdout: '', stderr: 'hud-cli did not start' };
    return { exit_code: 0, stdout: '', stderr: '' };
  } catch (error) {
    return reject({ exit_code: 1, stdout: '', stderr: String(error) });
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

async function assembleContext(args: Args, cwd: string, inline: boolean) {
  const metadata: Pick<Job, 'context_files' | 'from_jobs'> = {};
  const sections: string[] = [];
  let remaining = 256 * 1024;
  for (const [key, root, max] of [['context_files', cwd, 32], ['from_jobs', jobsRoot, 16]] as const) {
    const values = args[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > max || values.some((v) =>
      typeof v !== 'string' || !v || v.includes('\0') || (key === 'from_jobs' && !/^j[0-9a-f]{16}$/.test(v)))) {
      return { ok: false, code: 'invalid_arguments', error: `invalid ${key} (maximum ${max} entries)` } as const;
    }
    const recorded: string[] = metadata[key] = [];
    if (!values.length) continue;
    let source: string = key;
    try {
      const base = await fs.promises.realpath(root);
      for (const value of values) {
        source = `${key}: ${JSON.stringify(value)}`;
        const path = await fs.promises.realpath(resolve(root, key === 'from_jobs' ? join(value, 'report.md') : value));
        const rel = relative(base, path);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside its root');
        const file = await readContextFile(path, inline ? Math.min(64 * 1024, remaining) : undefined);
        if (!file) return { ok: false, code: 'context_too_large', error: source } as const;
        const label = `${key === 'from_jobs' ? `${value} report: ` : ''}${JSON.stringify(path)}`;
        if (inline) {
          remaining -= file.bytes;
          let length = 3;
          for (const run of file.content.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
          const fence = '`'.repeat(length);
          sections.push(`### ${label}\n\n${fence}\n${file.content}${file.content.endsWith('\n') ? '' : '\n'}${fence}`);
        } else sections.push(`- ${label}`);
        recorded.push(key === 'from_jobs' ? value : path);
      }
    } catch {
      return { ok: false, code: 'invalid_arguments', error: `${source} must resolve to a readable UTF-8 text file inside ${root}` } as const;
    }
  }
  const block = !sections.length ? '' : inline
    ? `\n## Context\n\n${sections.join('\n\n')}\n`
    : `## Context References\n\nRead these files for task context:\n\n${sections.join('\n')}\n\n`;
  return { metadata, block };
}

export async function dispatchJob(args: Args, pane: string | undefined, parentJob?: string) {
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
  const request_key = required(args, 'request_key');
  const existing = jobs().find((job) => job.request_key === request_key);
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
  const now = Date.now();
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
  const effective = found.assignment(definition, now, modelOverride, routing, choice);
  const details = effective.places.find((p) => p.state === 'active');
  if (!details) {
    return { ok: false, code: 'no_available_place', reason: effective.reason, places: effective.places, exhausted: effective.exhausted };
  }
  let place: RolePlace = { ...details.place };
  const id = 'j' + randomBytes(8).toString('hex');
  let worktree: ManagedWorktree | undefined;
  if (isolation === 'worktree') {
    if (place.harness === 'bro') return { ok: false, code: 'invalid_arguments', error: 'worktree isolation is local-only' };
    try { worktree = await planWorktree(cwd, id, (args.package as string | undefined) || role); }
    catch { return { ok: false, code: 'invalid_arguments', error: 'worktree isolation requires a Git checkout with a HEAD commit' }; }
    if (place.harness === 'cli' && !isCliDirTrusted(place.agent!, worktree.main_root))
      return { ok: false, code: 'untrusted_cwd', reason: `${place.agent} has not trusted ${worktree.main_root}; run hud trust ${worktree.main_root}` };
  }
  if (!herdrId(pane)) return { ok: false, code: 'herdr_required' };
  if (args.idle_grace_s !== undefined) {
    if (!Number.isInteger(args.idle_grace_s) || (args.idle_grace_s as number) < 60 || (args.idle_grace_s as number) > 3600)
      return { ok: false, code: 'invalid_arguments', error: 'idle_grace_s must be an integer from 60 to 3600' };
    if (place.harness !== 'cli')
      return { ok: false, code: 'invalid_arguments', error: place.harness === 'pi'
        ? "idle_grace_s is CLI-only; pi grace follows the model's cache lifetime inside pi-roles"
        : 'idle_grace_s is CLI-only; browser jobs have no idle grace' };
  }
  if (args.kind !== undefined) {
    if (place.harness !== 'bro' || place.tool !== 'jev-flow' || (args.kind !== 'image' && args.kind !== 'video')) {
      return { ok: false, code: 'invalid_arguments' };
    }
    place = { ...place, kind: args.kind };
  } else if (place.harness === 'bro' && place.tool === 'jev-flow' && !place.kind) {
    place = { ...place, kind: 'image' };
  }
  if (place.harness === 'bro' && (modelOverride !== undefined || args.thinking !== undefined))
    return { ok: false, code: 'invalid_arguments' };
  if (args.thinking !== undefined) place = { ...place, thinking: required(args, 'thinking') };
  const options: PiOptions = place.harness === 'pi' ? { split: place.split ?? false, pi_args: place.pi_args ?? [] } : {};
  for (const key of piSwitches) {
    const value = args[key];
    if (value !== undefined) {
      if (place.harness !== 'pi' || typeof value !== 'boolean') return { ok: false, code: 'invalid_arguments' };
      options[key] = value;
    } else if (key !== 'skills' && place.harness === 'pi' && place[key] !== undefined) options[key] = place[key];
  }
  if (args.pi_args !== undefined) {
    if (
      place.harness !== 'pi' ||
      !Array.isArray(args.pi_args) ||
      args.pi_args.length > 128 ||
      args.pi_args.some((value) => typeof value !== 'string' || value.length > 4096)
    )
      return { ok: false, code: 'invalid_arguments' };
    options.pi_args = args.pi_args;
  }
  if (options.pi_args?.some((value) => /^--(?:orchestrator|notify)(?:=|$)/.test(value)))
    return { ok: false, code: 'invalid_arguments', error: 'pi_args cannot override --orchestrator or --notify caller binding' };
  let instructionsPath = '';
  if (place.harness === 'cli') {
    const instructionsName = definition.instructions ?? definition.role;
    if (!plainSkillName(instructionsName)) {
      return { ok: false, code: 'unsupported_harness', error: `invalid instructions name: ${instructionsName}` };
    }
    instructionsPath = join(bundled, 'instructions', `${instructionsName}.md`);
    if (!fs.existsSync(instructionsPath)) {
      return {
        ok: false,
        code: 'unsupported_harness',
        path: instructionsPath,
        error: `missing CLI instructions file: ${instructionsPath}`,
      };
    }
  }
  const context = await assembleContext(args, cwd, place.harness === 'bro');
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
  const modelSource =
    args.model !== undefined
      ? 'hud_create'
      : onEntry && onEntry.model !== undefined
        ? harnessesSource
        : details.model.source;
  const job: Job = {
    job: id,
    role,
    request_key,
    cwd,
    herdr_pane: pane,
    created_at: new Date().toISOString(),
    ...(parentJob ? { parent_job: parentJob } : {}),
    ...options,
    ...context.metadata,
    ...(args.package === undefined ? {} : { package: args.package as string }),
    ...(presetName === undefined ? {} : { preset: presetName }),
    place,
    place_key: details.key,
    ...(place.harness === 'bro' ? { bro: place } : {}),
    ...(place.harness === 'cli'
      ? {
          cli: {
            agent: place.agent as CliAgent,
            can_continue: effective.can_continue === true,
            idle_grace_s: (args.idle_grace_s as number | undefined) ?? definition.idle_grace_s ?? 600,
            state_trust: details.state_trust ?? 'advisory',
          },
        }
      : {}),
    ...(place.harness === 'pi' || place.harness === 'cli'
      ? {
          model: details.model.value,
          thinking: place.thinking ?? details.thinking.value,
          model_source: modelSource,
        }
      : {}),
    dispatch_exit_code: null,
    stderr_tail: '',
    message_keys: [],
  };
  const dir = directory(job.job);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Pi and CLI workers write the report; the Jev CLI saves the browser's answer locally.
  const hudAsk = fileURLToPath(new URL('../../../../bin/hud-ask.mjs', import.meta.url));
  const brief =
    place.harness === 'bro'
      ? `${task}\n${context.block}`
      : place.harness === 'cli'
        ? `${task}\n\n${context.block}Write your report to ${join(dir, 'report.md')}.\nAsk the orchestrator with: node ${JSON.stringify(hudAsk)} --dir ${JSON.stringify(dir)} --question "..." --default "..."\n`
        : `${task}\n\n${context.block}Write your final answer to ${join(dir, 'report.md')}; the job fails without that file.\n`;
  const done = place.harness === 'cli' ? 'After writing the report, run the --done command from the prompt you are answering.\n' :
    `After writing the report, run: node ${JSON.stringify(join(bundled, 'bin', 'hud-progress.mjs'))} --done --dir ${JSON.stringify(dir)}\n`;
  const ending = place.harness === 'bro' ? '' : `${done}Then end your turn with the single line \`report written: ${join(dir, 'report.md')}\` and do not repeat the report in your final message.\n`;
  const sonicCommand = `node ${JSON.stringify(join(bundled, 'bin', 'hud-sonic.mjs'))}`;
  const sonic = role === 'sonic' || place.harness === 'bro' ? '' :
    `Sonic command: ${sonicCommand} start --dir ${JSON.stringify(dir)} --task-file <file> [--thinking off|low|medium|high]\n` +
    `Collect: ${sonicCommand} wait --dir ${JSON.stringify(dir)} --job <id>\n`;
  const progress = place.harness === 'bro' ? '' :
    `Optional milestone: node ${JSON.stringify(join(bundled, 'bin', 'hud-progress.mjs'))} --dir ${JSON.stringify(dir)} "message"\n`;
  // References follow the task: the panel title, sentence goal and decision labels read the brief's opening lines.
  fs.writeFileSync(join(dir, 'brief.md'), brief + sonic + progress + ending, { flag: 'wx', mode: 0o600 });
  // Persist before dispatch: an interrupted launch must not dispatch again on retry.
  save(job);
  if (parentJob) {
    // Index children locally so supervising one parent need not scan every HUD job.
    const children = join(directory(parentJob), '.sonic');
    fs.mkdirSync(children, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(children, job.job), '', { mode: 0o600, flag: 'wx' });
  } else createdJobs.add(job.job);
  // Reads can reveal the persisted ID before launch ends; serialize its mutations with launch too.
  const selected = definition.presets?.some((p) => p.run === definition.run);
  const launchRole = preset || selected ? { ...definition, skills: effective.skills } : definition;
  return keyLock(`job:${job.job}`, () => launchJob(job, launchRole, place, dir, instructionsPath, task, worktree));
}

async function launchJob(job: Job, definition: Role, place: RolePlace, dir: string, instructionsPath: string, task: string, worktree?: ManagedWorktree) {
  ensureWatcher();
  ensureQueueWatcher(job.herdr_pane, hudHome);
  let result: DispatchResult;
  try {
    if (worktree) {
      await addWorktree(worktree);
      job.worktree = worktree;
      job.cwd = worktree.root;
      save(job);
      await populateWorktree(worktree);
      if (place.harness === 'cli') propagateCliTrust(place.agent!, worktree.main_root, worktree.root);
    }
    if (place.harness === 'bro') result = await dispatchBro(job, task);
    else if (place.harness === 'cli') result = await dispatchCli(job, place, instructionsPath, task);
    else result = await dispatchPi(job, definition, place, task);
  } catch (error) {
    result = { exit_code: 1, stdout: '', stderr: String(error) };
  }
  job.dispatch_exit_code = result.exit_code;
  if (result.code) job.dispatch_code = result.code;
  job.stderr_tail = result.stderr;
  const statusFile = join(dir, 'STATUS.json');
  if (result.exit_code !== 0 && !fs.existsSync(statusFile)) {
    const rawReason = (
      result.stderr.trim() ||
      result.stdout.trim().split(/\r?\n/, 1)[0] ||
      `launch exited ${result.exit_code}`
    ).slice(0, 500);
    const outcome = recordFailureExhaustion(hudHome, bundled, dir, job, rawReason);
    if (outcome.marked) job.exhaustion_marked = true;
    fs.writeFileSync(
      `${statusFile}.${process.pid}.tmp`,
      JSON.stringify({
        state: 'failed',
        harness: place.harness,
        ...(place.harness === 'bro' ? { provider: place.provider === 'chatgpt' ? 'openai' : 'gemini' } : {}),
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
async function call(name: string, args: Args): Promise<unknown> {
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
    return {
      roles: [...found.roles().values()].map((role) => {
        const assignment = found.assignment(role, now, undefined, routing);
        return detail ? assignment : compactAssignment(assignment);
      }),
      ...(detail || invalid.length ? { invalid } : {}),
      convention_version,
      ...(args.convention_version === convention_version ? { convention_unchanged: true } : { convention }),
      project,
      ...(callerPane ? { watcher_alive: watching(callerPane, hudHome) } : {}),
      ...(ignored ? { project_config_ignored: ignored } : {}),
    };
  }
  if (name === 'hud_create') return dispatchJob(args, process.env.HERDR_PANE_ID);
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
  const job = /^j[0-9a-f]{16}$/.test(id) ? json<Job>(join(directory(id), 'job.json')) : null;
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
  if (name === 'hud_send') {
    const key = required(args, 'message_key');
    const message = required(args, 'text');
    const current = json<Job>(join(dir, 'job.json')) ?? job;
    if (current.message_keys.includes(key)) {
      const outcome = current.send_outcomes?.find((outcome) => outcome.key === key);
      if (outcome?.exit_code === 0) ensureQueueWatcher(process.env.HERDR_PANE_ID, hudHome);
      return outcome?.exit_code === 0
        ? { ok: true, sent: false }
        : { ok: false, sent: false, code: 'send_failed', ...outcome };
    }
    const agent = primary(dir);
    const { row, status } = readRow(current);
    const state = row.state ?? '';
    // A working pi or CLI job queues the message (the worker takes it after its current step); a settled one
    // continues in its idle grace when the role allows (owner, 2026-11-11).
    const queued = ['working', 'waiting_helper', 'waiting_orchestrator'].includes(state);
    const readReport = row.report_mtime !== null && !row.report_unread;
    if (
      current.bro ||
      current.jev ||
      !agent ||
      !(queued || (state === 'idle_grace' && !readReport && registry(current.worktree?.main_root ?? current.cwd).roles().get(current.role)?.can_continue))
    )
      return { ok: false, code: 'not_continuable' };
    // Record the attempt first, so a lost reply cannot cause a duplicate prompt.
    current.message_keys.push(key);
    const outcome = { key, exit_code: null as number | null, stderr_tail: '' };
    (current.send_outcomes ??= []).push(outcome);
    if (!current.cli) current.pi_sent_at = new Date().toISOString();
    save(current);
    // Read the rollback baseline at mutation time, with no pane query between it and the write.
    const prior = current.cli ? readTurn(dir) : null;
    const turn = current.cli ? writeTurn(dir, false, { key, pid: process.pid, start: procStat(process.pid)?.start ?? null }) : null;
    const result = await run('herdr', ['agent', 'prompt', agent, turn ? withDonePrompt(message, bundled, dir, turn) : message]);
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
  const create = name === 'hud_create';
  if (!create && name !== 'hud_send' && name !== 'hud_respond' && name !== 'hud_close') return null;
  const id = create ? args.request_key : args.job;
  // Leave validation to the tool, without making invalid calls wait for one another.
  if (typeof id !== 'string' || !id) return `invalid:${randomBytes(8).toString('hex')}`;
  return `${create ? 'request' : 'job'}:${id}`;
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
      result = {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'hud-mcp-thin', version: '0.1.4' },
        instructions: 'Call hud_roster when project dispatch context is missing or stale. With live watch, keep working until notified, then collect with hud_read.',
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools: [...tools, statuslineTool] };
      break;
    case 'resources/list':
      result = { resources: [statuslineResource] };
      break;
    case 'resources/templates/list':
      result = { resourceTemplates: [] };
      break;
    case 'resources/read':
      if (typeof request.params?.uri !== 'string') {
        rpcError(request.id, -32602, 'Invalid resource URI');
        return;
      }
      if (request.params.uri !== statuslineResource.uri) {
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
      if (name === statuslineTool.name) {
        result = { content: [{ type: 'text', text: `Codex statusline resource: ${statuslineResource.uri}` }] };
        break;
      }
      const invoke = () => call(name, args);
      try {
        const key = mutationKey(name, args);
        // Refuse before invocation or reporting changes, which can record quota exhaustion.
        if (isWorker && key !== null) {
          result = { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'worker_cannot_dispatch' }) }] };
        } else {
          const value = key === null ? await invoke() : await keyLock(key, invoke);
          const markExhaustion = !isWorker && name !== 'hud_peek';
          if (typeof value === 'string') {
            const content = [{ type: 'text', text: value }];
            const delta = withChanges({}, markExhaustion) as { changes?: unknown[] };
            if (delta.changes) content.push({ type: 'text', text: JSON.stringify(delta) });
            result = { content };
          } else {
            result = { content: [{ type: 'text', text: JSON.stringify(withChanges(value, markExhaustion)) }] };
          }
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
  cursor = new Map(sessionRows(false).map((row) => [row.job, row]));
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    void receive(line);
  });
}
