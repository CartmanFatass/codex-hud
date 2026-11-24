import { lstatSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import { STATE_BYTES } from './state-ledger.js';

export const OBJECTIVE_STATES = ['active', 'paused', 'done'] as const;
export const PROJECT_STANCES = ['active', 'paused', 'maintenance'] as const;
export const PROJECT_PRIORITIES = ['high', 'normal', 'low'] as const;
export const OBJECTIVE_SLUG = '^[a-z0-9-]+$';
export const FEATURE_SLUG = '^[a-z0-9][a-z0-9_-]*$';
export const objectiveFields = ['State', 'Next', 'Result', 'Evidence', 'Features'] as const;
type Field = typeof objectiveFields[number];
export type ObjectiveState = typeof OBJECTIVE_STATES[number];
export interface Objective {
  id: string; title: string; state: ObjectiveState;
  next?: string; result?: string; evidence: string[]; features: string[];
  unknownFields: string[];
}
export type ObjectiveLink = Pick<Objective, 'id' | 'title'>;

/** Project only the two snapshot fields from a stored receipt. */
export function objectiveLink(value: unknown): ObjectiveLink | undefined {
  if (!value || typeof value !== 'object') return;
  const { id, title } = value as Partial<ObjectiveLink>;
  if (typeof id === 'string' && id && typeof title === 'string' && title) return { id, title };
}

export interface ObjectiveRecord {
  stance: typeof PROJECT_STANCES[number] | 'unknown';
  priority: typeof PROJECT_PRIORITIES[number];
  objectives: Objective[];
  diagnostics: string[];
}
export const objectivePath = (root: string) => join(root, '.hud', 'objectives.md');
export const resultExcerpt = (text: string) => text.slice(0, 240);
const featureSlug = new RegExp(FEATURE_SLUG);
export const validFeature = (s: string) => featureSlug.test(s);
export const OBJECTIVE_HASH = /^[a-f0-9]{7,64}$/i;
const urlScheme = /^[a-z][a-z0-9+.-]*:/i;
const jobReport = /\/jobs\/j[0-9a-f]{16}\/report\.md$/;
const hudPrefix = '$HUD_HOME';
export const validEvidence = (s: string) => !!s && !/[\x00-\x1f\x7f-\x9f]/.test(s) && (
  urlScheme.test(s) ? URL.canParse(s) && !/^[a-z]:[/\\]/i.test(s)
    : !s.split(/[/\\]/).includes('..') && (!/^[/\\]/.test(s) || (isAbsolute(s) && jobReport.test(s)))
);

export interface ObjectiveEvidence { text: string; file?: string; commit?: string; status?: 'missing' | 'Unavailable' }
function objectiveEvidence(text: string, root: string, home: string): ObjectiveEvidence {
  if (!validEvidence(text) || urlScheme.test(text)) return { text };
  if (OBJECTIVE_HASH.test(text)) return { text, commit: text };
  const report = jobReport.exec(text)?.[0], hudRelative = report && text === hudPrefix + report;
  if (isAbsolute(text) || hudRelative) {
    const file = report && resolve(home, '.' + report);
    return file && (hudRelative || resolve(text) === file) ? { text, file } : { text, status: 'Unavailable' };
  }
  return { text, file: resolve(root, text) };
}

/** Probe just the opened Objective's entries, never the whole portfolio or during paint. */
export function collectObjectiveEvidence(objective: Objective, root: string, home: string): ObjectiveEvidence[] {
  return objective.evidence.map((text) => {
    const entry = objectiveEvidence(text, root, home);
    if (!entry.file) return entry;
    try {
      if (statSync(entry.file).isFile()) return entry;
    } catch (err) {
      if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return { text, status: 'missing' };
    }
    return { text, status: 'Unavailable' };
  });
}
export const splitObjectiveList = (s = '') => s === '' ? [] : s.split(',').map((value) => value.trim());

interface Slot { start: number; end: number; value: string }
interface Section {
  id?: string; title?: Slot; afterHeading: number;
  fields: Partial<Record<Field, Slot>>; objective?: Objective;
}
const slot = (text: string, [start, end]: [number, number], offset = 0): Slot =>
  ({ start: start + offset, end: end + offset, value: text.slice(start + offset, end + offset) });
const valueSlot = (text: string, span: [number, number], offset?: number): Slot => {
  const { start, value } = slot(text, span, offset), trimmed = value.trimEnd();
  return { start, end: start + trimmed.length, value: trimmed };
};
const member = <T extends string>(values: readonly T[], value: string | undefined) => values.find((v) => v === value);

/** Inspect once for both display and editing; ranges are UTF-16 offsets into the original text. */
export function inspectObjectives(text: string) {
  const record: ObjectiveRecord = { stance: 'unknown', priority: 'normal', objectives: [], diagnostics: [] };
  const headings = [...text.matchAll(/^##(?=[ \t]|\r?$)[^\r\n]*/gm)];
  const preamble = text.slice(0, headings[0]?.index ?? text.length);
  const headers = [...preamble.matchAll(/^\uFEFF?(\*\*(?:Stance|Priority):\*\*[^\r\n]*)/dgm)];
  const header = headers[0] && slot(text, headers[0].indices![1]!);
  const values = header?.value.match(/^(?:\*\*Stance:\*\*[ \t]*(\S+?)(?:[ \t]*·[ \t]*\*\*Priority:\*\*[ \t]*(\S+))?|\*\*Priority:\*\*[ \t]*(\S+))[ \t]*$/d);
  const stance = member(PROJECT_STANCES, values?.[1]), priority = member(PROJECT_PRIORITIES, values?.[2] ?? values?.[3]);
  const badHeader = !!header && (headers.length !== 1 || !values || (!!values[1] && !stance) || (!!(values[2] ?? values[3]) && !priority));
  if (badHeader) record.diagnostics.push('Invalid project stance/priority header');
  else { record.stance = stance ?? 'unknown'; record.priority = priority ?? 'normal'; }

  const ids = new Set<string>(), duplicates = new Set<string>();
  const sections = headings.map((heading, i): Section => {
    const end = heading.index! + heading[0].length;
    const match = /^##[ \t]+([a-z0-9-]+):[ \t]*([^\r\n]*)$/d.exec(heading[0]);
    const section: Section = { id: match?.[1], afterHeading: end, fields: {} };
    if (!match) return section;
    const id = match[1], title = section.title = valueSlot(text, match.indices![2]!, heading.index);
    if (ids.has(id)) duplicates.add(id);
    ids.add(id);
    const body = text.slice(end, headings[i + 1]?.index ?? text.length), unknownFields: string[] = [];
    let duplicatedField = false;
    for (const field of body.matchAll(/^\*\*([^:\r\n]+):\*\*[ \t]*([^\r\n]*)/dgm)) {
      const key = member(objectiveFields, field[1]);
      if (!key) unknownFields.push(field[0]);
      else if (section.fields[key]) duplicatedField = true;
      else section.fields[key] = valueSlot(text, field.indices![2]!, end);
    }
    const { State, Next, Result, Features, Evidence } = section.fields;
    const state = member(OBJECTIVE_STATES, State?.value), features = splitObjectiveList(Features?.value), evidence = splitObjectiveList(Evidence?.value);
    if (title.value && state && !duplicatedField && features.every(validFeature) && evidence.every(validEvidence))
      section.objective = { id, title: title.value, state, next: Next?.value || undefined, result: Result?.value || undefined, features, evidence, unknownFields };
    return section;
  });
  for (const [i, section] of sections.entries()) {
    if (section.id && duplicates.has(section.id)) record.diagnostics.push(`Duplicate Objective ID: ${section.id}`);
    else if (!section.objective) record.diagnostics.push(`Malformed Objective section ${i + 1}`);
    else record.objectives.push(section.objective);
  }
  const headerSlot = (n: number) => header && values?.indices?.[n] && slot(text, values.indices[n], header.start);
  return { record, header, badHeader, sections, stance: headerSlot(1), priority: headerSlot(2) ?? headerSlot(3) };
}

/** A missing file is ordinary; refuse to parse a partial file or follow a .hud symlink. */
export function readObjectiveFile(path: string) {
  const dir = lstatSync(dirname(path), { throwIfNoEntry: false });
  if (!dir) return;
  if (!dir.isDirectory()) throw new Error('Invalid .hud directory');
  try {
    const { bytes, stat, truncated } = readFileBounded(path, STATE_BYTES);
    if (truncated) throw new Error('Objective record exceeds 64 KiB');
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function readObjectives(root: string): ObjectiveRecord | undefined {
  try {
    const file = readObjectiveFile(objectivePath(root));
    return file && inspectObjectives(file.text).record;
  } catch (error) {
    return { stance: 'unknown', priority: 'normal', objectives: [], diagnostics: [String(error)] };
  }
}
