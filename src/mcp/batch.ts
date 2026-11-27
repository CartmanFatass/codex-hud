import { controlRun, type Control } from '../workflows/engine.js';
import { loadGraph } from '../workflows/graph.js';
import { sharedRoot } from '../roles/projects.js';
import { procStat } from '../utils/proc.js';
import { runVisible } from '../workflows/scope.js';
import { freezeGraph } from '../workflows/store.js';
import { wakeWorkflow } from '../workflows/wake.js';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { capForRole, loadConcurrencySettings } from '../roles/concurrency.js';
import { currentPreset } from '../roles/roster.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { writeJsonPrivate } from '../utils/atomic-fs.js';
import { SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';
import { assembleContext, jobCwd, readBriefFile, required, type Args } from './dispatch/context.js';
import { evenPlanner, launchPlan, registry } from './dispatch/places.js';
import { defaultImpRoute, impPlacementSettings, pickImpRoute } from './imp-routing.js';
import type { Job } from './job-contracts.js';
import { BUNDLED_ROOT } from './paths.js';
import { batchDir, batchIds, batchIndex, batchLock, failuresByReason, isBatchId, readBatch, saveBatch, type Batch, type BatchInput, type Manifest } from './batch-state.js';

function extractReferencedPaths(task: string): string[] {
  const refs = task.matchAll(/`([^`\n]+)`|"([^"\n]+)"|(?<!\w)'([^'\n]+)'|(?:^|[\s(])([\w./-]+)/gm);
  return Array.from(refs).flatMap(m => {
    // An old output can exist (e.g. when relabelling). It is not input merely because
    // the brief says “Output: `...`” or “write the results to `...`”.
    if (/(?:\boutput(?:\s+(?:file|path))?\s*:|\b(?:write|save)\b[^.\n`;:]{0,80}\b(?:to|in))\s*$/i.test(task.slice(Math.max(0, m.index - 96), m.index))) return [];
    if (m[4] && !/[./]/.test(m[4])) return [];
    return [m[1] ?? m[2] ?? m[3] ?? m[4].replace(/[.]$/, '')];
  });
}

