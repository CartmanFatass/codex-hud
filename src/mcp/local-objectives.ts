import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  OBJECTIVE_SLUG, OBJECTIVE_STATES, PROJECT_PRIORITIES, PROJECT_STANCES, inspectObjectives, objectiveFields,
  objectivePath, readObjectiveFile, readObjectives, resultDigest, resultExcerpt, splitObjectiveList, validEvidence, validFeature,
} from '../collectors/objectives.js';
import { STATE_BYTES, WAITING_HEADING, requestFields, stateBulletSpans, statePaths, stateSection } from '../collectors/state-ledger.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { readDirSafe, readFileBounded, writeFileAtomic } from '../utils/atomic-fs.js';
import { registeredProject } from '../roles/projects.js';

function invalid(field: string): never { throw new Error(`invalid_arguments: ${field}`); }
function choice<T extends string>(args: Record<string, unknown>, field: string, choices: readonly T[]): T | undefined {
  return args[field] === undefined ? undefined : choices.find((value) => value === args[field]) ?? invalid(field);
}
function line(value: unknown, field: string): string {
  if (typeof value !== 'string' || /[\p{Surrogate}\x00-\x08\x0a-\x1f\x7f\u2028\u2029]/u.test(value)) return invalid(field);
  return value.trim();
}
function list(value: unknown, field: string, valid: (item: string) => boolean) {
  if (!Array.isArray(value)) return invalid(field);
  return Array.from(value, (raw) => {
    const item = line(raw, field);
    return item.includes(',') || !valid(item) ? invalid(field) : item;
  }).join(', ');
}

type Change = 'created' | 'state' | 'title' | 'result';
function planEdit(original: string, args: Record<string, unknown>) {
  const parsed = inspectObjectives(original), eol = original.includes('\r\n') ? '\r\n' : '\n';
  const patches: { start: number; end: number; text: string }[] = [];
  const patch = ({ start, end }: { start: number; end: number }, text: string) => patches.push({ start, end, text });
  const insert = (start: number, text: string) => patch({ start, end: start }, text);
  let receipt: { id: string; title: string; change: Change; state: string; result?: string; resultDigest?: string } | undefined;

  if (args.op === 'project') {
    if (Object.keys(args).some((key) => !['op', 'cwd', 'stance', 'priority'].includes(key))) invalid('project fields');
    const stance = choice(args, 'stance', PROJECT_STANCES), priority = choice(args, 'priority', PROJECT_PRIORITIES);
    if (!stance && !priority) invalid('stance or priority');
    if (parsed.badHeader) throw new Error('Fix the malformed project stance/priority header before editing it');
    if (!parsed.header) {
      const start = original.startsWith('\uFEFF') ? 1 : 0;
      insert(start, [stance && `**Stance:** ${stance}`, priority && `**Priority:** ${priority}`].filter(Boolean).join(' · ')
        + eol.repeat(original.length > start ? 2 : 1));
    } else {
      if (stance && parsed.stance) patch(parsed.stance, stance);
      else if (stance) insert(parsed.header.start, `**Stance:** ${stance} · `);
      if (priority && parsed.priority) patch(parsed.priority, priority);
      else if (priority) insert(parsed.stance!.end, ` · **Priority:** ${priority}`);
    }
  } else if (args.op === 'set') {
    const names = ['op', 'cwd', 'id', 'title', ...objectiveFields.map((field) => field.toLowerCase())];
    if (Object.keys(args).some((key) => !names.includes(key))) invalid('set fields');
    const { id } = args;
    if (typeof id !== 'string' || !new RegExp(OBJECTIVE_SLUG).test(id)) return invalid('id');
    const matches = parsed.sections.filter((section) => section.id === id), [section] = matches;
    if (matches.length > 1 || (section && !section.objective)) throw new Error(`Cannot edit malformed or duplicate Objective: ${id}`);
    const old = section?.objective;
    const title = args.title === undefined ? undefined : line(args.title, 'title') || invalid('title');
    const state = choice(args, 'state', OBJECTIVE_STATES);
    const fields = {
      State: state,
      Next: args.next === undefined ? undefined : line(args.next, 'next'),
      Result: args.result === undefined ? undefined : line(args.result, 'result'),
      Evidence: args.evidence === undefined ? undefined : list(args.evidence, 'evidence', validEvidence),
      Features: args.features === undefined ? undefined : list(args.features, 'features', validFeature),
    };
    if (title === undefined && Object.values(fields).every((value) => value === undefined)) invalid('set requires a field');
    const newTitle = title ?? old?.title ?? invalid('title required on creation');
    const newState = state ?? old?.state ?? invalid('state required on creation');
    const result = fields.Result, resultChanged = result !== undefined && result !== (old?.result ?? '');
    const change: Change | undefined = !old ? 'created' : newState !== old.state ? 'state'
      : newTitle !== old.title ? 'title' : resultChanged ? 'result' : undefined;
    if (change) receipt = { id, title: newTitle, change, state: newState,
      ...(resultChanged && { result: resultExcerpt(result), resultDigest: resultDigest(result) }) };
    const missing: string[] = [];
    for (const key of objectiveFields) {
      const value = fields[key], existing = section?.fields[key];
      if (value === undefined) continue;
      if (!existing) { if (value) missing.push(`**${key}:** ${value}`); }
      else if (value !== existing.value && (!(key === 'Features' || key === 'Evidence') || splitObjectiveList(existing.value).join(', ') !== value))
        patch(existing, value && original[existing.start - 1] === '*' ? ` ${value}` : value);
    }
    if (section) {
      if (title !== undefined && title !== old?.title) {
        const span = section.title!;
        patch(span, original[span.start - 1] === ':' ? ` ${title}` : title);
      }
      if (missing.length) insert(section.afterHeading, eol + missing.join(eol) + (original.length === section.afterHeading ? eol : ''));
    } else {
      const prefix = !original || original === '\uFEFF' || original.endsWith(eol + eol) ? '' : original.endsWith(eol) ? eol : eol + eol;
      insert(original.length, prefix + [`## ${id}: ${newTitle}`, '', ...missing, ''].join(eol));
    }
  } else invalid('op');

  const updated = patches.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((text, { start, end, text: replacement }) => text.slice(0, start) + replacement + text.slice(end), original);
  if (Buffer.byteLength(updated) > STATE_BYTES) throw new Error('Objective record exceeds 64 KiB');
  return { updated, receipt };
}

