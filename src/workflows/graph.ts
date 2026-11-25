import TOML from '@iarna/toml';
import type { Role } from '../roles/roster.js';

export type Breaker = 'rate' | 'first' | 'none';
type Common = { needs: string[]; from: string[]; optional: boolean; when?: { step: string; is: string } };
type Brief = { task?: string; brief_file?: string };
type Work =
  | ({ kind: 'job'; role: string; isolation?: 'none' | 'worktree' } & Brief)
  | { kind: 'batch'; role: string; items?: Brief[]; manifest?: string; max_parallel?: number }
  | ({ kind: 'council' } & Brief)
  | { kind: 'land'; job: string }
  | { kind: 'check'; run?: string[]; use?: string }
  | { kind: 'handback'; ask: string; options: string[] };
export type Step = Common & Work;
export interface Graph { version: 1; name: string; policy: { breaker: Breaker }; steps: Record<string, Step>; cost: 'cheap' | 'costly'; cost_reasons: string[] }
interface Inputs {
  roles: ReadonlyMap<string, Pick<Role, 'run' | 'optionalEnabled'>>;
  bindings?: Record<string, unknown>;
  caps?: Readonly<Record<string, number>>;
  manifest?: { role: string; count: number; bytes: number; cap: number; browser?: boolean };
  // Callers planning file inputs must provide the same resolved byte estimate used for admission.
  inputBytes?: (item: Brief) => number;
}
const invalid = (message: string): never => { throw Error(`invalid_workflow: ${message}`); };
function object(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalid('expected table');
}
function keys(row: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(row)) if (!allowed.includes(k)) invalid(`unknown key ${k}`);
}
const text = (v: unknown): string => typeof v === 'string' && v.trim() ? v : invalid('expected nonempty string');
function list(v: unknown, limit: number, unique = true): string[] {
  if (!Array.isArray(v) || v.length > limit) return invalid(`expected list of at most ${limit}`);
  const values = v.map(text);
  if (unique && new Set(values).size !== values.length) invalid('duplicate list entry');
  return values;
}
function brief(row: Record<string, unknown>): Brief {
  if ((row.task === undefined) === (row.brief_file === undefined)) invalid('need task or brief_file');
  if (row.task === undefined) return { brief_file: text(row.brief_file) };
  const task = text(row.task);
  if (Buffer.byteLength(task) > 256 * 1024) invalid('task exceeds 256 KiB');
  return { task };
}
const fields = { job: ['role','task','brief_file','isolation'], batch: ['role','manifest','items','max_parallel'], council: ['task','brief_file'],
  land: ['job'], check: ['run','use'], handback: ['ask','options'] };