// Size named project files and explicitly declared workflow results, not glob expansions,
// directories, URLs or prospective outputs.
export function inputBytes(cwd: string, task: string, brief: string | undefined, context: string[], results: string[] = []) {
  const seen = new Set(brief ? [fs.realpathSync(resolve(cwd, brief))] : []);
  const inputs: { path: string; bytes: number }[] = [];
  const paths = extractReferencedPaths(task);
  const declared = new Set(results);
  for (const path of [...results, ...context, ...paths]) {
    if (!path || path.length > 4096 || path.includes('\0')) continue;
    try {
      const real = fs.realpathSync(resolve(cwd, path)), rel = relative(cwd, real);
      if (seen.has(real) || (!declared.has(path) && (rel === '..' || rel.startsWith('../') || isAbsolute(rel)))) continue;
      const stat = fs.statSync(real);
      if (stat.isFile()) { inputs.push({ path: rel, bytes: stat.size }); seen.add(real); }
    } catch (error) { if (!['ENOENT','ENOTDIR','ENAMETOOLONG'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return { input_bytes: inputs.reduce((n, f) => n + f.bytes, Buffer.byteLength(task)), inputs };
}

function safeGitSync(cwd: string, args: string[], input?: string) {
  return spawnSync('git', [...SAFE_GIT_ARGS, ...args], {
    cwd, input, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    env: { ...safeGitEnv(process.env), LC_ALL: 'C', GIT_LITERAL_PATHSPECS: '1' },
  });
}

function normalizeTreePath(raw: string): string | null {
  if (!raw || raw.length > 4096 || raw.includes('\0') || isAbsolute(raw)) return null;
  const norm = posix.normalize(raw.replace(/\\/g, '/'));
  if (!norm || norm === '.' || norm === '..' || norm.startsWith('../') || norm.startsWith('/')) return null;
  return norm;
}

/** Measure a brief whose worker runs in a managed worktree populated from committed HEAD. */
export function inputBytesAtHead(
  cwd: string,
  task: string,
  results: string[] = [],
): { ok: true; input_bytes: number; inputs: { path: string; bytes: number }[] } | { ok: false; error: string } {
  const rev = safeGitSync(cwd, ['rev-parse', '--is-inside-work-tree', '--verify', 'HEAD^{commit}']);
  if (rev.error || rev.status !== 0)
    return { ok: false, error: 'worktree Sonic input size could not be established (requires a Git checkout with a HEAD commit)' };
  const [insideTree, head] = rev.stdout.trim().split('\n');
  if (insideTree !== 'true' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head ?? ''))
    return { ok: false, error: 'worktree Sonic input size could not be established (requires a Git checkout with a HEAD commit)' };

  const seenDisk = new Set<string>();
  const inputs: { path: string; bytes: number }[] = [];
  const measureDisk = (path: string, declared: boolean) => {
    if (!path || path.length > 4096 || path.includes('\0')) return;
    try {
      const real = fs.realpathSync(resolve(cwd, path)), rel = relative(cwd, real);
      if (seenDisk.has(real) || (!declared && (rel === '..' || rel.startsWith('../') || isAbsolute(rel)))) return;
      const stat = fs.statSync(real);
      if (stat.isFile()) { inputs.push({ path: rel, bytes: stat.size }); seenDisk.add(real); }
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  };
  for (const path of results) measureDisk(path, true);

  const relPaths = new Set<string>();
  for (const path of extractReferencedPaths(task)) {
    if (!path || path.length > 4096 || path.includes('\0')) continue;
    if (isAbsolute(path)) measureDisk(path, false);
    else {
      const norm = normalizeTreePath(path);
      if (norm) relPaths.add(norm);
    }
  }

  const probeBatch = (paths: string[]): Map<string, { type: string; size: number }> | null => {
    if (!paths.length) return new Map();
    const res = safeGitSync(cwd, ['cat-file', '-Z', '--batch-check=%(objecttype) %(objectsize)'],
      paths.map(p => `${head}:${p}\0`).join(''));
    if (res.error || res.status !== 0) return null;
    const records = res.stdout.split('\0');
    if (records.length < paths.length) return null;
    const out = new Map<string, { type: string; size: number }>();
    for (let i = 0; i < paths.length; i++) {
      const match = /^(blob|tree|commit|tag) (\d+)$/.exec(records[i]);
      if (match) out.set(paths[i], { type: match[1], size: Number(match[2]) });
    }
    return out;
  };
  const blobModes = (paths: string[]): Map<string, { mode: string; sha: string }> | null => {
    if (!paths.length) return new Map();
    const res = safeGitSync(cwd, ['ls-tree', '--full-tree', '-z', head, '--', ...paths]);
    if (res.error || res.status !== 0) return null;
    const out = new Map<string, { mode: string; sha: string }>();
    for (const record of res.stdout.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, sha] = record.slice(0, tab).split(' ');
      if (type === 'blob') out.set(record.slice(tab + 1), { mode, sha });
    }
    return out;
  };

  const seenHead = new Set<string>();
  const missingForDeps: string[] = [];
  let pending = [...relPaths];
  for (let hop = 0; pending.length && hop < 8; hop++) {
    // Include ancestor prefixes so symlinks on parent segments (e.g. link/file.txt) are discovered.
    const toProbe = new Set<string>();
    for (const p of pending) {
      toProbe.add(p);
      for (let slash = p.indexOf('/'); slash > 0; slash = p.indexOf('/', slash + 1)) toProbe.add(p.slice(0, slash));
    }
    const probed = probeBatch([...toProbe]);
    if (!probed) return { ok: false, error: 'worktree Sonic input size could not be established from HEAD' };
    const blobCandidates = [...probed.entries()].filter(([, v]) => v.type === 'blob').map(([k]) => k);
    const modes = blobModes(blobCandidates);
    if (!modes) return { ok: false, error: 'worktree Sonic input size could not be established from HEAD' };
    const nextPending: string[] = [];
    for (const p of pending) {
      if (seenHead.has(p)) continue;
      const direct = probed.get(p);
      if (direct?.type === 'blob') {
        const meta = modes.get(p);
        if (!meta) return { ok: false, error: `worktree Sonic input mode could not be established for ${p}` };
        if (meta.mode === '120000') {
          const link = safeGitSync(cwd, ['cat-file', 'blob', meta.sha]);
          if (link.error || link.status !== 0) return { ok: false, error: `worktree Sonic symlink target could not be read for ${p}` };
          const resolved = normalizeTreePath(posix.join(posix.dirname(p), link.stdout.trim()));
          if (resolved) nextPending.push(resolved);
        } else {
          seenHead.add(p);
          inputs.push({ path: p, bytes: direct.size });
        }
        continue;
      }
      if (direct) continue; // Directory (tree) or non-file entry.
      // Check if any ancestor segment is a committed symlink.
      let redirected = false;
      for (let slash = p.indexOf('/'); slash > 0; slash = p.indexOf('/', slash + 1)) {
        const prefix = p.slice(0, slash), meta = modes.get(prefix);
        if (meta?.mode === '120000') {
          const link = safeGitSync(cwd, ['cat-file', 'blob', meta.sha]);
          if (link.error || link.status !== 0) return { ok: false, error: `worktree Sonic symlink target could not be read for ${prefix}` };
          const resolved = normalizeTreePath(posix.join(posix.dirname(prefix), link.stdout.trim(), p.slice(slash + 1)));
          if (resolved) nextPending.push(resolved);
          redirected = true;
          break;
        }
      }
      if (!redirected && p.startsWith('node_modules/')) missingForDeps.push(p);
    }
    if (hop === 7 && nextPending.length) return { ok: false, error: 'worktree Sonic symlink depth exceeded' };
    pending = [...new Set(nextPending)];
  }
  if (missingForDeps.length) {
    // populateWorktree symlinks main_root/node_modules into the managed worktree.
    const mainRoot = sharedRoot(cwd);
    for (const p of missingForDeps) {
      try {
        const full = resolve(mainRoot, p), real = fs.realpathSync(full), rel = relative(mainRoot, real);
        if (seenDisk.has(real) || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) continue;
        const stat = fs.statSync(real);
        if (stat.isFile()) { inputs.push({ path: p, bytes: stat.size }); seenDisk.add(real); }
      } catch (error) { if (!['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
  }
  return { ok: true, input_bytes: inputs.reduce((n, f) => n + f.bytes, Buffer.byteLength(task)), inputs };
}

export function batchView(home: string, id: string, pane: string | null) {
  const header = readBatch(home, id);
  if (!header || !runVisible(header, pane)) return { ok: false, code: 'flow_not_found' };
  const { batch: b, items } = batchIndex(home, id);
  return { flow: id, state: b.state, reason: b.reason, scale: b.scale, totals: b.totals, failures: failuresByReason(items), items,
    result_index: join(batchDir(home, id), 'index.json') };
}
export async function controlBatch(home: string, pane: string | null, args: Args, owner = false) {
  const { batch: id, action } = args;
  if (!isBatchId(id) || !['resume','pause','stop','retry_failed'].includes(String(action)) || Object.keys(args).length !== 2) throw Error('invalid_arguments: batch action');
  const apply = () => {
    const { batch: b, items } = batchIndex(home, id);
    const applied = controlRun(b, action as Control, items.some(i => i.state === 'failed'));
    const now = Date.now();
    if (applied === 'stop') {
      for (const i of items) if (i.state === 'waiting') {
        i.state = 'cancelled'; // Manifest waiters have no queued jobs to close.
        if (i.pilot) b.pilot_changed_at = now;
        else b.pool_changed_at = now;
      }
    } else if (applied === 'retry_failed' || applied === 'resume') {
      if (applied === 'retry_failed') for (const i of items) if (i.state === 'failed') {
        (i.previous ??= []).push({ job: i.job, reason: i.reason });
        i.state = 'waiting'; delete i.job; delete i.reason; delete i.report_path; delete i.files;
        if (i.pilot) b.pilot_changed_at = now;
        else b.pool_changed_at = now;
      }
      if (b.steps?.items) b.steps.items.state = 'running';
    }
    saveBatch(home, b, items);
    return { ...b, applied };
  };
  return withAbstractLock('concurrency', home, () => batchLock(home, id, () => {
    const header = readBatch(home, id);
    if (!header || !(owner || runVisible(header, pane))) throw Error('flow_not_found');
    // An already-running pre-upgrade binary keeps its original mutex until it drains.
    return header.template ? apply() : withAbstractLock('batch-state', `${home}\0${id}`, apply);
  }), { timeoutMs: 10_000 });
}

/** The owner's panel key and `hud act`: the same control as `hud_create({batch, action})`, from any pane or directory.
 * `applied` is absent when the batch's state did not take the action. */
export async function controlBatchAsOwner(home: string, id: string, action: Control) {
  const b = await controlBatch(home, null, { batch: id, action }, true);
  wakeWorkflow(home, b);
  return b;
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
    const found = registry(cwd), roles = found.roles(), chain = roles.get(role);
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
    let browser = false;
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
      const places = chain.presets?.find(p => p.name === preset)?.run ?? chain.run;
      browser ||= places.some(place => place.harness === 'bro');
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
    const graph = loadGraph(fs.readFileSync(join(BUNDLED_ROOT, 'workflows/batch.toml'), 'utf8'), 'toml', {
      roles, bindings: { role, max_parallel: limit }, manifest: { role, count: n, bytes: b.scale.input_bytes.total, cap, browser },
    });
    const origin = procStat(process.pid);
    if (origin) b.origin_mcp = { pid: process.pid, start: origin.start };
    b.project_root = sharedRoot(cwd);
    b.template = 'batch'; b.host = 'detached'; b.cost = graph.cost; b.cost_reasons = graph.cost_reasons;
    b.steps = Object.fromEntries(Object.keys(graph.steps).map(id => [id, { state: 'waiting' }]));
    const dir = batchDir(home, flow);
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    freezeGraph(home, flow, graph);
    if ((role === 'imp' || role === 'frontend-imp') && shared.isolation === undefined) shared.isolation = 'worktree';
    writeJsonPrivate(join(dir, 'manifest.json'), { shared, items: inputs } satisfies Manifest);
    await batchLock(home, flow, () => saveBatch(home, b, inputs.map((i, k) => ({ item: k+1, state: 'waiting', preset: i.route.preset ?? null, pilot: i.pilot, brief_file: i.brief_file }))));
    return b;
  });
}
