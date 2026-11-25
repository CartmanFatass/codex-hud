/** CLI launch and supervisor setup. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isCliDirTrusted } from '../../cli/trust.js';
import { cliKinds, type CliAgent } from '../../roles/cli-kinds.js';
import { herdrId } from '../../roles/herdr-run.js';
import { executablePath, type RolePlace } from '../../roles/roster.js';
import { recordTabShells } from '../../runtime/tab-shell.js';
import { prepareCliInvocation } from '../../runtime/cli-invocation.js';
import { writePrivateFile } from '../../utils/atomic-fs.js';
import { isProcAlive } from '../../utils/proc.js';
import { writeTurn, withDonePrompt, reportSignature } from '../cli-judge.js';
import { cliWorkerStartup, isHerdrAgentArg, type StandingBriefRef } from '../cli-worker-startup.js';
import type { JobStatus, Job, SessionReceipt } from '../job-contracts.js';
import { jobFiles } from '../paths.js';
import { startHeadlessProcess } from '../sonic-process.js';
import { jobCache, directory, bundled, hudHome, save, writeCreateStatus } from '../store/job-store.js';
import type { NativeResume } from '../worker-resume.js';
import {
  run, binScript, launchError, rejectLaunch, dispatchBase, tabLabel, workspaceArgs, retryBusyPane,
  startupFailure, paneText, refusedBeforeInput, type DispatchResult,
} from './proc.js';

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
export function supervisorPid(dir: string, status: JobStatus | null): number | null {
  const fromFile = jobCache.readPid(join(dir, jobFiles.supervisorPid));
  if (fromFile !== null) return fromFile;
  const fromStatus = status?.supervisor_pid;
  return typeof fromStatus === 'number' && Number.isInteger(fromStatus) && fromStatus > 1 ? fromStatus : null;
}
export function supervisorAlive(pid: number): boolean {
  return isProcAlive(pid);
}
export function spawnCliSupervisor(dir: string): number | null {
  const script = binScript('hud-cli.mjs');
  const child = spawn(process.execPath, [script, dir], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.error(`hud-cli: ${error.message}`));
  if (child.pid) {
    const pidFile = join(dir, jobFiles.supervisorPid);
    writePrivateFile(pidFile, `${child.pid}\n`, { mkdir: false });
    jobCache.invalidateFile(pidFile);
  }
  child.unref();
  return child.pid ?? null;
}
/** Trust refusals use the same STATUS keys as hud-cli.mjs if this is the last attempt. */
export function failCli(dir: string, job: Job, place: RolePlace, reason: string) {
  const now = new Date().toISOString();
  const status: JobStatus = {
    version: 1,
    task_dir: fs.realpathSync(dir),
    slot: 'primary',
    harness: 'cli',
    agent: place.agent,
    role: job.role,
    model: job.model ?? null,
    thinking: job.thinking ?? null,
    state: 'failed',
    output_path: join(dir, jobFiles.report),
    output_written: false,
    pid: null,
    pid_start_time: null,
    agent_session_id: null,
    started_at: now,
    settled_at: now,
    idle_deadline_at: null,
    ended_at: now,
    exit_reason: 'untrusted_cwd',
    error: reason,
    updated_at: now,
  };
  return { ...launchError(reason), status };
}

