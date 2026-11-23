/** Runs in its own process so rebuilding HUD or restarting a watcher cannot replay the landing. */
import { spawn } from 'node:child_process';
import type { Job, JobStatus } from './job-contracts.js';
import { jobFiles } from './paths.js';
import { readJsonFile, writePrivateFile } from '../utils/atomic-fs.js';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { parseWorktreeList, worktreeGit as git } from '../collectors/worktrees.js';
import { takeLease } from '../roles/lease.js';
import { neutralizeFilters, safeGitEnv, SAFE_GIT_ARGS } from '../utils/git-safety.js';
import { DEFAULT_LAND_TIMEOUT_S, isFlowId, landFile, readLand, writeLand, type LandFlow, type LandRerun } from './land-state.js';
import { reapWorktree } from './managed-worktree.js';
import { recordLanding } from './land-records.js';
import { publishRunnerLifetime } from '../utils/runner-lifetime.js';
import { repairLand } from './land-repair.js';
import { canPublishTestedBuild, isMainBuildCommand } from './land-build.js';
import { LandOutput } from './land-evidence.js';

class CommandError extends Error {
  constructor(message: string, readonly evidence: ReturnType<LandOutput['evidence']>) { super(message); }
  get tail() { return this.evidence.tail; }
}
class CommandTimeout extends CommandError {}
const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
function command(cwd: string, bin: string, argv: string[], deadlineMs?: number, env = process.env) {
  return new Promise<string[]>((ok, fail) => {
    const child = spawn(bin, argv, { cwd, env: safeGitEnv(env), detached: deadlineMs !== undefined, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = new LandOutput(cwd);
    const streams = [child.stdout, child.stderr].map(input => {
      const stream = output.stream();
      createInterface({ input }).on('line', stream.line).on('close', stream.finish);
      return stream;
    });
    const evidence = () => {
      for (const stream of streams) stream.finish();
      return output.evidence();
    };
    const timer = deadlineMs === undefined ? undefined : setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') streams[1].line((e as Error).message); }
      // Don't wait for inherited stdio to close. A child can outlive the shell that opened it.
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      fail(new CommandTimeout('timeout', evidence()));
    }, deadlineMs);
    child.once('error', (e) => { clearTimeout(timer); fail(e); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) ok(output.tail());
      else fail(new CommandError(`exit ${code ?? signal}`, evidence()));
    });
  });
}
const fields = (out: string) => out.split('\0').filter(Boolean);
function pathsOverlap(a: string[], b: string[]) {
  const exact = new Set(a), dirs = new Set<string>();
  for (const p of a)
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) dirs.add(p.slice(0, i));
  for (const p of b) {
    if (exact.has(p) || dirs.has(p)) return true;
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) if (exact.has(p.slice(0, i))) return true;
  }
  return false;
}
async function execute(home: string, f: LandFlow, cleanup: string[]) {
  const { wt, config: c } = f, main = wt.main_root;
  const scratch = (id: string) => join(dirname(wt.root), `land-${id}`);
  const integration = scratch(f.flow);
  const ref = `refs/heads/${c.base}`, lease = { home, cwd: main, holder: f.flow };
  const cancelled = () => fs.existsSync(`${landFile(home, f.flow)}.cancel`);
  const step = (name: string) => { f.step = name; writeLand(home, f); };
  const recordTiming = (name: string, t0: number, ok: boolean, extra?: { rerun?: true; skipped?: true }) => {
    (f.timings ??= []).push({ step: name, ms: Math.max(0, Math.round(performance.now() - t0)), ok, ...extra });
    writeLand(home, f);
  };
  let activeStep: [string, number] | undefined;
  const startStep = (name: string) => { step(name); activeStep = [name, performance.now()]; };
  const endStep = (ok = true) => {
    if (!activeStep) return;
    const [name, t0] = activeStep; activeStep = undefined;
    recordTiming(name, t0, ok);
  };
  const checkCancel = () => { if (cancelled()) { f.state = 'cancelled'; throw Error('Cancelled before fast-forward'); } };
  const head = async (dir: string) => (await git(dir, ['rev-parse', '--verify', 'HEAD'])).trim();
  const checkMain = async (sha: string) => {
    if ((await git(main, ['symbolic-ref', 'HEAD'])).trim() !== ref || await head(main) !== sha)
      throw Error('Main checkout is not at the recorded base tip');
  };
  const checkSource = async () => {
    for (const id of new Set([f.job, f.repairs?.at(-1)?.job ?? f.job])) {
      const status = readJsonFile(join(home, 'jobs', id, jobFiles.status)) as JobStatus;
      if (!['closed', 'idle_grace', 'done'].includes(status.state)) throw Error(`Cannot land ${id}: job state is ${status.state ?? 'unknown'}`);
    }
    if (await head(wt.root) !== f.source_sha ||
        (await git(wt.root, ['symbolic-ref', 'HEAD'])).trim() !== `refs/heads/${wt.branch}`)
      throw Error('Source job is no longer settled at the recorded commit');
  };
  const deadlineMs = (c.timeout_s ?? DEFAULT_LAND_TIMEOUT_S) * 1000;
  async function commands(kind: 'gate' | 'after', cwd: string, reuse?: { tested: string; filters: string[] }) {
    for (const [i, cmd] of c[kind].entries()) {
      if (kind === 'gate') checkCancel();
      const label = `${kind}[${i + 1}]: ${cmd}`;
      step(label);
      const build = isMainBuildCommand(cmd);
      const publish = kind === 'after' && reuse && build &&
        await canPublishTestedBuild({ main, integration, testedSha: reuse.tested, mainHeadSha: await head(main), gateCommands: c.gate, cmd, filters: reuse.filters });
      const script = publish
        ? [process.execPath, join(main, 'scripts/build.mjs'), '--publish-from', join(integration, 'dist')].map(quote).join(' ')
        : cmd;
      // The wrapper can isolate HOME without hiding the caller's installed Rust toolchain and offline registry.
      const env = build ? {
        ...process.env,
        RUSTUP_HOME: process.env.RUSTUP_HOME || join(homedir(), '.rustup'),
        CARGO_HOME: process.env.CARGO_HOME || join(homedir(), '.cargo'),
        HUD_NATIVE_REUSE_DIR: join(kind === 'gate' ? main : integration, 'dist/native'),
      } : process.env;
      const invoke = (script: string) => c.wrapper
        ? command(cwd, resolve(main, c.wrapper), ['sh', '-c', script], deadlineMs, env)
        : command(cwd, 'sh', ['-c', script], deadlineMs, env);
      const t0 = performance.now();
      try {
        const output = await invoke(script);
        if (kind === 'after' && build) {
          const prefix = 'HUD build: ';
          f.after_note = output.find(line => line.startsWith(`${prefix}Cargo unavailable; `))?.slice(prefix.length);
        }
        recordTiming(label, t0, true, publish ? { skipped: true } : undefined);
      } catch (e) {
        if (kind !== 'gate' || !(e instanceof CommandError)) { recordTiming(label, t0, false); throw e; }
        const reruns = f.reruns ??= [];
        const prefix = `${landFile(home, f.flow)}.gate-${reruns.length + 1}`;
        const saveExcerpt = (error: CommandError, suffix = '') => {
          const path = `${prefix}${suffix}.log`;
          writePrivateFile(path, error.evidence.excerpt, { mkdir: false });
          return path;
        };
        const { tests, files } = e.evidence;
        const entry: LandRerun = { step: label, tests, output_path: saveExcerpt(e) };
        reruns.push(entry);
        recordTiming(label, t0, false);
        // A command deadline can leave tests unrun; a red test (including a node:test timeout) identifies a safe rerun.
        if (e instanceof CommandTimeout) throw e;
        checkCancel();
        const r0 = performance.now();
        try {
          await invoke(files.length ? [process.execPath, '--test', '--test-timeout=60000', '--test-force-exit', '--', ...files].map(quote).join(' ') : cmd);
        } catch (re) {
          entry.rerun_ok = false;
          if (re instanceof CommandError) entry.rerun_output_path = saveExcerpt(re, '-rerun');
          recordTiming(label, r0, false, { rerun: true });
          throw re;
        }
        entry.rerun_ok = true;
        recordTiming(label, r0, true, { rerun: true });
      }
    }
  }
  let acquired = false;
  const acquire = async () => {
    while (!acquired) {
      checkCancel();
      const r = await takeLease({ name: 'main-checkout', wait_s: 1 }, lease);
      if (!('granted' in r)) continue;
      acquired = r.granted;
      if (!r.granted) {
        const { holder } = r.held_by;
        const blocker = isFlowId(holder) ? readLand(home, holder) : null;
        const gate = blocker && /^gate\[(\d+)\]:/.exec(blocker.step);
        const since = blocker ? Date.parse(blocker.updated_at) : NaN;
        const waiting = !blocker ? 'main-checkout lease' : gate && Number.isFinite(since)
          ? `waiting for ${holder} (gate step ${gate[1]}, ${Math.max(0, Math.floor((Date.now() - since) / 60000))} min)`
          : `waiting for ${holder}`;
        if (f.step !== waiting) step(waiting);
      }
    }
  };
  async function prepare() {
    f.state = 'running'; step('prepare');
    await checkSource();
    if (cleanup.length) {
      const trees = parseWorktreeList(await git(main, ['worktree', 'list', '--porcelain', '-z']));
      for (const id of cleanup) {
        const old = trees.find(t => t.path === scratch(id));
        if (!old) continue;
        if (!old.detached || old.locked !== undefined) throw Error('Previous integration worktree is not disposable');
        await git(main, ['worktree', 'remove', '--force', '--', old.path], 120000);
      }
      cleanup.length = 0;
    }
    f.base_sha = (await git(main, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    await checkMain(f.base_sha);
    const ff = (await git(main, ['merge-base', f.base_sha, f.source_sha])).trim() === f.base_sha;
    const picks = (await git(main, ['rev-list', '--reverse', '--topo-order', `${f.base_sha}..${f.source_sha}`, '--'])).trim();
    if (!picks) throw Error('Source has no commits to land');
    if (fs.lstatSync(integration, { throwIfNoEntry: false })) throw Error('Integration destination already exists');
    startStep('create integration');
    await git(main, ['worktree', 'add', '--detach', '--', integration, ff ? f.source_sha : f.base_sha], 120000);
    endStep();
    // includeIf and a wrapper's temporary HOME can give the detached checkout a different identity.
    const identity = (await git(main, ['var', 'GIT_COMMITTER_IDENT'])).match(/^(.*) <([^<>]+)> \d+ [+-]\d+$/m);
    if (!identity) throw Error('Missing checkout committer identity');
    const who = ['-c', `user.name=${identity[1]}`, '-c', `user.email=${identity[2]}`];
    if (!ff) {
      startStep('cherry-pick');
      for (const sha of picks.split(/\s+/)) await command(integration, 'git', [...SAFE_GIT_ARGS, ...who, 'cherry-pick', '--no-gpg-sign', sha]);
      endStep();
    }
    f.tested_sha = await head(integration);
    await commands('gate', integration);
    if (await head(integration) !== f.tested_sha) throw Error('Gate changed integration HEAD');
    return who;
  }
  try {
    let who: string[];
    for (;;) {
      await acquire();
      try { who = await prepare(); break; }
      catch (e) {
        endStep(false);
        const conflict = f.step === 'cherry-pick' && !!(await git(integration, ['ls-files', '-u']));
        if (!(e instanceof CommandError) || (!conflict && !f.step.startsWith('gate['))) throw e;
        const prior = f.repairs?.at(-1);
        if (prior) prior.outcome = `failed at ${f.step}`;
        if (e instanceof CommandTimeout || (f.repairs?.length ?? 0) >= 2) throw e;
        checkCancel(); await checkSource();
        f.error = e.message; f.tail = e.tail;
        // Only the helper-created scratch checkout is disposable, never the source or main.
        await git(main, ['worktree', 'remove', '--force', '--', integration], 120000);
        await takeLease({ name: 'main-checkout', release: true }, lease); acquired = false;
        await repairLand(home, f, checkCancel);
        f.source_sha = await head(wt.root);
        delete f.error; delete f.tail; delete f.tested_sha;
        f.state = 'queued'; step('main-checkout lease');
      }
    }
    const prior = f.repairs?.at(-1);
    if (prior) prior.outcome = 'gate passed';
    checkCancel(); await checkSource();
    startStep('records');
    const tested = f.tested_sha!, base = f.base_sha!;
    let landed = (await recordLanding(integration, join(home, 'jobs', f.job), base, c.gate.length, who)) ?? tested;
    endStep();
    checkCancel(); startStep('fast-forward');
    const touched = async (from: string, to: string) => [...new Set([
      ...fields(await git(main, ['diff', '--name-only', '--no-renames', '-z', from, to, '--'])),
      ...fields(await git(main, ['log', '--format=', '--name-only', '--no-renames', '-m', '--first-parent', '-z', `${from}..${to}`, '--'])),
    ])];
    const filters = await neutralizeFilters(git, main);
    const checkClean = async (paths: string[]) => {
      for (let i = 0; i < paths.length; i += 128) {
        const batch = paths.slice(i, i + 128);
        const status = await git(main, [...filters, 'status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all', '--', ...batch]);
        const hidden = fields(await git(main, ['ls-files', '-v', '-z', '--', ...batch])).some(row => /^[a-zS] /.test(row));
        if (status || hidden) throw Error('Main checkout has dirty or hidden changes on paths the landing touches');
      }
    };
    const paths = await touched(base, landed);
    await checkClean(paths);
    checkCancel(); await checkSource();
    if ((await git(main, ['symbolic-ref', 'HEAD'])).trim() !== ref)
      throw Error('Main checkout is not at the recorded base tip');
    let target = base;
    const current = await head(main);
    if (current !== base) {
      let ancestor = false;
      try { ancestor = (await git(main, ['merge-base', base, current])).trim() === base; } catch { /* not an ancestor */ }
      if (!ancestor) throw Error('Main checkout is not at the recorded base tip');
      const mainPaths = await touched(base, current);
      if (pathsOverlap(paths, mainPaths)) throw Error('Main checkout is not at the recorded base tip');
      checkCancel();
      const picks = (await git(main, ['rev-list', '--reverse', '--topo-order', `${base}..${tested}`, '--'])).trim().split(/\s+/).filter(Boolean);
      if (!picks.length) throw Error('Main checkout is not at the recorded base tip');
      await git(main, ['worktree', 'remove', '--force', '--', integration], 120000);
      await git(main, ['worktree', 'add', '--detach', '--', integration, current], 120000);
      try {
        for (const sha of picks) {
          checkCancel();
          await command(integration, 'git', [...SAFE_GIT_ARGS, ...filters, ...who, 'cherry-pick', '--no-gpg-sign', sha]);
        }
        const replayed = await head(integration);
        landed = (await recordLanding(integration, join(home, 'jobs', f.job), current, c.gate.length, who)) ?? replayed;
        if (landed !== replayed && pathsOverlap(await touched(replayed, landed), mainPaths))
          throw Error('Main checkout is not at the recorded base tip');
      } catch (e) {
        if (f.state === 'cancelled') throw e;
        if (e instanceof CommandError) throw new CommandError('Main checkout is not at the recorded base tip', e.evidence);
        throw e;
      }
      target = current;
      await checkClean(await touched(current, landed));
      checkCancel(); await checkSource(); await checkMain(target);
    } else {
      await checkMain(base);
    }
    await git(main, ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--no-edit', landed], 120000);
    if (target !== base) f.replayed_onto = target;
    f.landed_sha = landed; endStep();
    const landingHead = async () => {
      const moved = Error('Main checkout is not at the recorded base tip');
      if ((await git(main, ['symbolic-ref', 'HEAD'])).trim() !== ref) throw moved;
      const current = await head(main);
      if (current !== landed) {
        try { await git(main, ['merge-base', '--is-ancestor', landed, current]); }
        catch { throw moved; }
      }
      return current;
    };
    await landingHead();
    await commands('after', main, target === base ? { tested, filters } : undefined);
    if (c.push) {
      startStep('push');
      await checkClean(target === base ? paths : await touched(target, landed));
      const pushHead = await landingHead();
      // Push the verified HEAD by SHA so a later branch switch cannot change what is published.
      await command(main, 'git', ['-c', 'core.hooksPath=/dev/null', '-c', 'remote.origin.mirror=false', 'push',
        '--no-follow-tags', '--recurse-submodules=no', 'origin', `${pushHead}:${ref}`]);
      endStep();
    }
    startStep('cleanup');
    const notes: string[] = [];
    const note = (e: unknown) => {
      const line = (e instanceof Error ? e.message : String(e)).split('\n')[0].trim();
      if (line) notes.push(line);
    };
    try { await git(main, ['worktree', 'remove', '--', integration], 120000); }
    catch (e) { note(e); }
    try {
      const receiptPath = join(home, 'jobs', f.job, jobFiles.job);
      const result = await reapWorktree(f.job, { job: f.job, cwd: wt.root, worktree: wt }, home,
        { source_sha: f.source_sha, landed_sha: landed });
      const receipt = readJsonFile(receiptPath) as Job;
      writePrivateFile(receiptPath, JSON.stringify({ ...receipt, worktree_kept_reason: undefined, worktree_checked_head: undefined, ...result }), { mkdir: false });
      if ('worktree_kept_reason' in result) notes.push(result.worktree_kept_reason);
    } catch (e) { note(e); }
    if (notes.length) f.cleanup_note = notes.join('; ');
    endStep();
    f.state = 'completed'; step('done');
  } catch (e) {
    endStep(false);
    if (f.state !== 'cancelled') f.state = 'failed';
    f.error = (e as Error).message.split('\n')[0];
    f.tail = e instanceof CommandError ? e.tail : f.tail ?? (e as Error).message.trimEnd().split('\n').slice(-40);
    writeLand(home, f);
  } finally { if (acquired) await takeLease({ name: 'main-checkout', release: true }, lease); }
}
// The bootstrap reports ready only after this listener and the complete import graph are loaded.
process.once('message', async ({ home, flow, cleanup }: { home: string; flow: string; cleanup: string[] }) => {
  const f = readLand(home, flow);
  if (f?.state === 'queued' && f.pid === process.pid) {
    await publishRunnerLifetime(join(home, 'jobs', f.job));
    await execute(home, f, cleanup);
  }
});
