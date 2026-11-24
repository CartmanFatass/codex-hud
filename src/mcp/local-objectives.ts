import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  OBJECTIVE_SLUG, OBJECTIVE_STATES, PROJECT_PRIORITIES, PROJECT_STANCES, inspectObjectives, objectiveFields,
  objectivePath, readObjectiveFile, splitObjectiveList, validEvidence, validFeature,
} from '../collectors/objectives.js';
import { STATE_BYTES } from '../collectors/state-ledger.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { writeFileAtomic } from '../utils/atomic-fs.js';
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
function edit(root: string, home: string, args: Record<string, unknown>) {
  const path = objectivePath(root), file = readObjectiveFile(path), original = file?.text ?? '';
  const parsed = inspectObjectives(original), eol = original.includes('\r\n') ? '\r\n' : '\n';
  const patches: { start: number; end: number; text: string }[] = [];
  const patch = ({ start, end }: { start: number; end: number }, text: string) => patches.push({ start, end, text });
  const insert = (start: number, text: string) => patch({ start, end: start }, text);
  let receipt: { project: string; id: string; title: string; change: Change; state: string } | undefined;

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
    const change: Change | undefined = !old ? 'created' : newState !== old.state ? 'state'
      : newTitle !== old.title ? 'title' : fields.Result && fields.Result !== old.result ? 'result' : undefined;
    if (change) receipt = { project: root, id, title: newTitle, change, state: newState };
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
      const prefix = !original || original.endsWith(eol + eol) ? '' : original.endsWith(eol) ? eol : eol + eol;
      insert(original.length, prefix + [`## ${id}: ${newTitle}`, ...missing, ''].join(eol));
    }
  } else invalid('op');

  const updated = patches.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((text, { start, end, text: replacement }) => text.slice(0, start) + replacement + text.slice(end), original);
  if (Buffer.byteLength(updated) > STATE_BYTES) throw new Error('Objective record exceeds 64 KiB');
  if (updated === original) return { ok: true, path, changed: false };
  const save = () => writeFileAtomic(path, updated, { mode: file?.mode });
  if (receipt) {
    // Like the job archive, retain one monthly append-only file with one small line per material change; no automatic pruning.
    const at = new Date().toISOString(), events = join(home, 'events');
    fs.mkdirSync(events, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(events).isDirectory()) throw new Error('Invalid events directory');
    const flags = fs.constants;
    const fd = fs.openSync(join(events, `${at.slice(0, 7)}.jsonl`), flags.O_WRONLY | flags.O_APPEND | flags.O_CREAT | flags.O_NOFOLLOW | flags.O_NONBLOCK, 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('Invalid events file');
      fs.fchmodSync(fd, 0o600);
      save();
      try { fs.appendFileSync(fd, JSON.stringify({ v: 1, kind: 'objective', ...receipt, at }) + '\n'); }
      catch (error) { throw new Error('Objective file edited, but its receipt could not be appended', { cause: error }); }
    } finally { fs.closeSync(fd); }
  } else save();
  return { ok: true, path, changed: true, ...(receipt && { change: receipt.change }) };
}

export function editObjectives(cwd: string, home: string, args: Record<string, unknown>) {
  const { root, registered } = registeredProject(home, cwd);
  if (!registered) throw new Error('hud_objective requires a registered project');
  return withAbstractLock('objective', root, () => edit(root, home, args));
}
