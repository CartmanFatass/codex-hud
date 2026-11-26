/** Pi launch and native session setup. */
import { herdrEndpoint, isHudHerdrFork } from '../../runtime/herdr-socket.js';
import { recordTabShells } from '../../runtime/tab-shell.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { piWorkerArgv } from './pi-worker-argv.js';
import { implicitPiProfile } from '../../roles/pi-defaults.js';
import { isAbsolute, join, dirname } from 'node:path';
import { jobCallerPane } from '../../roles/job-pane.js';
import { herdrId } from '../../roles/herdr-run.js';
import { executablePath, type Role, type RolePlace } from '../../roles/roster.js';
import { writePrivateFile } from '../../utils/atomic-fs.js';
import { briefPrompt } from '../brief-prompt.js';
import type { Job } from '../job-contracts.js';
import { jobFiles } from '../paths.js';
import { sonicLimits } from '../sonic-policy.js';
import { startHeadlessProcess } from '../sonic-process.js';
import { prepareSonicRetry } from '../sonic-session.js';
import { directory, findJob, readCachedStatus, hudHome, save, jobCache } from '../store/job-store.js';
import type { NativeResume } from '../worker-resume.js';
import {
  retainDirectFailure, startDirectAgent, waitDirectReady,
  writeDirectSessionReceipt, writeSessionReceipt, type DirectStartIdentity,
} from './direct-exec.js';
import { promptBoundary, recoverStalledPrompt } from './prompt-stall.js';
import { registry, roleCwd } from './places.js';
import {
  rejectLaunch, run, dispatchBase, tabLabel, workspaceArgs, retryBusyPane,
  startupFailure, launchError, refusedBeforeInput, promptStalled, directExecEnv, type DispatchResult,
} from './proc.js';