function edit(root: string, home: string, args: Record<string, unknown>) {
  const path = objectivePath(root), file = readObjectiveFile(path), original = file?.text ?? '';
  const { updated, receipt } = planEdit(original, args);
  if (updated === original) return { ok: true, path, changed: false };
  const save = () => writeFileAtomic(path, updated, { mode: file?.mode });
  if (receipt) {
    const event = { kind: 'objective', project: root, ...receipt, at: new Date().toISOString() };
    saveWithReceipt(home, event, save);
  }
  else save();
  return { ok: true, path, changed: true, ...(receipt && { change: receipt.change }) };
}

function checkedDirectory(path: string) {
  const stat = fs.lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Error(`Not a directory: ${path}`);
}

function saveWithReceipt(home: string, event: { kind: string; at: string }, save: () => void) {
  // One small append-only line per material change, in the existing monthly archive.
  const events = join(home, 'events');
  fs.mkdirSync(events, { recursive: true, mode: 0o700 });
  checkedDirectory(events);
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(join(events, `${event.at.slice(0, 7)}.jsonl`), O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Invalid events file');
    fs.fchmodSync(fd, 0o600);
    save();
    try { fs.appendFileSync(fd, JSON.stringify({ v: 1, ...event }) + '\n'); }
    catch (error) { throw new Error(`${event.kind} file edited, but its receipt could not be appended`, { cause: error }); }
  } finally { fs.closeSync(fd); }
}