export async function dispatchCli(job: Job, place: RolePlace, instructions: string, task: string, servers: readonly string[], standingBrief?: StandingBriefRef, options: { callerToken?: string; resume?: NativeResume } = {}): Promise<DispatchResult> {
  const { callerToken, resume } = options;
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
    const startup = cliWorkerStartup(place, job.cwd, dir, instructions, binScript('hud-mcp.mjs'), servers, standingBrief);
    const nativeArgs = [
      ...(place.model ? kind.model(place.model) : []),
      ...(place.thinking ? kind.effort(place.thinking) : []),
      ...kind.bypass,
      ...(place.args ?? []),
      ...startup.args,
    ];
    // An arbitrary CLI option has no equivalent prompt fallback. Let the next
    // configured place run instead of dropping or changing the option.
    if (!nativeArgs.every(isHerdrAgentArg)) return reject(launchError('CLI startup arguments contain control characters'));
    if (job.cli && startup.warning) job.cli.mcp_scope_warning = startup.warning;
    if (job.headless) {
      const turn = writeTurn(dir, { restarted: !!resume, callerToken });
      const prompt = withDonePrompt(resume?.message ?? startup.prompt, bundled, dir, turn, place.agent!);
      const initialId = !resume && place.agent === 'claude' ? randomUUID() : undefined;
      startHeadlessProcess(dir, job, [...nativeArgs, ...kind.headless!(prompt, resume?.id, initialId)], { id: resume?.id, initialId });
      return { exit_code: 0, stdout: '', stderr: '' };
    }
    const target = executablePath(place.agent!);
    if (!target) return reject(launchError(`${place.agent} executable not found`));
    const agentArgs = resume ? kind.resume!(resume.id, nativeArgs) : nativeArgs;
    const base = job.worktree?.base_head ?? await dispatchBase(job.cwd);
    const tabName = tabLabel(job, task),
      name = `${job.job}-primary`;
    const tabArgv = [
      'tab',
      'create',
      ...(place.agent === 'codex' ? ['--env', `CODEX_HOME=${resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))}`] : []),
      ...(place.agent === 'claude' && process.env.CLAUDE_CONFIG_DIR ? ['--env', `CLAUDE_CONFIG_DIR=${resolve(process.env.CLAUDE_CONFIG_DIR)}`] : []),
      ...(await workspaceArgs(job)),
      '--cwd',
      job.cwd,
      '--label',
      tabName,
      '--env',
      `HUD_JOB_DIR=${dir}`,
      '--env',
      `HUD_HOME=${hudHome}`,
      // A killed `git status` (a worker's tool timeout) would leave a stale index.lock that blocks every later commit.
      '--env',
      'GIT_OPTIONAL_LOCKS=0',
    ];
    const starting: JobStatus = { version: 1, slot: 'primary', task_dir: fs.realpathSync(dir), state: 'working', harness: 'cli', agent: place.agent, pid: null, pid_start_time: null };
    let left = '';
    let started: Awaited<ReturnType<typeof run>> = { exit_code: 1, stdout: '', stderr: 'tab create not attempted', notStarted: false };
    for (let tabAttempt = 0; tabAttempt < 2; tabAttempt++) {
      const launch = randomUUID();
      const { env } = prepareCliInvocation(dir, launch, place.agent!, target);
      const witnessEnv = Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
      const result = await run('herdr', [...tabArgv, '--env', `HUD_TAB_LAUNCH=${launch}`, ...witnessEnv, '--no-focus']);
      if (result.exit_code !== 0) return reject(result);
      const { tab, root_pane } = JSON.parse(result.stdout).result;
      if (herdrId(tab?.tab_id)) openedTab = tab.tab_id;
      left = root_pane?.pane_id;
      if (!openedTab || !herdrId(left)) throw new Error('tab create did not return tab/root pane ids');
      const fields: SessionReceipt = {
        TASK: job.job, LAUNCH: launch,
        TAB: tab.tab_id,
        TAB_NAME: tabName,
        LEFT: left,
        RIGHT: '',
        ORCH: job.herdr_pane,
        BASE: base,
        PRIMARY: name,
      };
      if (Object.values(fields).some((value) => /[\r\n]/.test(value))) throw new Error('newlines in SESSION values');
      const sessionFile = join(dir, jobFiles.session);
      writePrivateFile(
        sessionFile,
        Object.entries(fields)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(''),
        { mkdir: false }
      );
      jobCache.invalidateFile(sessionFile);
      writeCreateStatus(dir, starting); // Stop intent may arrive before the supervisor discovers the worker.
      await recordTabShells(dir, launch, openedTab, [left]);
      const argv = ['agent', 'start', name, '--kind', place.agent!, '--pane', left];
      if (kind.startTimeoutMs) argv.push('--timeout', String(kind.startTimeoutMs));
      argv.push('--', ...agentArgs);
      // Keep start arguments in detailed diagnostics only; never record the first prompt.
      if (!tabAttempt) {
        const args = agentArgs.slice(0, 32).map(arg => arg.length <= 128 ? arg : `${arg.slice(0, 127)}…`);
        if (args.length < agentArgs.length) args.push('…');
        job.launch_agent_args = [...(job.launch_agent_args ?? []).slice(-3), { place: job.place_key ?? place.agent!, args }];
        save(job);
      }
      started = await run('herdr', argv);
      if (!await retryBusyPane(started, tabAttempt, openedTab)) break;
      openedTab = undefined;
    }
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
    if (resume) {
      const got = await run('herdr', ['agent', 'get', name]);
      const agent = got.exit_code === 0 ? JSON.parse(got.stdout).result?.agent : null;
      if (agent?.agent_session?.kind !== 'id' || agent.agent_session.value !== resume.id)
        return reject(launchError(`${place.agent} did not open the recorded session`));
    }
    const turn = writeTurn(dir, { restarted: !!resume, callerToken });
    const prompt = withDonePrompt(resume?.message ?? startup.prompt, bundled, dir, turn, place.agent!);
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
