/** Six local pi-roles tools, newline-delimited JSON-RPC over stdio. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { procStat, readTurn, saveTurn, workerAlive, writeTurn } from './cli-judge.js';
import { isCliDirTrusted } from '../../../src/cli/trust.js';
import { jobChanges, jobRow, type JobRow } from '../../../src/collectors/thin-jobs.js';
import { PanelActionLog } from '../../../src/collectors/panel-actions.js';
import { TryLog } from '../../../src/collectors/try-records.js';
import { cliKinds, type CliAgent } from '../../../src/roles/cli-kinds.js';
import { herdrId } from '../../../src/roles/herdr-run.js';
import {
  roleRegistry,
  harnessDefaults,
  placeKey,
  recordFailureExhaustion,
  executable,
  piSwitches,
  type Role,
  type RolePlace,
} from '../../../src/roles/roster.js';
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
  model?: string | null;
  thinking?: string | null;
  model_source?: string | null;
  read_at?: string;
  parent_job?: string;
  pi_sent_at?: string;
  observed_at?: string;
  reaped_at?: string;
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
const text = { type: 'string' };
const tool = (name: string, description: string, properties: Args, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
const tools = [
  tool(
    'hud_roster',
    "List local roles, their availability, and the dispatch convention in effect. Optional cwd selects the project (default: this server's cwd).",
    { cwd: { ...text, description: "Project directory. Default: the server's cwd." } }
  ),
  tool(
    'hud_create',
    "Dispatch a local role; request_key returns the existing job unchanged on retry. cwd resolves roles for that project (default: this server's cwd). Uses the first available place in the role's run or named preset; use on instead to override the harness. model and thinking override pi or CLI places; kind is flow-only, idle_grace_s is CLI-only, and launch switches and pi_args are pi-only.",
    {
      role: text,
      request_key: text,
      task: text,
      cwd: { ...text, description: "Job directory. Roles resolve against this project. Default: the server's cwd." },
      package: { ...text, description: 'Display-only package label.' },
      idle_grace_s: { type: 'integer', minimum: 60, maximum: 3600, description: 'CLI-only idle grace override for this job, in seconds.' },
      on: {
        ...text,
        description:
          'Override the harness or browser provider for this job only (pi, agy, claude, codex, grok, chatgpt, gemini, argon, flow).',
      },
      preset: { type: 'string', description: 'Select a named role preset for this job without editing role files.' },
      kind: { type: 'string', enum: ['image', 'video'], description: 'Flow output kind: image (default) or video.' },
      model: { ...text, description: 'Override the pi or cli role model for this job only.' },
      thinking: { ...text, description: 'Override the pi or cli role thinking for this job only.' },
      lens: { type: 'boolean', description: 'Load pi-lens (--lens / --no-lens).' },
      mcp: { type: 'boolean', description: 'Load MCP adapter (--mcp / --no-mcp).' },
      tps: { type: 'boolean', description: 'Load tokens/s telemetry (--tps / --no-tps).' },
      ui_ext: {
        type: 'boolean',
        description: 'False: --no-ui-ext; true: keep pi-role default UI extensions (no flag).',
      },
      skills: {
        type: 'boolean',
        description: 'True: --skills (personal skills); false: keep pi-role default exclusion (no flag).',
      },
      split: { type: 'boolean', description: 'Reserve a helper pane on the right; primary worker stays left.' },
      pi_args: {
        type: 'array',
        items: { ...text, maxLength: 4096 },
        maxItems: 128,
        description:
          'Append pi arguments after -- verbatim, never through a shell; --orchestrator and --notify are reserved for the inherited caller binding.',
      },
    },
    ['role', 'request_key', 'task']
  ),
  tool(
    'hud_read',
    'List running jobs and jobs that need attention, or read one job, optionally waiting for settlement or a question. Reading a settled report from the main session closes the worker.',
    {
      job: text,
      wait_ms: { type: 'integer', minimum: 0, maximum: 120000 },
      full: { type: 'boolean', description: 'Include the report even if already read.' },
      view: {
        type: 'string',
        enum: ['compact', 'recent'],
        description: 'List only, without a job. Default: compact. Use recent for the newest 20 full rows.',
      },
    }
  ),
  tool(
    'hud_send',
    'Send a message to a pi or CLI job: queued while it works, or continued during idle_grace before the report is read (roles that can continue); message_key deduplicates sends.',
    { job: text, message_key: text, text },
    ['job', 'message_key', 'text']
  ),
  tool('hud_respond', 'Write a question answer once.', { job: text, request_id: text, answer: text }, [
    'job',
    'request_id',
    'answer',
  ]),
  tool('hud_close', 'Reap a job with pi-role-reap; safe to repeat.', { job: text }, ['job']),
];

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
  const reaped_at = existing?.reaped_at;
  if (reaped_at) job.reaped_at = reaped_at;
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
      reason: row.reason ?? 'dispatch failed',
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
function tabLabel(job: Job): string {
  const lines = (slice(join(directory(job.job), 'brief.md'), 4096)?.text ?? '').split(/\r?\n/);
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
  const gate = registry(job.cwd).project();
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
async function dispatchPi(job: Job, role: Role, place: RolePlace) {
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
    const git = await run('git', ['rev-parse', 'HEAD'], job.cwd);
    const base = git.exit_code === 0 ? git.stdout.trim() : 'HEAD';
    const tabName = tabLabel(job),
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
async function dispatchBro(job: Job) {
  const dir = directory(job.job),
    tabName = tabLabel(job);
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
  return run('herdr', ['pane', 'run', root_pane.pane_id, [process.execPath, script, dir].map(quote).join(' ')]);
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
async function dispatchCli(job: Job, place: RolePlace, instructions: string): Promise<DispatchResult> {
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
    const git = await run('git', ['rev-parse', 'HEAD'], job.cwd);
    const base = git.exit_code === 0 ? git.stdout.trim() : 'HEAD';
    const tabName = tabLabel(job),
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
    const prompt = `Read ${instructions} and then ${join(dir, 'brief.md')} and do exactly what the brief asks.`;
    writeTurn(dir);
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
  // As in hud watch catch-up, a newer STATUS needs attention again.
  const observed = Date.parse(job.observed_at ?? '');
  if (!Number.isFinite(observed)) return true;
  try {
    return fs.statSync(join(directory(job.job), 'STATUS.json')).mtimeMs > observed;
  } catch {
    return true;
  }
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
    const reason = row.blocked || row.state === 'waiting_orchestrator' || failed ? row.reason : null;
    return [
      {
        job: row.job,
        role: row.role,
        state: row.state ?? row.display_state,
        ...(row.report_unread ? { report_unread: true } : {}),
        ...(row.blocked ? { blocked: true } : {}),
        ...(row.question_ids.length ? { question_ids: row.question_ids } : {}),
        ...(reason ? { reason } : {}),
      },
    ];
  });
}

function openQuestions(dir: string): string[] {
  const qa = join(dir, 'qa');
  return entries(qa)
    .filter((name) => /^q\d+\.md$/.test(name))
    .filter((name) => !fs.existsSync(join(qa, name.replace('.md', '.answer.md'))))
    .sort();
}
function observation(job: Job, full = false) {
  const dir = directory(job.job);
  const { row, status } = readRow(job, !isWorker);
  const report = row.report_unread || full ? slice(join(dir, 'report.md'), 65536) : null;
  const questions = openQuestions(dir).map((name) => ({
    id: name.slice(0, -3),
    text: slice(join(dir, 'qa', name), 2048)?.text ?? '',
  }));
  return {
    job: job.job,
    role: job.role,
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
    state: row.state,
    display_state: row.display_state,
    reason: row.reason,
    blocked: row.blocked,
    exit_reason: typeof status?.exit_reason === 'string' ? status.exit_reason : null,
    // Why a quiet CLI job went where it did (e.g. `needs-human` / `prompt-failed`); absent when never asked.
    ...(status?.quiet_decision && typeof status.quiet_decision === 'object' ? { quiet_decision: status.quiet_decision } : {}),
    dispatch_exit_code: job.dispatch_exit_code,
    stderr_tail: job.stderr_tail,
    report_exists: row.report_present,
    report_unread: row.report_unread,
    ...(row.report_present && !report
      ? { report_unchanged: true }
      : { report: report?.text ?? null, report_truncated: report?.truncated ?? false }),
    questions,
  };
}
export async function dispatchJob(args: Args, pane: string | undefined, parentJob?: string) {
  const asked = required(args, 'role');
  const cwd = jobCwd(args);
  const found = registry(cwd);
  // `architect` names oracle unless a role file defines its own architect.
  const role = asked === 'architect' && !found.roles().has(asked) ? 'oracle' : asked;
  const definition = found.roles().get(role);
  if (!definition) {
    const path = found.invalidPath(role);
    return path ? { ok: false, code: 'role_unavailable', path } : { ok: false, code: 'role_unavailable' };
  }
  const request_key = required(args, 'request_key');
  const existing = jobs().find((job) => job.request_key === request_key);
  if (existing) {
    ensureWatcher();
    ensureQueueWatcher(pane, hudHome);
    return created(existing);
  }
  if (!herdrId(pane)) return { ok: false, code: 'herdr_required' };
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
  const effective = found.assignment(preset ? { ...definition, run: preset.run } : definition);
  let place: RolePlace | null = onEntry
    ? { ...(definition.run.find((p) => matchPlace(p, onEntry)) ?? {}), ...onEntry }
    : effective.runs_on
      ? { ...effective.runs_on }
      : null;
  if (!place) {
    return {
      ok: false,
      code: 'no_available_place',
      ...(preset || effective.exhausted.length ? { exhausted: effective.exhausted } : {}),
    };
  }
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
  for (const key of ['model', 'thinking'] as const) {
    if (args[key] === undefined) continue;
    if (place.harness !== 'pi' && place.harness !== 'cli') return { ok: false, code: 'invalid_arguments' };
    place = { ...place, [key]: required(args, key) };
  }
  const options: PiOptions = place.harness === 'pi' ? { split: place.split ?? false, pi_args: [] } : {};
  for (const key of piSwitches) {
    const value = args[key];
    if (value === undefined) continue;
    if (place.harness !== 'pi' || typeof value !== 'boolean') return { ok: false, code: 'invalid_arguments' };
    options[key] = value;
  }
  if (args.pi_args !== undefined) {
    if (
      place.harness !== 'pi' ||
      !Array.isArray(args.pi_args) ||
      args.pi_args.length > 128 ||
      args.pi_args.some((value) => typeof value !== 'string' || value.length > 4096)
    )
      return { ok: false, code: 'invalid_arguments' };
    if (args.pi_args.some((value) => /^--(?:orchestrator|notify)(?:=|$)/.test(value)))
      return {
        ok: false,
        code: 'invalid_arguments',
        error: 'pi_args cannot override --orchestrator or --notify caller binding',
      };
    options.pi_args = args.pi_args;
  }
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
  const details = found.placeDetails(definition, place);
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
  const key = placeKey(place, details.model.value);
  const job: Job = {
    job: 'j' + randomBytes(8).toString('hex'),
    role,
    request_key,
    cwd,
    herdr_pane: pane,
    created_at: new Date().toISOString(),
    ...(parentJob ? { parent_job: parentJob } : {}),
    ...options,
    ...(args.package === undefined ? {} : { package: args.package as string }),
    ...(presetName === undefined ? {} : { preset: presetName }),
    place,
    place_key: key,
    ...(place.harness === 'bro' ? { bro: place } : {}),
    ...(place.harness === 'cli'
      ? {
          cli: {
            agent: place.agent as CliAgent,
            can_continue: definition.can_continue === true,
            idle_grace_s: (args.idle_grace_s as number | undefined) ?? definition.idle_grace_s ?? 600,
            state_trust: details.state_trust ?? 'advisory',
          },
        }
      : {}),
    ...(place.harness === 'pi' || place.harness === 'cli'
      ? {
          model: details.model.value,
          thinking: details.thinking.value,
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
      ? `${task}\n`
      : place.harness === 'cli'
        ? `${task}\n\nWrite your report to ${join(dir, 'report.md')}.\nAsk the orchestrator with: node ${JSON.stringify(hudAsk)} --dir ${JSON.stringify(dir)} --question "..." --default "..."\n`
        : `${task}\n\nWrite your final answer to ${join(dir, 'report.md')}; the job fails without that file.\n`;
  const ending = place.harness === 'bro' ? '' : `Once the report file is written, end your turn with the single line \`report written: ${join(dir, 'report.md')}\` and do not repeat the report in your final message.\n`;
  const sonicCommand = `node ${JSON.stringify(join(bundled, 'bin', 'hud-sonic.mjs'))}`;
  const sonic = role === 'sonic' || place.harness === 'bro' ? '' :
    `Sonic command: ${sonicCommand} start --dir ${JSON.stringify(dir)} --task-file <file> [--thinking off|low|medium|high]\n` +
    `Collect: ${sonicCommand} wait --dir ${JSON.stringify(dir)} --job <id>\n`;
  fs.writeFileSync(join(dir, 'brief.md'), brief + sonic + ending, { flag: 'wx', mode: 0o600 });
  // Persist before dispatch: an interrupted launch must not dispatch again on retry.
  save(job);
  if (parentJob) {
    // Index children locally so supervising one parent need not scan every HUD job.
    const children = join(directory(parentJob), '.sonic');
    fs.mkdirSync(children, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(children, job.job), '', { mode: 0o600, flag: 'wx' });
  } else createdJobs.add(job.job);
  // Reads can reveal the persisted ID before launch ends; serialize its mutations with launch too.
  const launchRole = preset ? { ...definition, skills: effective.skills } : definition;
  return keyLock(`job:${job.job}`, () => launchJob(job, launchRole, place, dir, instructionsPath));
}

async function launchJob(job: Job, definition: Role, place: RolePlace, dir: string, instructionsPath: string) {
  ensureWatcher();
  ensureQueueWatcher(job.herdr_pane, hudHome);
  let result: DispatchResult;
  try {
    if (place.harness === 'bro') result = await dispatchBro(job);
    else if (place.harness === 'cli') result = await dispatchCli(job, place, instructionsPath);
    else result = await dispatchPi(job, definition, place);
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

async function call(name: string, args: Args): Promise<unknown> {
  if (name === 'hud_roster') {
    const found = registry(jobCwd(args));
    const gate = found.project();
    const ignored = found.projectConfigIgnored();
    return {
      roles: [...found.roles().values()].map((role) => found.assignment(role)),
      invalid: found.invalid(),
      convention: found.convention(),
      project: { root: gate.root, registered: gate.registered },
      ...(callerPane ? { watcher_alive: watching(callerPane, hudHome) } : {}),
      ...(ignored ? { project_config_ignored: ignored } : {}),
    };
  }
  if (name === 'hud_create') return dispatchJob(args, process.env.HERDR_PANE_ID);
  if (name === 'hud_read') {
    const { view } = args;
    if (view !== undefined) {
      if (view !== 'compact' && view !== 'recent') throw new Error('invalid_arguments: view');
      if (args.job !== undefined) throw new Error('invalid_arguments: view is list-only');
    }
    if (args.job === undefined) return { jobs: listJobs(view === 'recent') };
  }
  if (!tools.some((tool) => tool.name === name)) throw new Error('unknown_tool');
  const id = required(args, 'job');
  const job = /^j[0-9a-f]{16}$/.test(id) ? json<Job>(join(directory(id), 'job.json')) : null;
  if (!job) return { ok: false, code: 'job_not_found' };
  const dir = directory(job.job);
  if (name === 'hud_read') {
    if (args.full !== undefined && typeof args.full !== 'boolean') throw new Error('invalid_arguments: full');
    if (args.wait_ms !== undefined && (typeof args.wait_ms !== 'number' || !Number.isFinite(args.wait_ms)))
      throw new Error('invalid_arguments: wait_ms');
    const end = Date.now() + Math.max(0, Math.min(120000, (args.wait_ms as number | undefined) ?? 0));
    const settled = (state: string | null) => ['idle_grace', 'closed', 'done', 'failed', 'stopped'].includes(state ?? '');
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
        const result = observation(json<Job>(join(dir, 'job.json')) ?? job, args.full === true);
        // A question may have been answered or a settled job continued since the lightweight poll.
        const currentRow = jobRow(job, json<Record<string, unknown>>(join(dir, 'STATUS.json')), {
          dir,
          openQuestions: result.questions.length,
          reportPresent: result.report_exists,
        });
        // The full read disagrees with the quick one (answered or continued meanwhile): wait, never spin.
        if (!ready(currentRow)) {
          await sleep(Math.max(0, Math.min(200, end - Date.now())));
          continue;
        }
        if (!isWorker && (('report' in result && result.report_exists) || result.blocked || result.display_state === 'failed')) {
          const latest = json<Job>(join(dir, 'job.json'))!;
          const at = new Date().toISOString();
          if ('report' in result && result.report_exists) latest.read_at = at;
          if (result.blocked || result.display_state === 'failed') latest.observed_at = at;
          save(latest);
        }
        return result;
      }
      await sleep(Math.min(500, end - Date.now()));
    }
  }
  if (name === 'hud_send') {
    const key = required(args, 'message_key');
    const message = required(args, 'text');
    if (job.message_keys.includes(key)) {
      const outcome = job.send_outcomes?.find((outcome) => outcome.key === key);
      if (outcome?.exit_code === 0) ensureQueueWatcher(process.env.HERDR_PANE_ID, hudHome);
      return outcome?.exit_code === 0
        ? { ok: true, sent: false }
        : { ok: false, sent: false, code: 'send_failed', ...outcome };
    }
    const agent = primary(dir);
    const { row, status } = readRow(job);
    const state = row.state ?? '';
    // A working pi or CLI job queues the message (the worker takes it after its current step); a settled one
    // continues in its idle grace when the role allows (owner, 2026-11-11).
    const queued = ['working', 'waiting_helper', 'waiting_orchestrator'].includes(state);
    const readReport = row.report_mtime !== null && !row.report_unread;
    if (
      job.bro ||
      job.jev ||
      !agent ||
      !(queued || (state === 'idle_grace' && !readReport && registry(job.cwd).roles().get(job.role)?.can_continue))
    )
      return { ok: false, code: 'not_continuable' };
    // Record the attempt first, so a lost reply cannot cause a duplicate prompt.
    job.message_keys.push(key);
    const outcome = { key, exit_code: null as number | null, stderr_tail: '' };
    (job.send_outcomes ??= []).push(outcome);
    if (!job.cli) job.pi_sent_at = new Date().toISOString();
    save(job);
    // Baseline before typing: even a fast report belongs to this explicit turn.
    const prior = job.cli ? readTurn(dir) : null;
    const turn = job.cli ? writeTurn(dir, false, { key, pid: process.pid, start: procStat(process.pid)?.start ?? null }) : null;
    // agent prompt types the text and submits it with Enter.
    const result = await run('herdr', ['agent', 'prompt', agent, message]);
    if (turn && refusedBeforeInput(result)) {
      const active = readTurn(dir);
      if (active?.seq === turn.seq && active.send?.key === key && active.send.pid === process.pid) {
        if (prior) saveTurn(dir, prior);
        else fs.unlinkSync(join(dir, 'turn.json'));
      }
    }
    const latest = json<Job>(join(dir, 'job.json')) ?? job;
    const attempted = latest.send_outcomes?.find((attempt) => attempt.key === key) ?? outcome;
    attempted.exit_code = result.exit_code;
    attempted.stderr_tail = result.stderr;
    save(latest);
    if (result.exit_code === 0) ensureQueueWatcher(process.env.HERDR_PANE_ID, hudHome);
    if (result.exit_code === 0 && job.cli) {
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
  // Idle grace already finished: reap quits and the supervisor closes. A working job is stop-requested and SIGTERMed.
  if (job.cli && readRow(job).row.state === 'idle_grace') {
    try {
      fs.writeFileSync(join(dir, 'STATUS.json.close-requested'), '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const result = await run('pi-role-reap', [dir]);
  return {
    exit_code: result.exit_code,
    last_line: (result.stdout.trim() || result.stderr.trim()).split('\n').at(-1) ?? '',
  };
}

const callerPane = herdrId(process.env.HERDR_PANE_ID) ? process.env.HERDR_PANE_ID! : null;
const createdJobs = new Set<string>();
const isSessionJob = (job: Job) => (callerPane ? job.herdr_pane === callerPane : createdJobs.has(job.job));
function sessionRows(): JobRow[] {
  return jobs()
    .filter(isSessionJob)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.job.localeCompare(b.job))
    .slice(0, 200)
    .map((job) => readRow(job, !isWorker).row);
}
let cursor: Map<string, JobRow>;
const tries = new TryLog(hudHome), answers = new PanelActionLog(hudHome);
function withChanges(value: unknown): unknown {
  // Snapshot, diff and advance the shared cursors synchronously, in response order.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const rows = sessionRows();
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
        capabilities: { tools: {} },
        serverInfo: { name: 'hud-mcp-thin', version: '0.1.4' },
        instructions: 'Call hud_roster before dispatching.',
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools };
      break;
    case 'tools/call': {
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
        rpcError(request.id, -32602, 'Invalid params');
        return;
      }
      const invoke = () => call(name, args);
      try {
        const key = mutationKey(name, args);
        // Refuse before invocation or reporting changes, which can record quota exhaustion.
        const value =
          isWorker && key !== null
            ? { ok: false, code: 'worker_cannot_dispatch' }
            : withChanges(key === null ? await invoke() : await keyLock(key, invoke));
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
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
  cursor = new Map(sessionRows().map((row) => [row.job, row]));
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    void receive(line);
  });
}
