/** Runs in its own process so rebuilding HUD or restarting a watcher cannot replay the landing. */
import { spawn } from 'node:child_process';
import type { Job, JobStatus } from './job-contracts.js';
import { jobFiles } from './paths.js';
import { readJsonFile, writePrivateFile } from '../utils/atomic-fs.js';
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { parseWorktreeList, worktreeGit as git } from '../collectors/worktrees.js';
import { takeLease } from '../roles/lease.js';
import { neutralizeFilters, safeGitEnv, SAFE_GIT_ARGS } from '../utils/git-safety.js';
import { DEFAULT_LAND_TIMEOUT_S, isFlowId, landFile, readLand, writeLand, type LandFlow } from './land-state.js';
import { reapWorktree } from './managed-worktree.js';
import { recordLanding } from './land-records.js';
import { publishRunnerLifetime } from '../utils/runner-lifetime.js';
import { repairLand } from './land-repair.js';

class CommandError extends Error {
  constructor(message: string, readonly tail: string[]) { super(message); }
}
class CommandTimeout extends CommandError {}
type TestFailure = { file: string; name?: string };
function collectTestFailures(cwd: string, stream: Readable, failures: TestFailure[]) {
  let previous: TestFailure | undefined;
  createInterface({ input: stream }).on('line', (raw) => {
    const line = stripVTControlCharacters(raw);
    if (previous) {
      previous.name = /^\s*✖ (.+?)(?: \([\d.]+ms\))?\s*$/.exec(line)?.[1];
      previous = undefined;
    }
    const location = /^test at (.+?):\d+(?::\d+)?\s*$/.exec(line)?.[1];
    if (!location) return;
    let path: string;
    try { path = location.startsWith('file://') ? fileURLToPath(location) : resolve(cwd, location); }
    catch { return; }
    const file = relative(cwd, path);
    if (!file || file === '..' || file.startsWith(`..${sep}`) || isAbsolute(file)) return;
    failures.push(previous = { file });
  });
}
const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
function command(cwd: string, bin: string, argv: string[], deadlineMs?: number, failures?: TestFailure[]) {
  return new Promise<void>((ok, fail) => {
    const child = spawn(bin, argv, { cwd, env: safeGitEnv(process.env), detached: deadlineMs !== undefined, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: string) => { output = (output + chunk).slice(-65536); };
    const tail = () => output.trimEnd().split(/\r?\n/).slice(-40);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8').on('data', append);
      if (failures) collectTestFailures(cwd, stream, failures);
    }
    const timer = deadlineMs === undefined ? undefined : setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') append(`\n${(e as Error).message}\n`); }
      // Don't wait for inherited stdio to close. A child can outlive the shell that opened it.
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      fail(new CommandTimeout('timeout', tail()));
    }, deadlineMs);
    child.once('error', (e) => { clearTimeout(timer); fail(e); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) ok();
      else fail(new CommandError(`exit ${code ?? signal}`, tail()));
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
  async function commands(kind: 'gate' | 'after', cwd: string) {
    for (const [i, cmd] of c[kind].entries()) {
      if (kind === 'gate') checkCancel();
      step(`${kind}[${i + 1}]: ${cmd}`);
      const invoke = (script: string, failures?: TestFailure[]) => c.wrapper
        ? command(cwd, resolve(main, c.wrapper), ['sh', '-c', script], deadlineMs, failures)
        : command(cwd, 'sh', ['-c', script], deadlineMs, failures);
      const failures = kind === 'gate' ? [] as TestFailure[] : undefined;
      try { await invoke(cmd, failures); }
      catch (e) {
        // A command deadline can leave tests unrun; a red test (including a node:test timeout) identifies a safe rerun.
        if (!failures || !(e instanceof CommandError) || e instanceof CommandTimeout) throw e;
        checkCancel();
        const files = [...new Set(failures.map(({ file }) => file))];
        await invoke(files.length ? [process.execPath, '--test', '--test-timeout=60000', '--test-force-exit', '--', ...files].map(quote).join(' ') : cmd);
        const tests = [...new Set(failures.map(({ file, name }) => name ? `${name} (${file})` : file))];
        (f.reruns ??= []).push(tests.length ? { step: f.step, tests } : f.step);
        writeLand(home, f);
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
    step('create integration');
    await git(main, ['worktree', 'add', '--detach', '--', integration, ff ? f.source_sha : f.base_sha], 120000);
    // includeIf and a wrapper's temporary HOME can give the detached checkout a different identity.
    const identity = (await git(main, ['var', 'GIT_COMMITTER_IDENT'])).match(/^(.*) <([^<>]+)> \d+ [+-]\d+$/m);
    if (!identity) throw Error('Missing checkout committer identity');
    const who = ['-c', `user.name=${identity[1]}`, '-c', `user.email=${identity[2]}`];
    if (!ff) {
      step('cherry-pick');
      for (const sha of picks.split(/\s+/)) await command(integration, 'git', [...SAFE_GIT_ARGS, ...who, 'cherry-pick', '--no-gpg-sign', sha]);
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
    step('records');
    const tested = f.tested_sha!, base = f.base_sha!;
    let landed = (await recordLanding(integration, join(home, 'jobs', f.job), tested, c.gate.length, who)) ?? tested;
    checkCancel(); step('fast-forward');
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
        landed = (await recordLanding(integration, join(home, 'jobs', f.job), tested, c.gate.length, who)) ?? replayed;
        if (landed !== replayed && pathsOverlap(await touched(replayed, landed), mainPaths))
          throw Error('Main checkout is not at the recorded base tip');
      } catch (e) {
        if (f.state === 'cancelled') throw e;
        if (e instanceof CommandError) throw new CommandError('Main checkout is not at the recorded base tip', e.tail);
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
    f.landed_sha = landed; writeLand(home, f);
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
    await commands('after', main);
    if (c.push) {
      step('push');
      await checkClean(target === base ? paths : await touched(target, landed));
      const pushHead = await landingHead();
      // Push the verified HEAD by SHA so a later branch switch cannot change what is published.
      await command(main, 'git', ['-c', 'core.hooksPath=/dev/null', '-c', 'remote.origin.mirror=false', 'push',
        '--no-follow-tags', '--recurse-submodules=no', 'origin', `${pushHead}:${ref}`]);
    }
    step('cleanup');
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
    f.state = 'completed'; step('done');
  } catch (e) {
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
