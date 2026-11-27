/** The land step's sealed effect. The driver admits it once; no part of this transaction is scheduled separately. */
import { fork, spawn } from 'node:child_process';
import type { Job, JobStatus } from './job-contracts.js';
import { binScript, jobFiles } from './paths.js';
import { readJsonFile, writePrivateFile } from '../utils/atomic-fs.js';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { parseWorktreeList, worktreeGit as git } from '../collectors/worktrees.js';
import { takeLease, type LandLease } from '../roles/lease.js';
import type { CommandResult, Launch } from './land-custodian.js';
import { neutralizeFilters, safeGitEnv, SAFE_GIT_ARGS } from '../utils/git-safety.js';
import { activeLand, DEFAULT_LAND_TIMEOUT_S, isFlowId, landAttempt, landFile, landOwnerGone, readLand, setLandStep, SPEC_CHANGE_REFUSAL, TICKET_DIFF_REFUSAL, writeLand, type LandFlow, type LandRerun } from './land-state.js';
import { canRepairSealedStep } from '../workflows/engine.js';
import { runLock, stopRequested } from '../workflows/store.js';
import { withTicketStoreLock } from '../tickets/store.js';
import { reapWorktree } from './managed-worktree.js';
import { checkLandingRecords, prepareLandRecords, recordLanding } from './land-records.js';
import { repairLand } from './land-repair.js';
import { canPublishTestedBuild, isMainBuildCommand } from './land-build.js';
import { LandOutput } from './land-evidence.js';
import { collectAndRecordLandFlakes, retryPendingFlakeCollections } from './land-flakes.js';

class CommandError extends Error {
  constructor(message: string, readonly evidence: ReturnType<LandOutput['evidence']>) { super(message); }
  get tail() { return this.evidence.tail; }
}
class CommandTimeout extends CommandError {}
class CustodianError extends Error {}
const MAX_BASE_MOVES = 2; // Independent of the engine's worker repair bound.
const CUSTODIAN_START_TIMEOUT_MS = 20_000;
const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
function command(cwd: string, bin: string, argv: string[], tracked?: { deadlineMs: number; env: NodeJS.ProcessEnv; lease: LandLease }) {
  return new Promise<string[]>((ok, fail) => {
    const env = safeGitEnv(tracked?.env ?? process.env);
    // Apply user preloads to the command, not the control processes that enforce its deadline.
    const { NODE_OPTIONS: nodeOptions, ...custodianEnv } = env;
    const child = tracked
      ? fork(binScript('land-custodian'), [], { cwd, env: custodianEnv, detached: true, execArgv: [], silent: true })
      : spawn(bin, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = new LandOutput(cwd);
    const streams = [child.stdout!, child.stderr!].map(input => {
      const stream = output.stream();
      createInterface({ input }).on('line', stream.line).on('close', stream.finish);
      return stream;
    });
    const evidence = () => {
      for (const stream of streams) stream.finish();
      return output.evidence();
    };
    let result: CommandResult | undefined;
    let ready = false, timedOut = false, settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (message: Launch | 'timeout') => {
      if (child.connected) child.send(message, error => { if (error && child.connected) child.disconnect(); });
    };
    const armTimer = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        if (ready) send('timeout');
        else if (child.connected) child.disconnect();
      }, ms);
    };
    // Bound custodian startup separately; start the command's own deadline once the payload spawns.
    if (tracked) armTimer(Math.max(tracked.deadlineMs, CUSTODIAN_START_TIMEOUT_MS));
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(error);
    });
    child.on('message', message => {
      if (message === 'started') {
        if (tracked && !timedOut) armTimer(tracked.deadlineMs);
        return;
      }
      if (message !== 'ready') { result = message as CommandResult; return; }
      if (!tracked || timedOut) return;
      ready = true;
      send({ bin, argv, nodeOptions, lease: tracked.lease });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result && 'error' in result) fail(new CustodianError(result.error));
      else if (tracked && code !== 0) fail(new CustodianError(`Land custodian exited: ${code ?? signal}`));
      else if (timedOut) fail(new CommandTimeout('timeout', evidence()));
      else if (tracked && !result) fail(new CustodianError('Land custodian exited without a command result'));
      else if ((result ? result.code : code) === 0) ok(output.tail());
      else fail(new CommandError(`exit ${result ? result.code ?? result.signal : code ?? signal}`, evidence()));
    });
  });
}
const fields = (out: string) => out.split('\0').filter(Boolean);
const isMetadataPath = (path: string) =>
  path === 'STATE.md' ||
  path === 'docs/handoff/STATE.md' ||
  path === '.hud/objectives.md' ||
  /^\.hud\/tickets\/[a-z0-9-]+\.json$/.test(path) ||
  /^\.scratch\/[a-z0-9-]+\/issues\/\d+-[^/]+\.md$/.test(path);