function readState(root: string) {
  const paths = statePaths(root);
  checkedDirectory(join(root, 'docs'));
  checkedDirectory(join(root, 'docs/handoff'));
  for (const path of paths) {
    try {
      const { bytes, stat, truncated } = readFileBounded(path, STATE_BYTES);
      if (truncated) throw new Error('STATE exceeds 64 KiB');
      return { path, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), mode: stat.mode & 0o777 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { path: paths[0], text: '' };
}

const REQUEST_ID = /^r\d+$/;
function higherId(max: bigint, id: unknown) {
  const n = typeof id === 'string' && REQUEST_ID.test(id) ? BigInt(id.slice(1)) : 0n;
  return n > max ? n : max;
}
async function lastRecordedRequest(root: string, home: string) {
  let max = 0n;
  const events = join(home, 'events');
  checkedDirectory(events);
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  for (const name of readDirSafe(events).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))) {
    const file = await fs.promises.open(join(events, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error('Invalid events file');
      for await (const row of file.readLines({ autoClose: false })) {
        let event;
        try { event = JSON.parse(row); } catch { continue; }
        if (event?.v === 1 && event.kind === 'request' && event.project === root) max = higherId(max, event.request);
      }
    } finally { await file.close(); }
  }
  return max;
}

function opening(root: string, args: Record<string, unknown>) {
  if (Object.keys(args).some((key) => !['op', 'cwd', 'text', 'objective', 'waits'].includes(key))) invalid('request fields');
  const body = line(args.text, 'text') || invalid('text');
  const fields = requestFields(`[r1] ${body}`)!;
  if (fields.objective || fields.waits) invalid('use objective or waits fields instead of markers in text');
  const objective = args.objective === undefined ? undefined
    : readObjectives(root)?.objectives.find(({ id }) => id === args.objective)?.id ?? invalid('unknown objective');
  if (args.waits !== undefined && typeof args.waits !== 'boolean') invalid('waits');
  return { body, objective, waits: args.waits === true };
}

export interface RequestCaller { harness?: 'agy' | 'claude' | 'codex' | 'pi'; session?: string }
async function editRequest(root: string, home: string, args: Record<string, unknown>, by: RequestCaller) {
  const open = args.op === 'request' ? opening(root, args) : undefined;
  let max = open ? await lastRecordedRequest(root, home) : 0n;
  const { path, text, mode } = readState(root), section = stateSection(text, WAITING_HEADING);
  const at = new Date().toISOString();
  let updated: string, request: string, objective: string | undefined, waits: boolean, note: string | undefined;
  let change: 'opened' | 'resolved' | 'withdrawn';
  if (open) {
    const { body } = open;
    ({ objective, waits } = open);
    for (const match of text.matchAll(/\[(r\d+)\]/g)) max = higherId(max, match[1]);
    request = `r${max + 1n}`;
    change = 'opened';
    const eol = /\r?\n/.exec(text)?.[0] ?? '\n';
    const bullet = `- ${at.slice(0, 10)} [${request}] ${body}${objective ? ` (objective ${objective})` : ''}${waits ? ' (work waits)' : ''}`;
    if (!section) updated = text + (text ? (text.endsWith('\n') ? eol : eol + eol) : '') + `## ${WAITING_HEADING}${eol}${eol}${bullet}${eol}`;
    else {
      // Insert before trailing blank lines; don't change an existing line ending, even at EOF.
      let pos = section.end;
      while (pos > section.start) {
        const start = Math.max(section.start, text.lastIndexOf('\n', pos - 2) + 1);
        if (!/^[ \t]*\r?\n?$/.test(text.slice(start, pos))) break;
        pos = start;
      }
      const insertion = text[pos - 1] === '\n' ? bullet + eol : eol + bullet;
      updated = text.slice(0, pos) + insertion + text.slice(pos);
    }
  } else {
    if (Object.keys(args).some((key) => !['op', 'cwd', 'request', 'resolution', 'note'].includes(key))) invalid('resolve fields');
    request = typeof args.request === 'string' && REQUEST_ID.test(args.request) ? args.request : invalid('request');
    change = choice(args, 'resolution', ['resolved', 'withdrawn']) ?? 'resolved';
    note = args.note === undefined ? undefined : line(args.note, 'note');
    const matches = (section ? stateBulletSpans(text, section) : [])
      .map((span) => ({ ...span, fields: requestFields(span.text) })).filter(({ fields }) => fields?.request === request);
    if (matches.length !== 1) invalid('unknown or duplicate request');
    const { start, end, fields } = matches[0];
    ({ objective, waits } = fields!);
    const last = end - (/(?:\r?\n[ \t]+)+$/.exec(text.slice(start, end))?.[0].length ?? 0);
    const after = /^(?:\r?\n)/.exec(text.slice(last))?.[0].length ?? 0;
    const before = last === text.length ? /\r?\n$/.exec(text.slice(0, start))?.[0].length ?? 0 : 0;
    updated = text.slice(0, start - before) + text.slice(last + after);
  }
  if (Buffer.byteLength(updated) > STATE_BYTES) throw new Error('STATE exceeds 64 KiB');
  const event = { kind: 'request', project: root, request, objective, waits, change, at, by, note };
  saveWithReceipt(home, event, () => writeFileAtomic(path, updated, { mode }));
  return { ok: true, path, changed: true, request, change };
}

export const withObjectiveLock = <T>(root: string, fn: () => T | Promise<T>) => withAbstractLock('objective', root, fn);

export type ObjectiveFileInput = { text: string; mode?: number } | null;

/** Plan all ticket links using the same Features editor as `set`. Caller holds the objective lock. */
export function planFeatureLinks(
  root: string,
  links: ReadonlyMap<string, ReadonlySet<string>>,
  archives: ReadonlyMap<string, ReadonlySet<string>>,
  objectiveFile?: ObjectiveFileInput,
) {
  if (!links.size && !archives.size) return;
  const file = objectiveFile === undefined ? readObjectiveFile(objectivePath(root)) : objectiveFile ?? undefined;
  const original = file?.text ?? '';
  const { objectives } = inspectObjectives(original).record;
  let updated = original;
  for (const id of links.keys()) if (!objectives.some(item => item.id === id)) invalid('unknown objective');
  for (const { id, features } of objectives) {
    const all = new Set([...features, ...(links.get(id) ?? [])]);
    for (const [archive, owners] of archives) if (owners.has(id)) all.add(archive);
    if (all.size !== new Set(features).size) updated = planEdit(updated, { op: 'set', id, features: [...all] }).updated;
  }
  if (updated !== original) return { bytes: updated, mode: file?.mode };
}

export function editObjectives(cwd: string, home: string, args: Record<string, unknown>, by: RequestCaller = {}) {
  const { root, registered } = registeredProject(home, cwd);
  if (!registered) throw new Error('hud_objective requires a registered project');
  return withObjectiveLock(root, async () => args.op === 'request' || args.op === 'resolve'
    ? editRequest(root, home, args, by) : edit(root, home, args));
}
