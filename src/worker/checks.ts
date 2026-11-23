/** The registered project's pre-report gate. Run in the worker checkout, never in the main checkout. */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { worktreeGit } from '../collectors/worktrees.js';
import type { ManagedWorktree } from '../mcp/job-contracts.js';
import { monitorText } from '../render/monitor-text.js';
import { registeredProject } from '../roles/projects.js';
import { readJsonBounded } from '../utils/atomic-fs.js';
import { safeGitEnv } from '../utils/git-safety.js';

const TIMEOUT_MS = 60_000;
const TAIL_BYTES = 2048;
const readOnlyRoles = new Set(['architect', 'oracle', 'reviewer', 'sonic']);

function run(command: string, cwd: string, wrapper: string | undefined, timeout: number): Promise<void> {
  return new Promise((ok, fail) => {
    const { HUD_JOB_DIR: _workerJob, ...env } = process.env;
    const child = spawn(wrapper ?? 'sh', [...(wrapper ? ['sh'] : []), '-c', command],
      { cwd, env: safeGitEnv(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = Buffer.alloc(0);
    const append = (chunk: Buffer) => { tail = Buffer.concat([tail, chunk.subarray(-TAIL_BYTES)]).subarray(-TAIL_BYTES); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') append(Buffer.from(String(error))); }
    };
    const refuse = (why: string) => {
      const output = tail.toString('utf8').trim().split(/\r?\n/u).map(monitorText).join('\n');
      const label = monitorText(command.slice(0, 200));
      fail(new Error(`Worker check ${why}: ${label}. Fix it, commit any changes, and report again, or provide skip_checks_reason if blocked.${output ? `\nOutput tail:\n${output}` : ''}`));
    };
    const timer = setTimeout(() => {
      killGroup();
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      refuse('timed out (60 s total limit)');
    }, timeout);
    child.once('exit', killGroup); // Don't let background children keep the pipes open.
    child.once('error', error => append(Buffer.from(error.message)));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) ok();
      else refuse(code === null && !signal ? 'could not start' : `failed (exit ${signal ?? code})`);
    });
  });
}

export async function runWorkerChecks(home: string, role: string, { root, main_root, base_head }: ManagedWorktree) {
  if (readOnlyRoles.has(role) || !registeredProject(home, main_root).registered) return;
  let config: { worker_checks?: Record<string, unknown>; land?: { wrapper?: unknown } } | null;
  try { config = readJsonBounded(join(main_root, '.hud', 'project.json'), 256 * 1024) as typeof config; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Could not read worker_checks from .hud/project.json; provide skip_checks_reason if blocked.', { cause: error });
  }
  if (!config?.worker_checks || !Object.hasOwn(config.worker_checks, role)) return;
  const commands = config.worker_checks[role];
  if (!(await worktreeGit(root, ['rev-list', '--max-count=1', '--end-of-options', `${base_head}..HEAD`, '--'])).trim()) return;
  if (!Array.isArray(commands) || commands.some(cmd => typeof cmd !== 'string' || !cmd.trim() || cmd.includes('\0')))
    throw new Error('Invalid project worker_checks: expected a list of shell commands; provide skip_checks_reason if blocked.');
  const wrapper = config.land?.wrapper;
  const runner = typeof wrapper === 'string' && wrapper ? resolve(main_root, wrapper) : undefined;
  const deadline = performance.now() + TIMEOUT_MS;
  for (const command of commands) {
    const remaining = deadline - performance.now();
    if (remaining < 1) throw new Error('Worker checks timed out (60 s total limit). Provide skip_checks_reason if blocked.');
    await run(command, root, runner, remaining);
  }
}