/** A skill name is one path segment under `.hud/skills`. Anything else is not a link we made. */
export function plainSkillName(name: string): boolean {
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
  const gate = registry(roleCwd(job)).project();
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
export async function dispatchPi(job: Job, role: Role, place: RolePlace, task: string, resume?: NativeResume): Promise<DispatchResult> {
  const dir = directory(job.job);
  let openedTab: string | undefined;
  let directIdentity: DirectStartIdentity | undefined;
  let isFork = false;
  let directStartSent = false;
  let mayHaveInput = false;
  const rollback = (result: DispatchResult): Promise<DispatchResult> => {
    if (!isFork) return rejectLaunch(result, openedTab);
    if (directIdentity) return Promise.resolve(
      resume
        ? { ...result, preInput: true, cleanupFailed: false, directRollback: directIdentity }
        : retainDirectFailure(dir, job, 'pi', undefined, directIdentity, result)
    );
    if (directStartSent) return Promise.resolve({ ...result, preInput: false, cleanupFailed: true, launchUnknown: true });
    return Promise.resolve({ ...result, preInput: true, cleanupFailed: false });
  };
  try {
    const resources = piSkillArgs(job, role, place);
    const piBin = executablePath('pi');
    if (!piBin) throw new Error('pi not found on PATH');
    const sessionFile = job.headless && job.role !== 'sonic' ? resume?.file ?? join(dir, 'sessions', `${job.job}.jsonl`) : undefined;
    let continuation = resume?.message;
    if (job.role === 'sonic' && job.retry_of) {
      const source = findJob(job.retry_of);
      if (source?.role === 'sonic') continuation = prepareSonicRetry(dir, job.cwd, source, directory(source.job), readCachedStatus(source.job).status);
    }
    const prompt = continuation ?? briefPrompt(join(dir, jobFiles.brief));
    const profile = place.pi_role ?? implicitPiProfile(role.instructions);
    if (job.headless) {
      const args = piWorkerArgv(hudHome, dir, job, role, profile, resources, prompt, sessionFile);
      if (sessionFile) {
        if (!resume) {
          fs.mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
          writePrivateFile(sessionFile, '', { exclusive: true, mkdir: false });
        }
        job.pi_sent_at = new Date().toISOString();
        save(job);
      }
      try {
        startHeadlessProcess(dir, job, args, sessionFile ? { file: sessionFile, id: resume?.id } : undefined,
          job.role === 'sonic' ? sonicLimits(role) : undefined);
      } catch (error) {
        // A rejected handshake never starts pi. Allow another place to launch a fresh session.
        if (sessionFile && !resume) fs.rmSync(sessionFile, { force: true });
        throw error;
      }
      return { exit_code: 0, stdout: '', stderr: '' };
    }
    const effortSource = place.thinking !== undefined ? 'orchestrator' : undefined;
    const piArgs = piWorkerArgv(hudHome, dir, job, role, profile, resources, undefined, resume?.file, effortSource);
    const owner = jobCallerPane(job);
    isFork = await isHudHerdrFork();
    let left = '';
    let started: DispatchResult = { exit_code: 1, stdout: '', stderr: 'tab create not attempted' };
    const name = `${job.job}-primary`;
    if (isFork) {
      fs.mkdirSync(join(dir, jobFiles.qa), { recursive: true, mode: 0o700 });
      const base = job.worktree?.base_head ?? await dispatchBase(job.cwd);
      const tabName = tabLabel(job, task);
      const wsArgs = await workspaceArgs(job);
      const workspaceId = wsArgs[1];
      const endpoint = herdrEndpoint();
      directStartSent = true;
      const launch = await startDirectAgent({
        executable: piBin,
        argv: piArgs,
        kind: 'pi',
        name,
        cwd: job.cwd,
        env: directExecEnv({
          HUD_JOB_DIR: dir,
          HUD_HOME: hudHome,
          ...(resume ? { HUD_RESUME_SESSION_ID: resume.id } : {}),
          // A killed `git status` (a worker's tool timeout) would leave a stale index.lock that blocks every later commit.
          GIT_OPTIONAL_LOCKS: '0',
        }),
        label: tabName,
        on_exit: 'close_on_zero',
        focus: false,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
      });
      if (!launch.ok) return launch.result;
      directIdentity = launch.identity;
      left = directIdentity.paneId;
      let right = '';
      let rightTerminalId: string | undefined;
      const recordDirect = () => writeDirectSessionReceipt(dir, directIdentity!, {
        task: job.job,
        endpoint,
        tabName,
        right,
        rightTerminalId,
        orch: owner,
        base,
        primary: name,
      });
      recordDirect();
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
          '--env', `HUD_JOB_DIR=${dir}`,
          '--env', `HUD_TAB_LAUNCH=${directIdentity.launchId}`,
          '--no-focus',
        ]);
        if (split.exit_code !== 0) return rollback(split);
        const splitPane = JSON.parse(split.stdout).result?.pane;
        right = splitPane?.pane_id;
        if (!herdrId(right)) throw new Error('split did not return a pane id');
        if (herdrId(splitPane?.terminal_id)) rightTerminalId = splitPane.terminal_id;
        recordDirect();
        await recordTabShells(dir, directIdentity.launchId, directIdentity.tabId, [right]);
      }
      started = await waitDirectReady({
        name,
        paneId: left,
        launchId: directIdentity.launchId,
        terminalId: directIdentity.terminalId,
        kind: 'pi',
        pid: directIdentity.pid,
        pidStart: directIdentity.pidStart,
        timeoutMs: 30_000,
      });
    } else {
      fs.mkdirSync(join(dir, jobFiles.qa), { recursive: true, mode: 0o700 });
      const base = job.worktree?.base_head ?? await dispatchBase(job.cwd);
      const tabName = tabLabel(job, task);
      const tabArgv = [
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
        // A killed `git status` (a worker's tool timeout) would leave a stale index.lock that blocks every later commit.
        '--env',
        'GIT_OPTIONAL_LOCKS=0',
        ...(resume ? ['--env', `HUD_RESUME_SESSION_ID=${resume.id}`] : []),
      ];
      for (let tabAttempt = 0; tabAttempt < 2; tabAttempt++) {
        const launch = randomUUID(), endpoint = herdrEndpoint();
        const result = await run('herdr', [...tabArgv, '--env', `HUD_TAB_LAUNCH=${launch}`, '--no-focus']);
        if (result.exit_code !== 0) return rollback(result);
        const { tab, root_pane } = JSON.parse(result.stdout).result;
        if (herdrId(tab?.tab_id)) openedTab = tab.tab_id;
        left = root_pane?.pane_id;
        if (!openedTab || !herdrId(left)) throw new Error('tab create did not return tab/root pane ids');
        let right = '';
        const record = () => writeSessionReceipt(dir, {
          TASK: job.job, LAUNCH: launch, HERDR_SOCKET_PATH: endpoint ?? '',
          TAB: tab.tab_id,
          TAB_NAME: tabName,
          LEFT: left,
          RIGHT: right,
          ORCH: owner,
          BASE: base,
          PRIMARY: name,
        });
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
            '--env', `HUD_JOB_DIR=${dir}`, '--env', `HUD_TAB_LAUNCH=${launch}`,
            '--no-focus',
          ]);
          if (split.exit_code !== 0) return rollback(split);
          right = JSON.parse(split.stdout).result.pane.pane_id;
          if (!herdrId(right)) throw new Error('split did not return a pane id');
          record();
        }
        await recordTabShells(dir, launch, openedTab, right ? [left, right] : [left]);
        started = await run('herdr', ['agent', 'start', name, '--kind', 'pi', '--pane', left, '--', ...piArgs]);
        if (!await retryBusyPane(started, tabAttempt, openedTab)) break;
        openedTab = undefined;
      }
    }
    if (started.exit_code !== 0) {
      return rollback(await startupFailure(started, left));
    }
    if (isFork) jobCache.invalidateFile(join(dir, jobFiles.status));
    if (resume) {
      const native = readCachedStatus(job.job).status;
      if (native?.session_id !== resume.id || native.session_file !== resume.file)
        return rollback(launchError('pi did not open the recorded session'));
    }
    job.pi_sent_at = new Date().toISOString();
    save(job);
    const boundary = promptBoundary(dir, resume?.file ?? readCachedStatus(job.job).status?.session_file);
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
    const status = readCachedStatus(job.job).status;
    const completed = status?.task_dir === dir && status.slot === 'primary' && status.state === 'closed' && status.output_written;
    if (submitted.exit_code !== 0 && !completed) {
      if (refusedBeforeInput(submitted)) return rollback(submitted);
      if (!promptStalled(submitted)) return submitted;
      await recoverStalledPrompt(dir, name, left, prompt, boundary);
      return { exit_code: 0, stdout: '', stderr: '' };
    }
    return { ...submitted, exit_code: 0 };
  } catch (error) {
    const result = launchError(String(error));
    return mayHaveInput ? result : rollback(result);
  }
}
