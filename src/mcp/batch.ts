import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { capForRole, loadConcurrencySettings } from '../roles/concurrency.js';
import { currentPreset } from '../roles/roster.js';
import { workerTreeRootGone } from '../roles/worker-tree.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import { assembleContext, jobCwd, readBriefFile, required, type Args } from './dispatch/context.js';
import { evenPlanner, launchPlan, registry } from './dispatch/places.js';
import { defaultImpRoute, impPlacementSettings, pickImpRoute } from './imp-routing.js';
import type { Job } from './job-contracts.js';
import { binScript } from './paths.js';
import { batchActive, batchDir, batchIds, batchIndex, batchLock, failuresByReason, isBatchId, readBatch, saveBatch, type Batch, type BatchInput, type Manifest } from './batch-state.js';

const starting = new Map<string, ChildProcess>();
export function wakeBatch(home: string, b: Batch) {
  if (!batchActive(b) || starting.has(b.flow) || (b.pid && b.start && !workerTreeRootGone(b.pid, b.start))) return;
  const { HUD_JOB_DIR: _worker, ...env } = process.env;
  const child = spawn(process.execPath, [binScript('batch-runner'), b.flow], { detached: true, stdio: 'ignore',
    cwd: b.cwd, env: { ...env, HUD_HOME: home, HERDR_PANE_ID: b.pane } });
  starting.set(b.flow, child);
  const clear = () => { if (starting.get(b.flow) === child) starting.delete(b.flow); };
  child.once('exit', clear).once('error', clear).unref();
}

