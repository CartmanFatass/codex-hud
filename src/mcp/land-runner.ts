/** Runs in its own process so rebuilding HUD or restarting a watcher cannot replay the landing. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { worktreeGit as git } from '../collectors/worktrees.js';
import { takeLease } from '../roles/lease.js';
import { neutralizeFilters, safeGitEnv, SAFE_GIT_ARGS } from '../utils/git-safety.js';
import { landFile, readLand, writeLand, type LandFlow } from './land-state.js';
import { reapWorktree } from './managed-worktree.js';
import { recordLanding } from './land-records.js';
import { repairLand } from './land-repair.js';

class CommandError extends Error {
  constructor(message: string, readonly tail: string[]) { super(message); }
}
function command(cwd: string, bin: string, argv: string[]) {
  return new Promise<void>((ok, fail) => {
    const child = spawn(bin, argv, { cwd, env: safeGitEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: string) => { output = (output + chunk).slice(-65536); };
    for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', append);
    child.once('error', fail);
    child.once('close', (code, signal) => code === 0 ? ok() : fail(new CommandError(`exit ${code ?? signal}`,
      output.trimEnd().split(/\r?\n/).slice(-40))));
  });
}
const fields = (out: string) => out.split('\0').filter(Boolean);
async function execute(home: string, f: LandFlow) {
  const { wt, config: c } = f, main = wt.main_root, integration = join(dirname(wt.root), `land-${f.flow}`);
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
      const status = JSON.parse(fs.readFileSync(join(home, 'jobs', id, 'STATUS.json'), 'utf8'));
      if (!['closed', 'idle_grace', 'done'].includes(status.state)) throw Error(`Cannot land ${id}: job state is ${status.state ?? 'unknown'}`);
    }
    if (await head(wt.root) !== f.source_sha ||
        (await git(wt.root, ['symbolic-ref', 'HEAD'])).trim() !== `refs/heads/${wt.branch}`)
      throw Error('Source job is no longer settled at the recorded commit');
  };
  async function commands(kind: 'gate' | 'after', cwd: string) {
    for (const [i, cmd] of c[kind].entries()) {
      if (kind === 'gate') checkCancel();
      step(`${kind}[${i + 1}]: ${cmd}`);
      const shell = ['sh', '-c', cmd];
      const bin = c.wrapper ? resolve(main, c.wrapper) : shell.shift()!;
      try { await command(cwd, bin, shell); }
      catch (e) {
        if (kind !== 'gate' || !(e instanceof CommandError)) throw e;
        checkCancel(); await command(cwd, bin, shell);
        (f.reruns ??= []).push(f.step); writeLand(home, f);
      }
    }
  }
  let acquired = false;
  const acquire = async () => {
    while (!acquired) {
      checkCancel();
      const r = await takeLease({ name: 'main-checkout', wait_s: 1 }, lease);
      acquired = 'granted' in r && r.granted;
    }
  };
  async function prepare() {
    f.state = 'running'; step('prepare');
    await checkSource();
    f.base_sha = (await git(main, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    await checkMain(f.base_sha);
    await git(main, ['merge-base', '--is-ancestor', wt.base_head, f.source_sha]);
    const picks = (await git(main, ['rev-list', '--reverse', '--topo-order', `${wt.base_head}..${f.source_sha}`, `^${f.base_sha}`, '--'])).trim().split(/\s+/);
    if (!picks[0]) throw Error('Source has no commits to land');
    await git(main, ['worktree', 'add', '--detach', '--', integration, f.base_sha], 120000);
    // includeIf and a wrapper's temporary HOME can give the detached checkout a different identity.
    const identity = (await git(main, ['var', 'GIT_COMMITTER_IDENT'])).match(/^(.*) <([^<>]+)> \d+ [+-]\d+$/m);
    if (!identity) throw Error('Missing checkout committer identity');
    const who = ['-c', `user.name=${identity[1]}`, '-c', `user.email=${identity[2]}`];
    step('cherry-pick');
    for (const sha of picks) await command(integration, 'git', [...SAFE_GIT_ARGS, ...who, 'cherry-pick', '--no-gpg-sign', sha]);
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
        if ((f.repairs?.length ?? 0) >= 2) throw e;
        checkCancel(); await checkSource();
        f.error = e.message; f.tail = e.tail;
        // Only the helper-created scratch checkout is disposable, never the source or main.
        await git(main, ['worktree', 'remove', '--force', '--', integration], 120000);
        await takeLease({ name: 'main-checkout', release: true }, lease); acquired = false;
        await repairLand(home, f, checkCancel);
        f.source_sha = await head(wt.root);
        delete f.error; delete f.tail; delete f.tested_sha;
        step('main-checkout lease');
      }
    }
    const prior = f.repairs?.at(-1);
    if (prior) prior.outcome = 'gate passed';
    checkCancel(); await checkSource();
    step('records');
    const tested = f.tested_sha!, base = f.base_sha!;
    f.records_sha = await recordLanding(integration, join(home, 'jobs', f.job), tested, c.gate.length, who);
    const tip = f.records_sha ?? tested;
    checkCancel(); step('fast-forward');
    const paths = fields(await git(main, ['diff', '--name-only', '--no-renames', '-z', base, tip, '--']));
    const filters = await neutralizeFilters(git, main);
    for (let i = 0; i < paths.length; i += 128) {
      const batch = paths.slice(i, i + 128);
      const status = await git(main, [...filters, 'status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all', '--', ...batch]);
      const hidden = fields(await git(main, ['ls-files', '-v', '-z', '--', ...batch])).some(row => /^[a-zS] /.test(row));
      if (status || hidden) throw Error('Main checkout has dirty or hidden changes on paths the landing touches');
    }
    checkCancel(); await checkSource(); await checkMain(base);
    await git(main, ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--no-edit', tip], 120000);
    await checkMain(tip);
    f.landed_sha = tested; writeLand(home, f);
    await commands('after', main);
    if (c.push) {
      step('push'); await checkMain(tip);
      await command(main, 'git', ['-c', 'core.hooksPath=/dev/null', '-c', 'remote.origin.mirror=false', 'push',
        '--no-follow-tags', '--recurse-submodules=no', 'origin', `${tip}:${ref}`]);
    }
    step('cleanup');
    await git(main, ['worktree', 'remove', '--', integration], 120000);
    const receiptPath = join(home, 'jobs', f.job, 'job.json');
    const result = await reapWorktree(f.job, { job: f.job, cwd: wt.root, worktree: wt }, home);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const tmp = `${receiptPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...receipt, worktree_kept_reason: undefined, worktree_checked_head: undefined, ...result }), { mode: 0o600 });
    fs.renameSync(tmp, receiptPath);
    if ('worktree_kept_reason' in result) throw Error(result.worktree_kept_reason);
    f.state = 'completed'; step('done');
  } catch (e) {
    if (f.state !== 'cancelled') f.state = 'failed';
    f.error = (e as Error).message.split('\n')[0];
    f.tail = e instanceof CommandError ? e.tail : f.tail ?? (e as Error).message.trimEnd().split('\n').slice(-40);
    writeLand(home, f);
  } finally { if (acquired) await takeLease({ name: 'main-checkout', release: true }, lease); }
}
process.once('message', async ({ home, flow }: { home: string; flow: string }) => {
  const f = readLand(home, flow);
  if (f?.state === 'queued' && f.pid === process.pid) await execute(home, f);
});