const identifier = /^[a-z][a-z0-9_-]{0,47}$/;
/** Only whole, typed parameter slots are substituted. Task prose and argv are never interpolated. */
export function loadGraph(source: unknown, format: 'toml' | 'json', inputs: Inputs): Graph {
  const raw = object(typeof source === 'string' ? (format === 'toml' ? TOML.parse(source) : JSON.parse(source)) : source);
  keys(raw, ['name','version','policy','steps']);
  const name = text(raw.name);
  if (raw.version !== 1 || !identifier.test(name)) invalid('name or version');
  const policy = object(raw.policy ?? {}); keys(policy, ['breaker']);
  const breaker = policy.breaker ?? 'rate';
  if (breaker !== 'rate' && breaker !== 'first' && breaker !== 'none') return invalid('breaker must be rate, first or none');
  const entries = Object.entries(object(raw.steps));
  if (!entries.length || entries.length > 32) invalid('expected 1–32 steps');
  const steps: Record<string, Step> = Object.create(null);
  const reasons: string[] = [];
  for (const [id, value] of entries) {
    if (!identifier.test(id) || Object.hasOwn(Object.prototype, id)) invalid(`bad step id ${id}`);
    const rawStep = object(value), kind = text(rawStep.kind);
    if (!Object.hasOwn(fields, kind)) invalid(`unknown kind ${kind}`);
    keys(rawStep, ['kind','needs','from','optional','when', ...fields[kind as keyof typeof fields]]);
    const row = { ...rawStep };
    for (const key of fields[kind as keyof typeof fields]) {
      const v = row[key], slot = typeof v === 'string' && /^\{([a-z][a-z0-9_]*)\}$/.exec(v);
      if (slot) row[key] = inputs.bindings && Object.hasOwn(inputs.bindings, slot[1]) ? inputs.bindings[slot[1]] : invalid(`missing parameter ${slot[1]}`);
    }
    const needs = list(row.needs ?? [], 32), from = list(row.from ?? [], 16);
    if (row.optional !== undefined && typeof row.optional !== 'boolean') invalid('optional must be boolean');
    const common: Common = { needs, from, optional: row.optional === true };
    if (row.when !== undefined) {
      const w = object(row.when); keys(w, ['step','is']); common.when = { step: text(w.step), is: text(w.is) };
    }
    let work: Work;
    if (kind === 'batch' || kind === 'job') {
      const role = text(row.role), chain = inputs.roles.get(role);
      if (!chain || chain.optionalEnabled === false || role === 'council') return invalid(`unknown or disabled ordinary role ${role}`);
      if (role === 'pro' || role === 'flow') reasons.push(`${id}: ${role} role`);
      const browser = kind === 'batch' && row.manifest ? inputs.manifest?.browser : undefined;
      if (browser ?? chain.run.some(p => p.harness === 'bro')) reasons.push(`${id}: browser place`);
      if (kind === 'job') {
        const isolation = row.isolation;
        if (isolation !== undefined && isolation !== 'none' && isolation !== 'worktree') return invalid('job isolation');
        work = { kind, role, ...brief(row), isolation };
      } else {
        const max = row.max_parallel;
        if (max !== undefined && (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1)) invalid('max_parallel');
        const cap = row.manifest === undefined ? inputs.caps?.[role] : inputs.manifest?.cap;
        if (cap && (cap < 3 || (max !== undefined && Number(max) > cap - 2))) invalid('reserved slots');
        work = { kind, role, max_parallel: max as number | undefined };
        let count: number, bytes: number;
        if (row.manifest !== undefined) {
          const m = inputs.manifest;
          if (row.items !== undefined || row.manifest !== 'manifest.json' || !m || role !== m.role) return invalid('unbound manifest');
          ({ count, bytes } = m); work.manifest = 'manifest.json';
        } else {
          if (!Array.isArray(row.items) || !row.items.length || row.items.length > 512) return invalid('expected 1–512 items');
          work.items = row.items.map(v => { const item = object(v); keys(item, ['task','brief_file']); return brief(item); });
          count = work.items.length;
          bytes = work.items.reduce((n, i) => n + (inputs.inputBytes?.(i) ?? (i.task ? Buffer.byteLength(i.task) : invalid('unresolved file input'))), 0);
        }
        if (!Number.isInteger(count) || count < 1 || count > 512 || !Number.isSafeInteger(bytes) || bytes < 0) invalid('fan-out limits');
        if (count > (role === 'sonic' ? 50 : 12)) reasons.push(`${id}: ${count} ${role} items`);
        if (role === 'sonic' && bytes > 2 * 1024 ** 2) reasons.push(`${id}: ${bytes} Sonic input bytes`);
      }
    } else if (kind === 'council') {
      const council = inputs.roles.get('council');
      if (!council || council.optionalEnabled === false) invalid('unknown or disabled council');
      reasons.push(`${id}: council`); work = { kind, ...brief(row) };
    }
    else if (kind === 'check') {
      if ((row.run === undefined) === (row.use === undefined)) invalid('need argv run or named use');
      work = row.run === undefined ? { kind, use: text(row.use) } : { kind, run: list(row.run, 64, false) };
      if (work.run?.length === 0 || (work.use && !identifier.test(work.use))) invalid('expected argv or a named command');
    } else if (kind === 'land') work = { kind, job: text(row.job) };
    else {
      const options = list(row.options, 6), ask = text(row.ask);
      if (options.length < 2 || options.some(o => !identifier.test(o)) || ask.length > 300) invalid('handback question/options');
      work = { kind: 'handback', ask, options };
    }
    steps[id] = { ...common, ...work };
  }
  const visiting = new Set<string>(), ancestors = new Map<string, Set<string>>();
  function visit(id: string): Set<string> {
    const prior = ancestors.get(id); if (prior) return prior;
    if (!steps[id]) return invalid(`unknown prerequisite ${id}`);
    if (visiting.has(id)) return invalid(`cycle at ${id}`);
    visiting.add(id); const all = new Set(steps[id].needs);
    for (const p of steps[id].needs) for (const a of visit(p)) all.add(a);
    visiting.delete(id); ancestors.set(id, all); return all;
  }
  for (const [id, step] of Object.entries(steps)) {
    const all = visit(id);
    for (const ref of [...step.from, ...(step.kind === 'land' ? [step.job] : [])]) if (!all.has(ref)) invalid(`${ref} is not an ancestor of ${id}`);
    if (step.kind === 'land') {
      const source = steps[step.job];
      if (source.kind !== 'job' || source.isolation !== 'worktree') invalid('land requires a worktree job');
    }
    if (step.when) {
      const parent = steps[step.when.step];
      if (!all.has(step.when.step) || parent?.kind !== 'handback' || !parent.options.includes(step.when.is)) invalid(`invalid branch at ${id}`);
    }
  }
  // DFS insertion order is topological; independent ties retain declaration order.
  return { version: 1, name, policy: { breaker }, steps: Object.fromEntries([...ancestors.keys()].map(id => [id, steps[id]])), cost: reasons.length ? 'costly' : 'cheap', cost_reasons: reasons };
}