// Size existing project files, not prose, glob expansions, directories, URLs or prospective outputs.
function inputBytes(cwd: string, task: string, brief: string | undefined, context: string[]) {
  const seen = new Set(brief ? [fs.realpathSync(resolve(cwd, brief))] : []);
  const inputs: { path: string; bytes: number }[] = [];
  const refs = task.matchAll(/`([^`\n]+)`|"([^"\n]+)"|(?<!\w)'([^'\n]+)'|(?:^|[\s(])([\w./-]+)/gm);
  const paths = Array.from(refs).flatMap(m => {
    // An old output can exist (e.g. when relabelling). It is not input merely because
    // the brief says “Output: `...`” or “write the results to `...`”.
    if (/(?:\boutput(?:\s+(?:file|path))?\s*:|\b(?:write|save)\b[^.\n`;:]{0,80}\b(?:to|in))\s*$/i.test(task.slice(Math.max(0, m.index - 96), m.index))) return [];
    if (m[4] && !/[./]/.test(m[4])) return [];
    return [m[1] ?? m[2] ?? m[3] ?? m[4].replace(/[.]$/, '')];
  });
  for (const path of [...context, ...paths]) {
    if (!path || path.length > 4096 || path.includes('\0')) continue;
    try {
      const real = fs.realpathSync(resolve(cwd, path)), rel = relative(cwd, real);
      if (seen.has(real) || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) continue;
      const stat = fs.statSync(real);
      if (stat.isFile()) { inputs.push({ path: rel, bytes: stat.size }); seen.add(real); }
    } catch (error) { if (!['ENOENT','ENOTDIR','ENAMETOOLONG'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return { input_bytes: inputs.reduce((n, f) => n + f.bytes, Buffer.byteLength(task)), inputs };
}

export function batchView(home: string, id: string, pane: string | null) {
  if (!isBatchId(id) || readBatch(home, id)?.pane !== pane) return { ok: false, code: 'flow_not_found' };
  const { batch: b, items } = batchIndex(home, id);
  return { flow: id, state: b.state, reason: b.reason, scale: b.scale, totals: b.totals, failures: failuresByReason(items), items,
    result_index: join(batchDir(home, id), 'index.json') };
}
export async function controlBatch(home: string, pane: string | null, args: Args) {
  const { batch: id, action } = args;
  if (!isBatchId(id) || !['resume','pause','stop','retry_failed'].includes(String(action)) || Object.keys(args).length !== 2) throw Error('invalid_arguments: batch action');
  return withAbstractLock('concurrency', home, () => batchLock(home, id, () => {
    if (readBatch(home, id)?.pane !== pane) throw Error('flow_not_found');
    const { batch: b, items } = batchIndex(home, id);
    if (action === 'stop' && b.state !== 'completed') {
      b.state = 'stopped';
      for (const i of items) if (i.state === 'waiting') i.state = 'cancelled'; // Manifest waiters have no queued jobs to close.
    } else if (action === 'pause' && b.state === 'working') { b.state = 'paused'; b.reason = 'paused by caller'; }
    else if ((action === 'resume' && b.state === 'paused') || (action === 'retry_failed' && items.some(i => i.state === 'failed'))) {
      if (action === 'retry_failed') for (const i of items) if (i.state === 'failed') {
        (i.previous ??= []).push({ job: i.job, reason: i.reason });
        i.state = 'waiting'; delete i.job; delete i.reason; delete i.report_path; delete i.files;
      }
      b.epoch++; b.streak = b.settled = b.failures = 0; b.state = 'working'; delete b.reason;
    }
    saveBatch(home, b, items);
    return b;
  }), { timeoutMs: 10_000 });
}

export async function startBatch(home: string, pane: string | null, args: Args, dispatcher?: Job['dispatcher']) {
  if (!pane) throw Error('hud_create batch requires a caller pane');
  const { items, max_parallel, request_key, ...shared } = args;
  if (!Array.isArray(items) || !items.length || items.length > 512) throw Error('invalid_arguments: items (1–512)');
  if (max_parallel !== undefined && (typeof max_parallel !== 'number' || !Number.isSafeInteger(max_parallel) || max_parallel < 1)) throw Error('invalid_arguments: max_parallel');
  if (request_key !== undefined) required(args, 'request_key');
  const extra = Object.keys(shared).find(k => !['role','cwd','isolation','mode','prewalk','scouts','package','context_files','checks','experiment','arm'].includes(k));
  if (extra) throw Error(`invalid_arguments: unsupported batch option ${extra}`);
  const cwd = fs.realpathSync(jobCwd(args)), role = required(args, 'role');
  const key = createHash('sha256').update(JSON.stringify([pane, cwd, request_key ?? args])).digest('hex');
  return withAbstractLock('batch-create', `${home}\0${key}`, async () => {
    for (const id of batchIds(home)) {
      const prior = readBatch(home, id);
      if (prior?.key === key && (request_key !== undefined || Date.now() - prior.created_at < 600_000)) return prior;
    }
    const found = registry(cwd), chain = found.roles().get(role);
    if (!chain || role === 'council') throw Error('invalid_arguments: batch requires one available ordinary role');
    const cap = capForRole(loadConcurrencySettings(), role);
    if (cap && cap < 3) throw Error(`invalid_arguments: ${role} cap ${cap} leaves no batch slots after reserving two`);
    const limit = Math.min(max_parallel ?? (cap || items.length), cap ? cap - 2 : Infinity);
    const settings = impPlacementSettings(home), routing = found.routing(), mode = args.mode === 'headless' ? 'headless' : 'tab';
    const pool = role === 'sonic' && settings?.sonicPlacement === 'even' ? settings.sonicEvenPool
      : role === 'imp' && settings?.impPlacement === 'even' ? settings.impEvenPool : undefined;
    // Snapshot the available cycle once. Interactive creates rotating the global cursor
    // during submission cannot remove a preset from this batch's pilot coverage.
    const seed = pool && (role === 'imp' || role === 'sonic') ? (await evenPlanner(found, chain, args, routing, role, pool)())?.route : undefined;
    const cycle = seed && pool ? [...new Set(pool)].filter(preset => chain.presets?.some(p => p.name === preset) &&
      launchPlan(found, chain, Date.now(), args, routing, undefined, undefined, { ...seed, preset }).candidates.length) : [];
    const first = Math.max(0, cycle.indexOf(seed?.preset ?? ''));
    const context = await assembleContext(args, cwd, false, found.project());
    if ('code' in context) throw Error(context.error);
    const inputs: BatchInput[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['task','brief_file','package'].includes(k)) ||
        (raw.task === undefined) === (raw.brief_file === undefined) || (raw.package !== undefined && typeof raw.package !== 'string')) throw Error('invalid_arguments: batch item');
      const brief = raw.brief_file === undefined ? undefined : required(raw, 'brief_file');
      const loaded = brief ? await readBriefFile(brief, cwd) : { task: required(raw, 'task') };
      if ('error' in loaded) throw Error(`${loaded.code}: ${loaded.error}`);
      const { task } = loaded;
      if (Buffer.byteLength(task) > 256 * 1024) throw Error('invalid_arguments: batch task exceeds 256 KiB');
      const size = inputBytes(cwd, task, brief, context.metadata.context_files ?? []);
      const route = seed ? { ...seed, preset: cycle[(first + inputs.length) % cycle.length] ?? seed.preset } : role === 'imp' && settings?.impPlacement === 'auto' && chain.routing
        ? await pickImpRoute(home, settings, chain.routing, task, args.mode === undefined ? undefined : mode, () => ({ context_files: context.contextInputs }))
        : defaultImpRoute('Batch placement', role === 'sonic' ? 'headless' : mode);
      if (!route) throw Error('no_available_place');
      const preset = route.preset !== undefined ? route.preset : route.tier !== 'standard' ? chain.routing?.[route.tier]?.preset ?? currentPreset(chain) : currentPreset(chain);
      // Pin the actual preset, not a tier which might silently fall back or be reassigned after the pilot.
      const pinned = { ...route, tier: 'standard' as const, preset };
      const plan = launchPlan(found, chain, Date.now(), args, routing, undefined, undefined, pinned);
      if (!plan.candidates.length) throw Error(`no_available_place: ${preset ?? role}`);
      inputs.push({ task, brief_file: brief, package: raw.package, ...size, route: pinned, pilot: false });
    }
    const pilots = new Map<string | null, BatchInput>();
    for (const item of inputs) {
      const name = item.route.preset ?? null;
      if (!pilots.has(name) || pilots.get(name)!.input_bytes < item.input_bytes) pilots.set(name, item);
    }
    for (const pilot of pilots.values()) pilot.pilot = true;
    const sizes = inputs.map(i => i.input_bytes).sort((a,b) => a-b), n = sizes.length;
    const flow = `b${randomBytes(8).toString('hex')}`;
    const b: Batch = { flow, cwd, pane, key, created_at: Date.now(), dispatcher, state: 'working', epoch: 0, streak: 0, settled: 0, failures: 0,
      totals: { waiting: n, running: 0, done: 0, failed: 0 }, notices: {}, scale: { count: n, role, cap, max_parallel: limit,
        presets: [...pilots.keys()], input_bytes: { max: sizes[n-1], median: (sizes[(n-1)>>1] + sizes[n>>1])/2, total: sizes.reduce((a,b) => a+b, 0) } } };
    const dir = batchDir(home, flow);
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    if ((role === 'imp' || role === 'frontend-imp') && shared.isolation === undefined) shared.isolation = 'worktree';
    writeJsonPrivate(join(dir, 'manifest.json'), { shared, items: inputs } satisfies Manifest);
    saveBatch(home, b, inputs.map((i, k) => ({ item: k+1, state: 'waiting', preset: i.route.preset ?? null, pilot: i.pilot, brief_file: i.brief_file })));
    return b;
  });
}
