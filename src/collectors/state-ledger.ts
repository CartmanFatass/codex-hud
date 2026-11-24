import * as fs from 'node:fs';
import { join } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import { targetKey, ticketFileEvidence, ticketHeading } from './ticket-evidence.js';

export const STATE_BYTES = 65536;
export const statePaths = (root: string) => [join(root, 'docs/handoff/STATE.md'), join(root, 'STATE.md')];

export const WAITING_HEADING = 'Waiting for the owner';

export function stateSection(state: string, heading: string) {
  const head = new RegExp(`^## ${heading}[ \\t]*(?:\\r?\\n|$)`, 'm').exec(state);
  if (!head) return;
  const start = head.index + head[0].length;
  const next = /^## /m.exec(state.slice(start));
  return { start, end: next ? start + next.index : state.length };
}

export function stateBulletSpans(state: string, { start, end }: { start: number; end: number }) {
  return [...state.slice(start, end).matchAll(/^[-*] (.+(?:\r?\n[ \t]+.+)*)/gm)]
    .map((m) => ({ text: m[1], start: start + m.index, end: start + m.index + m[0].length }));
}

export function stateBullets(state: string, heading: string): string[] {
  const section = stateSection(state, heading);
  return section ? stateBulletSpans(state, section).map(({ text }) => text) : [];
}

/** IDs and Objective links occupy the first line; continuation text is ordinary prose. */
export function requestFields(text: string) {
  const head = /^(\d{4}-\d{2}-\d{2}[ \t]+)?\[(r\d+)\](?:[ \t]+|(?=[\r\n]|$))([^\r\n]*)/.exec(text);
  if (!head) return;
  const [, date = '', request, body] = head;
  const waitMark = /[ \t]*\(work waits\)[ \t]*$/i.exec(body)?.[0] ?? '';
  const main = body.slice(0, body.length - waitMark.length);
  const link = /[ \t]*\(objective ([a-z0-9-]+)\)[ \t]*$/.exec(main);
  const firstLine = link ? main.slice(0, link.index) : main, rest = text.slice(head[0].length);
  return { request, objective: link?.[1], waits: !!waitMark, sentence: `${firstLine}${rest}`,
    display: (title?: string) => `${date}${request} · ${firstLine}${title ? ` · ${title}` : ''}${waitMark}${rest}` };
}

/** Legacy reader for old try notifications and job supersession; not a Project progress source. */
export function parseLedger(state: string) {
  return stateBullets(state, 'Slices').flatMap((row) => {
    const [status, milestone, id, ...rest] = row.replace(/\s+/g, ' ').trim().split(/(?<= )·(?= )/).map((part) => part.trim());
    return rest.length ? [{ id, state: status, milestone, text: rest.join(' · ') }] : [];
  });
}

function readTicketLedger(root: string): ReturnType<typeof parseLedger> {
  const scratch = join(root, '.scratch'), rows: ReturnType<typeof parseLedger> = [];
  let features: fs.Dirent[];
  try {
    if (!fs.lstatSync(scratch).isDirectory()) return [];
    features = fs.readdirSync(scratch, { withFileTypes: true }).filter((e) => e.isDirectory()).slice(0, 64);
  } catch { return []; }
  let budget = 512;
  for (const { name: slug } of features) {
    if (budget <= 0) break;
    const issues = join(scratch, slug, 'issues');
    let files: string[];
    try {
      if (!fs.lstatSync(issues).isDirectory()) continue;
      files = fs.readdirSync(issues, { withFileTypes: true }).filter((e) => e.isFile() && /^\d+-[^/]+\.md$/.test(e.name))
        .map((e) => e.name).sort().slice(0, Math.min(64, budget));
    } catch { continue; }
    budget -= files.length;
    for (const name of files) {
      try {
        const path = join(issues, name), st = fs.lstatSync(path);
        if (!st.isFile()) continue;
        const { bytes, truncated } = readFileBounded(path, STATE_BYTES);
        if (truncated || st.size > bytes.length) continue;
        const text = bytes.toString('utf8'), heading = ticketHeading(text, Number(name.split('-')[0]));
        const { status, blocked, landed, commit } = ticketFileEvidence(text);
        if (!heading || !status || blocked === undefined) continue;
        rows.push({ id: `${slug.toUpperCase()}-${heading.number}`, state: landed ?? 'todo', milestone: slug,
          text: commit ? `${heading.title} (${commit.slice(0, 8)})` : heading.title });
      } catch { /* Unreadable ticket: skip. */ }
    }
  }
  return rows;
}

/** Catch up on old try events too, but let ticket files override legacy rows with the same ID. */
export function readTryLedger(root: string): ReturnType<typeof parseLedger> {
  const tickets = readTicketLedger(root), ids = new Set(tickets.map((row) => targetKey(row.id)));
  let legacy: ReturnType<typeof parseLedger> = [];
  for (const path of statePaths(root)) {
    try {
      if (!fs.lstatSync(path).isFile()) continue;
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const bytes = Buffer.alloc(STATE_BYTES);
        legacy = parseLedger(bytes.toString('utf8', 0, fs.readSync(fd, bytes)));
        break;
      } finally { fs.closeSync(fd); }
    } catch { /* Missing/unreadable; try the next STATE path. */ }
  }
  return [...tickets, ...legacy.filter((row) => !ids.has(targetKey(row.id)))];
}
