/** Pi launch and native session setup. */
import { recordTabShells } from '../../runtime/tab-shell.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { sonicArgv } from './pi-worker-argv.js';
import { isAbsolute, join, dirname } from 'node:path';
import { jobCallerPane } from '../../roles/job-pane.js';
import { herdrId } from '../../roles/herdr-run.js';
import { executable, type Role, type RolePlace } from '../../roles/roster.js';
import { writePrivateFile } from '../../utils/atomic-fs.js';
import { briefPrompt } from '../brief-prompt.js';
import type { Job, SessionReceipt } from '../job-contracts.js';
import { jobFiles } from '../paths.js';
import { piMcpConfigEmpty } from '../pi-mcp-config.js';
import { sonicLimits } from '../sonic-policy.js';
import { startHeadlessProcess } from '../sonic-process.js';
import { prepareSonicRetry } from '../sonic-session.js';
import { directory, findJob, readCachedStatus, hudHome, bundled, save, jobCache } from '../store/job-store.js';
import type { NativeResume } from '../worker-resume.js';
import { promptBoundary, recoverStalledPrompt } from './prompt-stall.js';
import { registry, roleCwd } from './places.js';
import {
  rejectLaunch, binScript, quote, run, dispatchBase, tabLabel, workspaceArgs, retryBusyPane,
  startupFailure, launchError, refusedBeforeInput, promptStalled, type DispatchResult,
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
  let openedTab: string | undefined;
  let mayHaveInput = false;
  const reject = (result: DispatchResult) => rejectLaunch(result, openedTab);
  try {
    const resources = piSkillArgs(job, role, place);
    if (job.headless && !executable('pi')) throw new Error('pi not found on PATH');
    const dir = directory(job.job),
      output = join(dir, jobFiles.report);
    const sessionWorker = job.headless && job.role !== 'sonic';
    const sessionFile = sessionWorker ? resume?.file ?? join(dir, 'sessions', `${job.job}.jsonl`) : undefined;
    let continuation = resume?.message;
    if (job.role === 'sonic' && job.retry_of) {
      const source = findJob(job.retry_of);
      if (source?.role === 'sonic') continuation = prepareSonicRetry(dir, job.cwd, source, directory(source.job), readCachedStatus(source.job).status);
    }
    const prompt = continuation ?? briefPrompt(join(dir, jobFiles.brief));
    const borrowed = job.borrowed_instructions;
    const piRole = borrowed?.pi_role ?? place.pi_role ?? role.instructions;
    if (!piRole) throw new Error('missing pi_role');
    if (job.headless && job.role === 'sonic') {
      const args = sonicArgv(hudHome, dir, job, role, piRole, resources, prompt);
      startHeadlessProcess(dir, job, args, undefined, sonicLimits(role));
      return { exit_code: 0, stdout: '', stderr: '' };
    }
    const launcher = executable('pi-role');
    if (!launcher) throw new Error('pi-role not found on PATH');
    const argv = ['--args-json', piRole];
    if (!job.headless) argv.push('--task-dir', dir, '--role-output', output, '--dispatch-slot', 'primary', '--dispatch-label', job.role);
    argv.push('--allow-write', output);
    if (!job.headless || sessionWorker) argv.push('--qa-dir', join(dir, jobFiles.qa));
    if (sessionWorker) argv.push('--qa-timeout', '0');
    const owner = jobCallerPane(job);
    if ((!job.headless || sessionWorker) && owner) {
      const notify = binScript('hud-notify.mjs');
      argv.push('--notify', [process.execPath, notify, hudHome, owner, job.job].map(quote).join(' '));
    }
    const instructionsName = borrowed?.name ?? role.instructions ?? role.role;
    if (plainSkillName(instructionsName)) {
      const instructions = join(bundled, 'instructions', `${instructionsName}.md`);
      if (fs.existsSync(instructions)) argv.push('--hud-instructions', instructions);
    }
    argv.push('--hud-sonic-jobs', join(bundled, 'bin', 'sonic-jobs.mjs'));
    if (place.thinking !== undefined) argv.push('--dispatch-effort-source', 'orchestrator');
    for (const key of ['lens', 'mcp', 'tps'] as const)
      if (job[key] !== undefined) argv.push(`--${job[key] ? '' : 'no-'}${key}`);
    if (job.mcp === undefined && piMcpConfigEmpty(job.cwd, job.pi_args)) argv.push('--no-mcp');
    if (job.headless || job.ui_ext === false) argv.push('--no-ui-ext');
    if (job.skills === true) argv.push('--skills');
    argv.push('--', ...(job.headless ? [] : ['--tui-mode', 'regular']), '--hud-worker-tools', '-e',
      join(bundled, '../../integrations/pi/package/extensions/hud.mjs'));
    for (const key of ['model', 'thinking'] as const) {
      const value = place[key] ?? (borrowed ? job[key] : undefined);
      if (value != null) argv.push(`--${key}`, value);
      // Pi leaves its native default alone for an empty flag; pi-roles sees the flag
      // and does not apply the borrowed role's frontmatter default instead.
      else if (borrowed) argv.push(`--${key}=`);
    }
    argv.push(...resources, ...(job.pi_args ?? []));
    // Pi expands even a positional @path into file contents. A follow-up is literal text, not a file grant.
    if (sessionFile) argv.push('--session', sessionFile, '--print', '--mode', 'json', '--', prompt.startsWith('@') ? ` ${prompt}` : prompt);
    else if (resume?.file) argv.push('--session', resume.file);
    const built = await run(launcher, argv, job.cwd, job.headless ? { ...process.env, HERDR_ENV: undefined } : undefined);
    if (built.exit_code !== 0) return reject(built);
    const piArgs: string[] = JSON.parse(built.stdout);
    if (job.headless) {
      if (sessionFile) {
        if (!resume) {
          fs.mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
          writePrivateFile(sessionFile, '', { exclusive: true, mkdir: false });
        }
        job.pi_sent_at = new Date().toISOString();
        save(job);
      }
      try {
        startHeadlessProcess(dir, job, piArgs, sessionFile ? { file: sessionFile, id: resume?.id } : undefined);
      } catch (error) {
        // A rejected handshake never starts pi. Allow another place in this route to launch a fresh session.
        if (sessionFile && !resume) fs.rmSync(sessionFile, { force: true });
        throw error;
      }
      return { exit_code: 0, stdout: '', stderr: '' };
    }
    fs.mkdirSync(join(dir, jobFiles.qa), { recursive: true });
    const base = job.worktree?.base_head ?? await dispatchBase(job.cwd);
    const tabName = tabLabel(job, task),
      name = `${job.job}-primary`;
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
    ];
    let left = '';
    let started: Awaited<ReturnType<typeof run>> = { exit_code: 1, stdout: '', stderr: 'tab create not attempted', notStarted: false };
    for (let tabAttempt = 0; tabAttempt < 2; tabAttempt++) {
      const launch = randomUUID();
      const result = await run('herdr', [...tabArgv, '--env', `HUD_TAB_LAUNCH=${launch}`, '--no-focus']);
      if (result.exit_code !== 0) return reject(result);
      const { tab, root_pane } = JSON.parse(result.stdout).result;
      if (herdrId(tab?.tab_id)) openedTab = tab.tab_id;
      left = root_pane?.pane_id;
      if (!openedTab || !herdrId(left)) throw new Error('tab create did not return tab/root pane ids');
      let right = '';
      const record = () => {
        const fields: SessionReceipt = {
          TASK: job.job, LAUNCH: launch,
          TAB: tab.tab_id,
          TAB_NAME: tabName,
          LEFT: left,
          RIGHT: right,
          ORCH: owner,
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
          '--env', `HUD_JOB_DIR=${dir}`, '--env', `HUD_TAB_LAUNCH=${launch}`,
          '--no-focus',
        ]);
        if (split.exit_code !== 0) return reject(split);
        right = JSON.parse(split.stdout).result.pane.pane_id;
        if (!herdrId(right)) throw new Error('split did not return a pane id');
        record();
      }
      await recordTabShells(dir, launch, openedTab, right ? [left, right] : [left]);
      started = await run('herdr', ['agent', 'start', name, '--kind', 'pi', '--pane', left, '--', ...piArgs]);
      if (!await retryBusyPane(started, tabAttempt, openedTab)) break;
      openedTab = undefined;
    }
    if (started.exit_code !== 0) return reject(await startupFailure(started, left));
    if (resume) {
      const native = readCachedStatus(job.job).status;
      if (native?.session_id !== resume.id || native.session_file !== resume.file)
        return reject(launchError('pi did not open the recorded session'));
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
      if (refusedBeforeInput(submitted)) return reject(submitted);
      if (!promptStalled(submitted)) return submitted;
      await recoverStalledPrompt(dir, name, left, prompt, boundary);
      return { exit_code: 0, stdout: '', stderr: '' };
    }
    return { ...submitted, exit_code: 0 };
  } catch (error) {
    const result = launchError(String(error));
    return mayHaveInput ? result : reject(result);
  }
}