async function metadataOnly(cwd: string, from: string, to: string) {
  // Raw NUL-delimited records pair modes with paths. Only plain metadata files are exempt.
  const changes = fields(await git(cwd, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', from, to, '--']));
  return changes.every((field, i) => i % 2 === 0 ? /^:(100644|000000) (100644|000000) /.test(field) : isMetadataPath(field));
}
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
export async function executeLand(home: string, own: LandFlow, cleanup: string[]) {
  const { wt, config: c } = own, main = wt.main_root;
  const scratch = (id: string) => join(dirname(wt.root), `land-${id}`);
  let f = own, members = [own], integration = scratch(own.flow), publishing = false;
  const ref = `refs/heads/${c.base}`, lease = { home, cwd: main, holder: own.flow };
  // A queued helper can update its receipt without the checkout lease; serialize that with boarding.
  const queueLock = <T>(run: () => T) => withAbstractLock('land-queue', `${home}\0${main}`, run);
  const cancelled = (row: LandFlow) => stopRequested(home, row.flow);
  const step = (name: string) => {
    const at = new Date().toISOString();
    for (const row of members) { setLandStep(row, name, at); writeLand(home, row); }
  };
  const recordTiming = (name: string, t0: number, ok: boolean, extra?: { rerun?: true; skipped?: true }, write = true) => {
    // Shared work is timed only on the lead receipt, not counted once per passenger.
    (f.timings ??= []).push({ step: name, ms: Math.max(0, Math.round(performance.now() - t0)), ok, ...extra, train: f.train });
    if (write) writeLand(home, f);
  };
  let activeStep: [string, number] | undefined;
  const startStep = (name: string) => { step(name); activeStep = [name, performance.now()]; };
  const endStep = (ok = true, write = true) => {
    if (!activeStep) return;
    const [name, t0] = activeStep; activeStep = undefined;
    recordTiming(name, t0, ok, undefined, write);
  };
  const checkCancel = () => {
    if (!members.some(cancelled)) return;
    if (!f.train) f.state = 'cancelled';
    throw Error('Cancelled before fast-forward');
  };
  const head = async (dir: string) => (await git(dir, ['rev-parse', '--verify', 'HEAD'])).trim();
  const tree = async (sha: string) => (await git(main, ['rev-parse', '--verify', `${sha}^{tree}`])).trim();
  const mainTip = async () => {
    if ((await git(main, ['symbolic-ref', 'HEAD'])).trim() !== ref)
      throw Error('Main checkout is not at the recorded base tip');
    return head(main);
  };
  const checkMain = async (sha: string) => {
    if (await mainTip() !== sha) throw Error('Main checkout is not at the recorded base tip');
  };
  const checkSource = async (row: LandFlow) => {
    const { wt } = row;
    for (const id of new Set([row.job, row.repairs?.at(-1)?.job ?? row.job])) {
      const status = readJsonFile(join(home, 'jobs', id, jobFiles.status)) as JobStatus;
      if (!['closed', 'idle_grace', 'done'].includes(status.state)) throw Error(`Cannot land ${id}: job state is ${status.state ?? 'unknown'}`);
    }
    if (await head(wt.root) !== row.source_sha ||
        (await git(wt.root, ['symbolic-ref', 'HEAD'])).trim() !== `refs/heads/${wt.branch}`)
      throw Error('Source job is no longer settled at the recorded commit');
  };
  const checkSources = () => Promise.all(members.map(checkSource));
  const committer = async () => {
    // includeIf and a wrapper's temporary HOME can give the detached checkout a different identity.
    const identity = (await git(main, ['var', 'GIT_COMMITTER_IDENT'])).match(/^(.*) <([^<>]+)> \d+ [+-]\d+$/m);
    if (!identity) throw Error('Missing checkout committer identity');
    return ['-c', `user.name=${identity[1]}`, '-c', `user.email=${identity[2]}`];
  };
  const picksFor = async (base: string, source: string) =>
    (await git(main, ['rev-list', '--reverse', '--topo-order', `${base}..${source}`, '--'])).trim().split(/\s+/).filter(Boolean);
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
        ? command(cwd, resolve(main, c.wrapper), ['sh', '-c', script], { deadlineMs, env, lease })
        : command(cwd, 'sh', ['-c', script], { deadlineMs, env, lease });
      const t0 = performance.now();
      try {
        const output = await invoke(script);
        if (kind === 'after' && build) {
          const prefix = 'HUD build: ';
          f.after_note = output.find(line => line.startsWith(`${prefix}Cargo unavailable; `))?.slice(prefix.length);
        }
        recordTiming(label, t0, true, publish ? { skipped: true } : undefined);
      } catch (e) {
        if (kind !== 'gate' || f.train || !(e instanceof CommandError)) { recordTiming(label, t0, false); throw e; }
        const reruns = f.reruns ??= [];
        const prefix = `${landFile(home, f.flow)}.gate-${reruns.length + 1}`;
        const saveExcerpt = (error: CommandError, suffix = '') => {
          const path = `${prefix}${suffix}.log`;
          writePrivateFile(path, error.evidence.excerpt, { mkdir: false });
          return path;
        };
        const { tests, files, cases } = e.evidence;
        const entry: LandRerun = { step: label, tests, ...(cases.length && { cases }), output_path: saveExcerpt(e) };
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
  async function gate(sha: string, treeId: string) {
    await commands('gate', integration);
    if (await head(integration) !== sha) throw Error('Gate changed integration HEAD');
    for (const row of members) { row.tested_sha = sha; row.tested_tree = treeId; }
  }
  let acquired = false;
  let custodianFailed = false;
  const acquire = async () => {
    while (!acquired) {
      const r = await takeLease({ name: 'main-checkout', wait_s: 1 }, lease);
      if (!('granted' in r)) continue;
      acquired = r.granted;
      const live = await queueLock(() => {
        const latest = readLand(home, own.flow);
        if (!latest || !activeLand(latest)) return false;
        if (latest.state !== 'queued' || latest.pid !== process.pid) return !acquired;
        Object.assign(own, latest);
        if (cancelled(own)) {
          own.state = 'cancelled'; own.error = 'Cancelled before fast-forward'; writeLand(home, own);
          return false;
        }
        if (r.granted) return true;
        const { holder } = r.held_by;
        const blocker = isFlowId(holder) ? readLand(home, holder) : null;
        const gate = blocker && /^gate\[(\d+)\]:/.exec(blocker.step);
        const since = blocker ? Date.parse(blocker.step_started_at ?? blocker.updated_at) : NaN;
        const waiting = !blocker ? 'main-checkout lease' : gate && Number.isFinite(since)
          ? `waiting for ${holder} (gate step ${gate[1]}, ${Math.max(0, Math.floor((Date.now() - since) / 60000))} min)`
          : `waiting for ${holder}`;
        if (own.step !== waiting) step(waiting);
        return true;
      });
      if (!live) return false;
    }
    return true;
  };
  async function clearPrevious(ids: string[]) {
    if (!ids.length) return;
    const trees = parseWorktreeList(await git(main, ['worktree', 'list', '--porcelain', '-z']));
    for (const id of ids) {
      const old = trees.find(t => t.path === scratch(id));
      if (!old) continue;
      if (!old.detached || old.locked !== undefined) throw Error('Previous integration worktree is not disposable');
      await git(main, ['worktree', 'remove', '--force', '--', old.path], 120000);
    }
  }
  const protectSpec = async (base: string, tip: string) => {
    if (f.protected_spec && await git(main, ['diff', '--name-only', '--no-renames', base, tip, '--', 'docs/spec.md']))
      throw Error(SPEC_CHANGE_REFUSAL);
  };
  const touchesTickets = async (base: string, tip: string) => {
    if (await git(main, ['diff', '--name-only', '--no-renames', '-z', base, tip, '--', '.hud/tickets'])) return true;
    return Boolean(await git(main, ['log', '--format=', '--name-only', '--no-renames', '-m', '--first-parent', '-z', `${base}..${tip}`, '--', '.hud/tickets']));
  };
  const protectTickets = async (base: string, tip: string) => {
    if (await touchesTickets(base, tip)) throw Error(TICKET_DIFF_REFUSAL);
  };
  async function prepare() {
    f.state = 'running'; step('prepare');
    await checkSource(f);
    await clearPrevious(cleanup);
    cleanup.length = 0;
    f.base_sha = (await git(main, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    await checkMain(f.base_sha);
    const prepareFilters = await neutralizeFilters(git, main);
    await checkLandingRecords(main, home, prepareLandRecords(home, [f]), f.base_sha, c.gate.length, prepareFilters, new Date().toISOString());
    const ff = (await git(main, ['merge-base', f.base_sha, f.source_sha])).trim() === f.base_sha;
    const picks = await picksFor(f.base_sha, f.source_sha);
    if (!picks.length) throw Error('Source has no commits to land');
    if (fs.lstatSync(integration, { throwIfNoEntry: false })) throw Error('Integration destination already exists');
    startStep('create integration');
    await git(main, ['worktree', 'add', '--detach', '--', integration, ff ? f.source_sha : f.base_sha], 120000);
    endStep();
    const who = await committer();
    if (!ff) {
      startStep('cherry-pick');
      for (const sha of picks) await command(integration, 'git', [...SAFE_GIT_ARGS, ...who, 'cherry-pick', '--no-gpg-sign', sha]);
      endStep();
    }
    const tested = await head(integration);
    await protectSpec(f.base_sha, tested);
    await protectTickets(f.base_sha, tested);
    await gate(tested, await tree(tested));
    return who;
  }
  async function publish(who: string[], trainTips?: Map<LandFlow, string>) {
    checkCancel(); await checkSources();
    const tested = f.tested_sha!, base = f.base_sha!;
    let landed = tested;
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
    const replay = async (target: string, current: string) => {
      // Fall back to singles (with normal replay/re-gate) rather than rebuild a moving train.
      if (trainTips) throw Error('Main checkout is not at the recorded base tip');
      if ((f.base_moves ?? 0) >= MAX_BASE_MOVES)
        throw Error('Main checkout is not at the recorded base tip (base move retry limit reached)');
      try { await git(main, ['merge-base', '--is-ancestor', target, current]); }
      catch { throw Error('Main checkout is not at the recorded base tip'); }
      const mainPaths = await touched(base, current);
      if (pathsOverlap(paths, mainPaths)) throw Error('Main checkout is not at the recorded base tip');
      checkCancel();
      // Always replay the original tested patches.
      const picks = await picksFor(base, tested);
      if (!picks.length) throw Error('Main checkout is not at the recorded base tip');
      await git(main, ['worktree', 'remove', '--force', '--', integration], 120000);
      await git(main, ['worktree', 'add', '--detach', '--', integration, current], 120000);
      try {
        for (const sha of picks) {
          checkCancel();
          await command(integration, 'git', [...SAFE_GIT_ARGS, ...filters, ...who, 'cherry-pick', '--no-gpg-sign', sha]);
        }
        landed = await head(integration);
      } catch (e) {
        if (f.state === 'cancelled') throw e;
        if (e instanceof CommandError) throw new CommandError('Main checkout is not at the recorded base tip', e.evidence);
        throw e;
      }
      f.base_moves = (f.base_moves ?? 0) + 1;
    };
    checkCancel(); await checkSources();
    let target = base, current = await mainTip(), landedPaths = paths;
    for (;;) {
      if (current !== target) {
        await replay(target, current);
        target = current;
        landedPaths = await touched(target, landed);
      }
      await protectSpec(target, landed);
      await protectTickets(target, landed);
      const published = await tree(landed);
      for (const row of members) row.published_tree = published;
      const regate = published !== f.tested_tree && !await metadataOnly(main, f.tested_tree!, published);
      if (regate) {
        // Disjoint paths can still interact. Gate the exact candidate.
        await gate(landed, published);
        step('fast-forward');
      }
      if (target !== base || regate) await checkClean(landedPaths);
      checkCancel(); await checkSources();
      current = await mainTip();
      if (current === target) break;
    }
    const at = new Date().toISOString();
    await withTicketStoreLock(fs.realpathSync(main), async () => {
      const recordEntries = prepareLandRecords(home, members);
      await checkLandingRecords(main, home, recordEntries, target, c.gate.length, filters, at, { locked: true });
      publishing = true;
      for (const row of members) { row.publish_pending = landed; writeLand(home, row); }
      try {
        await git(main, ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--no-edit', landed], 120000);
      } catch (error) {
        const refusal = error as { code?: number | string; killed?: boolean; signal?: string | null };
        // A normal Git exit alone doesn't prove that the ref, index and files stayed put.
        if (typeof refusal.code === 'number' && !refusal.killed && !refusal.signal) {
          try {
            await checkClean(landedPaths);
            await checkMain(target);
            for (const row of members) delete row.publish_pending; // Persist with the failure.
          } catch { /* If either check fails, keep the interlock. */ }
        }
        throw error;
      }
      endStep();
      startStep('records');
      const preAmend = landed;
      let amended: string | undefined;
      try {
        amended = await recordLanding(main, home, recordEntries, target, c.gate.length, who, filters, at, { locked: true, expectedTip: preAmend });
      } catch (error) {
        for (const row of members) {
          if (target !== base) row.replayed_onto = target;
          if (trainTips) row.published_sha = preAmend;
          const tip = trainTips?.get(row);
          row.landed_sha = !tip || tip === preAmend ? preAmend : tip;
          row.landed_at = at;
          delete row.publish_pending;
          writeLand(home, row);
        }
        throw error;
      }
      if (amended) {
        landed = amended;
        const amendedTree = await tree(landed);
        for (const row of members) row.published_tree = amendedTree;
      }
      for (const row of members) {
        if (target !== base) row.replayed_onto = target;
        if (trainTips) row.published_sha = landed;
        const tip = trainTips?.get(row);
        row.landed_sha = !tip || tip === preAmend ? landed : tip;
        row.landed_at = at;
        delete row.publish_pending;
        writeLand(home, row);
      }
      endStep();
    });
    const checkLandingHead = async () => {
      const moved = Error('Main checkout is not at the recorded base tip');
      if ((await git(main, ['symbolic-ref', 'HEAD'])).trim() !== ref) throw moved;
      const current = await head(main);
      if (current !== landed) {
        try { await git(main, ['merge-base', '--is-ancestor', landed, current]); }
        catch { throw moved; }
      }
    };
    await checkLandingHead();
    await commands('after', main, target === base ? { tested: f.tested_sha!, filters } : undefined);
    if (c.push) {
      startStep('push');
      await checkClean(landedPaths);
      await checkLandingHead();
      // Later main commits are not covered by this flow's gate.
      await command(main, 'git', ['-c', 'core.hooksPath=/dev/null', '-c', 'remote.origin.mirror=false', 'push',
        '--no-follow-tags', '--recurse-submodules=no', 'origin', `${landed}:${ref}`]);
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
    const integrationNotes = notes.length;
    for (const row of members) {
      const { wt } = row;
      try {
        const receiptPath = join(home, 'jobs', row.job, jobFiles.job);
        const result = await reapWorktree(row.job, { job: row.job, cwd: wt.root, worktree: wt }, home,
          { source_sha: row.source_sha, landed_sha: row.landed_sha! });
        const receipt = readJsonFile(receiptPath) as Job;
        writePrivateFile(receiptPath, JSON.stringify({ ...receipt, worktree_kept_reason: undefined, worktree_checked_head: undefined, ...result }), { mkdir: false });
        if ('worktree_kept_reason' in result) notes.push(result.worktree_kept_reason);
      } catch (e) { note(e); }
      if (notes.length) row.cleanup_note = notes.join('; ');
      notes.length = integrationNotes;
      row.after_note = f.after_note;
    }
    // Publish terminal state, final step, cleanup note and timing in one atomic flow write.
    endStep(true, false);
    for (const row of members) row.state = 'completed';
    step('done');
  }
  function fail(e: unknown) {
    endStep(false, false);
    for (const row of members) {
      if (row.state !== 'cancelled') row.state = 'failed';
      row.error = (e as Error).message.split('\n')[0];
      row.tail = e instanceof CommandError ? e.tail : row.tail ?? (e as Error).message.trimEnd().split('\n').slice(-40);
      writeLand(home, row);
    }
  }
  async function train() {
    const eligible = (row: LandFlow | null): row is LandFlow => !!row && row.state === 'queued' &&
      row.wt.main_root === main && !row.single && !row.repairs?.length &&
      isDeepStrictEqual(row.config, c) && !cancelled(row) && !landOwnerGone(row);
    if (!eligible(own)) return false;
    const ids = fs.readdirSync(join(home, 'flows')).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5))
      .filter(id => id !== own.flow && isFlowId(id) && eligible(readLand(home, id)));
    if (!ids.length) return false;
    const base = await head(main);
    await checkMain(base);
    const claimed = await queueLock(async () => {
      const queue = [...ids.map(id => readLand(home, id)).filter(eligible), own]
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.flow.localeCompare(b.flow));
      if (queue.length < 2) return [];
      const rows: { row: LandFlow; boarded: LandFlow }[] = [];
      for (const candidate of queue) await runLock(home, candidate.flow, () => {
        const row = readLand(home, candidate.flow);
        if (!eligible(row)) return;
        // Point at the checkout owner before the train can touch Git. Retain the
        // original cursor for a live, pre-publish fallback to singles.
        const boarded: LandFlow = { ...row, boarded: { flow: own.flow, pid: own.pid, start: own.start }, base_sha: base, state: 'running' };
        if (row.workflow) {
          boarded.workflow = structuredClone(row.workflow);
          boarded.workflow.steps.land = { state: 'running', admitted: true };
        }
        setLandStep(boarded, 'prepare'); writeLand(home, boarded);
        rows.push({ row, boarded });
      });
      if (rows.length < 2) {
        for (const { row } of rows) await runLock(home, row.flow, () => writeLand(home, row));
        return [];
      }
      return rows;
    });
    if (!claimed.length) return false;
    const tips = new Map<LandFlow, string>();
    integration = scratch(`${own.flow}-train`);
    let made = false, cleanupBlocked = false;
    try {
      if (fs.lstatSync(integration, { throwIfNoEntry: false })) throw Error('Integration destination already exists');
      await git(main, ['worktree', 'add', '--detach', '--', integration, base], 120000);
      made = true;
      const who = await committer();
      for (const { boarded } of claimed) {
        let picks: string[];
        try {
          await checkSource(boarded);
          await clearPrevious(landAttempt(home, boarded.job).cleanup);
          picks = await picksFor(base, boarded.source_sha);
        } catch { continue; }
        if (!picks.length || cancelled(boarded)) continue;
        const beforePick = await head(integration);
        try {
          await command(integration, 'git', [...SAFE_GIT_ARGS, ...who, 'cherry-pick', '--no-gpg-sign', ...picks]);
        } catch (e) {
          if (!(e instanceof CommandError)) throw e;
          await git(integration, ['cherry-pick', '--abort']);
          continue;
        }
        const afterPick = await head(integration);
        if (await touchesTickets(beforePick, afterPick)) {
          await git(integration, ['reset', '--hard', beforePick]);
          continue;
        }
        tips.set(boarded, afterPick);
      }
      if (tips.size) {
        members = [...tips.keys()]; f = members[0];
        for (const row of members) row.train = f.flow;
        const tested = await head(integration);
        await gate(tested, await tree(tested));
        await publish(who, tips);
      }
    } catch (e) {
      cleanupBlocked = e instanceof CustodianError;
      if (cleanupBlocked) custodianFailed = true;
      if (publishing) fail(e);
      else if (cleanupBlocked) throw e; // Do not touch a checkout whose group may still be running.
      // Nothing reached main: no train gate rerun or repair. Original helpers take the single path.
      else endStep(false);
    } finally {
      let cleanupNote: string | undefined;
      if (!publishing && made && !cleanupBlocked) {
        try { await git(main, ['worktree', 'remove', '--force', '--', integration], 120000); }
        catch (e) { cleanupNote = (e as Error).message.split('\n')[0]; }
      }
      for (const { row, boarded } of claimed) {
        if (publishing && tips.has(boarded)) continue;
        row.single = true;
        row.timings = boarded.timings;
        if (cleanupNote) row.cleanup_note = cleanupNote;
        await runLock(home, row.flow, () => writeLand(home, row));
        if (row.flow === own.flow) Object.assign(own, row);
      }
    }
    if (publishing && members.some(row => row.flow === own.flow)) return true;
    f = own; members = [own]; integration = scratch(own.flow); publishing = false;
    return false;
  }
  try {
    for (;;) {
      if (!await acquire()) return;
      if (await train()) break;
      checkCancel();
      let who: string[];
      try { who = await prepare(); }
      catch (e) {
        endStep(false);
        const conflict = f.step === 'cherry-pick' && !!(await git(integration, ['ls-files', '-u']));
        if (!(e instanceof CommandError) || (!conflict && !f.step.startsWith('gate['))) throw e;
        const prior = f.repairs?.at(-1);
        if (prior) { prior.outcome = `failed at ${f.step}`; prior.changed_at = new Date().toISOString(); }
        // Unattended repairs return to the lead; never publish a substitute for the approved commit.
        if (f.protected_spec || e instanceof CommandTimeout || !canRepairSealedStep(f.repairs?.length ?? 0)) throw e;
        checkCancel(); await checkSource(f);
        f.error = e.message; f.tail = e.tail;
        // Only the helper-created scratch checkout is disposable, never the source or main.
        await git(main, ['worktree', 'remove', '--force', '--', integration], 120000);
        await takeLease({ name: 'main-checkout', release: true }, lease); acquired = false;
        await repairLand(home, f, checkCancel);
        f.source_sha = await head(wt.root);
        delete f.error; delete f.tail;
        f.state = 'queued'; step('main-checkout lease');
        continue;
      }
      const prior = f.repairs?.at(-1);
      if (prior) { prior.outcome = 'gate passed'; prior.changed_at = new Date().toISOString(); }
      await publish(who);
      break;
    }
  } catch (e) {
    if (e instanceof CustodianError) custodianFailed = true;
    fail(e);
  } finally {
    if (acquired) {
      await takeLease({ name: 'main-checkout', release: true }, lease);
    }
  }
  const landedTickets = members.flatMap(row => {
    if (row.state !== 'completed') return [];
    try {
      const receipt = readJsonFile(join(home, 'jobs', row.job, jobFiles.job)) as Job;
      return typeof receipt.ticket === 'string' && receipt.ticket ? [receipt.ticket] : [];
    } catch { return []; }
  });
  await retryPendingFlakeCollections(home, main, f.pane, { excludeFlow: f.flow }).catch(() => {});
  await collectAndRecordLandFlakes(home, main, f, { landedTickets }).catch(() => {});
}
