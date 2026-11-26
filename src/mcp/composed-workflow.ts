import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { capForRole, loadConcurrencySettings } from '../roles/concurrency.js';
import { registeredProject, sharedRoot } from '../roles/projects.js';
import { readFileBounded } from '../utils/atomic-fs.js';
import { procStat } from '../utils/proc.js';
import { hashComposedGraph, isComposedId, proposalFresh, readComposed, readComposedGraph, validPlanHash, workflowGrants,
  type ComposedGraph, type ComposedRun, type Scale } from '../workflows/composed-state.js';
import { controlRun, type Control } from '../workflows/engine.js';
import { checkArgv, loadGraph } from '../workflows/graph.js';
import { runVisible } from '../workflows/scope.js';
import { freezeGraph, runLock, saveHeader } from '../workflows/store.js';
import { wakeWorkflow } from '../workflows/wake.js';
import { inputBytes } from './batch.js';
import { jobCwd, required, type Args } from './dispatch/context.js';
import { registry } from './dispatch/places.js';
import { prepareCouncil } from './dispatch/council.js';
import { workspaceFromPaneId } from './dispatch/proc.js';
import type { Job } from './job-contracts.js';

const reserved = new Set(['batch', 'prewalk', 'land', 'council', 'ticket-queue']);
const MAX_PLAN_BYTES = 8 * 1024 ** 2;
const notFound = { ok: false, code: 'flow_not_found' } as const;
const invalid = (reason: string): never => { throw Error(`invalid_workflow: ${reason}`); };
function inside(base: string, path: string) {
  const real = fs.realpathSync(path), rel = relative(base, real);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) invalid('file resolves outside its root');
  return real;
}
function readText(path: string, limit: number) {
  const { bytes, truncated } = readFileBounded(path, limit);
  if (truncated) invalid('input file too large');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
function templateText(home: string, root: string, name: string): string {
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name) || reserved.has(name)) return invalid('invalid or reserved template name (use its fixed tool for a shipped flow)');
  const gate = registeredProject(home, root);
  for (const base of [...(gate.registered ? [gate.hud_dir] : []), home]) {
    try { return readText(inside(base === gate.hud_dir ? root : fs.realpathSync(home), join(base, 'workflows', `${name}.toml`)), MAX_PLAN_BYTES); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return invalid(`template not found: ${name}`);
}

function plan(home: string, args: Args, cwd: string, root: string): ComposedGraph {
  if ((args.graph === undefined) === (args.template === undefined)) invalid('provide graph or template');
  if (typeof args.graph === 'string' && Buffer.byteLength(args.graph) > MAX_PLAN_BYTES) invalid('graph too large');
  const source = args.template === undefined ? args.graph : templateText(home, root, required(args, 'template'));
  if (args.params !== undefined && (!args.params || typeof args.params !== 'object' || Array.isArray(args.params))) invalid('params must be an object');
  const found = registry(cwd), roles = found.roles(true), settings = loadConcurrencySettings();
  const caps = Object.fromEntries([...roles.keys()].map(role => [role, capForRole(settings, role)]));
  const files = new Map<string, string>();
  type Brief = { task?: string; brief_file?: string };
  const task = (item: Brief): string => {
    if (item.task !== undefined) return item.task;
    const name = item.brief_file!;
    let text = files.get(name);
    if (text !== undefined) return text;
    text = readText(inside(cwd, resolve(cwd, name)), 256 * 1024);
    if (!text.trim() || /[\x00-\x08\x0e-\x1f\x7f]/.test(text)) invalid('brief_file must be a nonempty text file');
    files.set(name, text);
    return text;
  };
  const bytes = (item: Brief) => inputBytes(cwd, task(item), item.brief_file, []).input_bytes;
  const graph = loadGraph(source, args.template === undefined ? 'json' : 'toml', { roles, caps, composed: true,
    bindings: args.params as Args | undefined, inputBytes: bytes });
  if (reserved.has(graph.name)) invalid('shipped workflow names are reserved');
  const scale: Scale = {};
  for (const [key, step] of Object.entries(graph.steps)) {
    if (step.kind === 'job' || step.kind === 'council') {
      const role = step.kind === 'job' ? step.role : 'council';
      let count = 1;
      if (step.kind === 'council') {
        const council = prepareCouncil({}, roles.get(role)!, found, roles, found.routing());
        if ('code' in council) return invalid(council.reason);
        step.members = council.members.map(seat => seat.preset);
        step.synthesizer = council.synthesizer === 'main' ? 'main' : council.synthesizer.preset;
        count = step.members.length + Number(step.synthesizer !== 'main');
      }
      scale[key] = { role, count, input_bytes: bytes(step) };
      step.task = task(step); delete step.brief_file;
    } else if (step.kind === 'batch') {
      const items = step.items!;
      const cap = caps[step.role];
      step.max_parallel = Math.min(items.length, step.max_parallel ?? (cap ? cap - 2 : items.length));
      scale[key] = { role: step.role, count: items.length, input_bytes: items.reduce((sum, i) => sum + bytes(i), 0), max_parallel: step.max_parallel };
      step.items = items.map(item => ({ task: task(item) }));
    } else if (step.kind === 'check' && step.use) {
      if (!registeredProject(home, root).registered) invalid('named check requires a registered project');
      const config = JSON.parse(readText(inside(root, join(root, '.hud/project.json')), 256 * 1024));
      if (!config.commands || !Object.hasOwn(config.commands, step.use)) invalid(`unknown check command ${step.use}`);
      step.run = checkArgv(config.commands[step.use]);
    } else if (step.kind === 'handback' && step.to !== 'main') scale[key] = { role: 'lead', count: 1, input_bytes: 0 };
  }
  const frozen = { ...graph, scale };
  if (Buffer.byteLength(JSON.stringify(frozen)) > MAX_PLAN_BYTES) invalid('frozen graph too large');
  return frozen;
}

function view(run: ComposedRun, graph: ComposedGraph) {
  return { run: run.flow, state: run.state, hash: run.hash, cwd: run.cwd, cost: run.cost, cost_reasons: graph.cost_reasons,
    scale: graph.scale, steps: run.steps, handback: run.handback, answers: run.answers, reason: run.reason };
}

export async function callWorkflow(home: string, pane: string | null, args: Args, dispatcher?: Job['dispatcher']) {
  const allowed: Record<string, string[]> = { plan: ['cwd', 'graph', 'template', 'params'], start: ['run', 'hash', 'confirm'], status: ['run'], control: ['run', 'action'] };
  if (typeof args.op !== 'string' || !Object.hasOwn(allowed, args.op) || Object.keys(args).some(k => k !== 'op' && !allowed[args.op as string].includes(k)))
    throw Error('invalid_arguments: workflow operation or arguments');
  if (args.op === 'plan') {
    const cwd = fs.realpathSync(jobCwd(args)), root = sharedRoot(cwd), graph = plan(home, args, cwd, root);
    const flow = `w${randomBytes(8).toString('hex')}`, origin = procStat(process.pid);
    const run: ComposedRun = { flow, pane: pane ?? '', cwd, project_root: root, ...(origin && { origin_mcp: { pid: process.pid, start: origin.start } }), dispatcher,
      workspace: workspaceFromPaneId(pane),
      template: 'composed', hash: hashComposedGraph(cwd, graph), cost: graph.cost, created_at: new Date().toISOString(), state: 'proposed',
      epoch: 0, streak: 0, failures: 0, settled: 0, notices: {}, answers: {}, steps: Object.fromEntries(Object.keys(graph.steps).map(id => [id, { state: 'waiting' }])) };
    await runLock(home, flow, () => { freezeGraph(home, flow, graph); saveHeader(home, run, true); });
    return { ...view(run, graph), plan: graph };
  }
  const id = args.run;
  if (!isComposedId(id)) throw Error('invalid_arguments: workflow run id');
  const outcome = await runLock(home, id, async () => {
    const run = readComposed(home, id);
    if (!run || !runVisible(run, pane)) return { value: notFound };
    const graph = readComposedGraph(home, id);
    if (run.hash !== hashComposedGraph(run.cwd, graph) || run.cost !== graph.cost) return { value: { ok: false, code: 'workflow_plan_changed' } };
    if (args.op === 'start') {
      if (args.confirm !== true || !validPlanHash(args.hash) || args.hash !== run.hash) return { value: { ok: false, code: 'workflow_confirmation_required' } };
      if (run.state === 'proposed') {
        if (!proposalFresh(run)) return { value: { ok: false, code: 'workflow_plan_expired' } };
        if (run.cost === 'costly') {
          const grant = await workflowGrants.reserve(home, id, { run: id, hash: run.hash });
          if (!grant) return { value: { ok: false, code: 'owner_grant_required', reason: `Ask the owner to run hud workflow allow ${id} ${run.hash}` } };
          run.grant = grant;
        }
        run.state = 'working'; saveHeader(home, run);
      }
    } else if (args.op === 'control') {
      const action = args.action as Control;
      if (!['pause', 'resume', 'stop', 'retry_failed'].includes(action)) throw Error('invalid_arguments: workflow action');
      if ((action === 'resume' || action === 'retry_failed') && run.handback?.request_id) return { value: { ok: false, code: 'handback_answer_required' } };
      const failed = Object.entries(run.steps).filter(([, c]) => c.state === 'failed');
      const retryable = failed.length > 0 && ['paused', 'completed'].includes(run.state);
      if (action === 'retry_failed' && retryable && failed.some(([key]) => graph.steps[key].kind === 'land'))
        return { value: { ok: false, code: 'sealed_land_not_replayable' } };
      if (controlRun(run, action, retryable)) {
        if (action === 'retry_failed') for (const [key, c] of failed) {
          run.steps[key] = { state: 'waiting', attempt: (c.attempt ?? 0) + 1, ...(c.repairs && { repairs: c.repairs }),
            ...(c.items && { items: c.items.map(i => i.state === 'done' ? i : { state: 'waiting', attempt: i.attempt + 1 }) }) };
        }
        if (run.state === 'stopped') {
          for (const c of Object.values(run.steps)) if (c.state === 'asking') c.state = 'cancelled';
          run.notices[`end-${run.epoch}`] = `${id} workflow stopped`;
          if (run.grant && !run.input_admitted) await workflowGrants.releaseUnused(home, id);
        }
        saveHeader(home, run);
      }
    }
    return { run, value: view(run, graph) };
  });
  if (outcome.run) wakeWorkflow(home, outcome.run);
  return outcome.value;
}

export async function answerComposed(home: string, pane: string | null, args: Args) {
  const id = required(args, 'job'), request = required(args, 'request_id'), answer = required(args, 'answer');
  const outcome = await runLock(home, id, () => {
    const run = readComposed(home, id);
    if (!run || !runVisible(run, pane)) return { value: notFound };
    if (Object.hasOwn(run.answers, request)) return { value: { ok: true, written: false, answer: run.answers[request] } };
    const h = run.handback;
    if (run.state !== 'paused' || h?.request_id !== request || run.steps[h.step]?.state !== 'asking')
      return { value: { ok: false, code: 'question_not_open' } };
    if (!h.choices.includes(answer)) return { value: { ok: false, code: 'invalid_answer', choices: h.choices } };
    run.answers[request] = answer; run.steps[h.step].answer = answer; run.steps[h.step].state = 'done';
    delete run.handback; delete run.reason; run.state = 'working'; saveHeader(home, run);
    return { run, value: { ok: true, written: true, answer } };
  });
  if (outcome.run) wakeWorkflow(home, outcome.run);
  return outcome.value;
}
