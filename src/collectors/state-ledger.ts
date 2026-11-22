import * as fs from 'node:fs';
import { join } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';
import { targetKey, ticketFileEvidence, ticketHeading } from './ticket-evidence.js';

export const STATE_BYTES = 65536;
export const statePaths = (root: string) => [join(root, 'docs/handoff/STATE.md'), join(root, 'STATE.md')];

export function stateBullets(state: string, heading: string): string[] {
  const section = state.split(new RegExp(`^## ${heading}[ \\t]*\\r?$`, 'm'))[1]?.split(/^## /m)[0] ?? '';
  return [...section.matchAll(/^[-*] (.+(?:\r?\n[ \t]+.+)*)/gm)].map((m) => m[1]);
}

export function parseLedger(state: string) {
  return stateBullets(state, 'Slices').flatMap((row) => {
    const [status, milestone, id, ...rest] = row.replace(/\s+/g, ' ').trim().split(/(?<= )·(?= )/).map((part) => part.trim());
    return rest.length ? [{ id, state: status, milestone, text: rest.join(' · ') }] : [];
  });
}

function readTicketTryLedger(root: string, existing: ReturnType<typeof parseLedger>): ReturnType<typeof parseLedger> {
  const scratch = join(root, '.scratch'), rows: ReturnType<typeof parseLedger> = [];
  let features: fs.Dirent[];
  try {
    if (!fs.lstatSync(scratch).isDirectory()) return [];
    features = fs.readdirSync(scratch, { withFileTypes: true }).filter((e) => e.isDirectory()).slice(0, 64);
  } catch { return []; }
  const knownIds = new Set(existing.map((r) => targetKey(r.id)));
  const knownCommits = new Set(existing.flatMap((r) => [...r.text.matchAll(/\b[0-9a-f]{7,40}\b/gi)].map((m) => m[0].slice(0, 7).toLowerCase())));
  const milestoneFor = (slug: string) => existing.find((r) => r.milestone.toLowerCase() === slug.toLowerCase())?.milestone ?? slug;
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
        if (!heading || !status || blocked === undefined || landed !== 'try') continue;
        const id = `${slug.toUpperCase()}-${heading.number}`;
        if (knownIds.has(targetKey(id)) || (commit && knownCommits.has(commit.slice(0, 7).toLowerCase()))) continue;
        rows.push({ id, state: 'try', milestone: milestoneFor(slug), text: commit ? `${heading.title} (${commit.slice(0, 8)})` : heading.title });
      } catch { /* Unreadable ticket: skip. */ }
    }
  }
  return rows;
}

/** The watch and MCP need just the same bounded ledger read, not the rest of Project collection. */
export function readStateLedger(root: string): ReturnType<typeof parseLedger> {
  let stateRows: ReturnType<typeof parseLedger> = [];
  for (const path of statePaths(root)) {
    try {
      if (!fs.lstatSync(path).isFile()) continue;
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const bytes = Buffer.alloc(STATE_BYTES);
        stateRows = parseLedger(bytes.toString('utf8', 0, fs.readSync(fd, bytes)));
        break;
      } finally { fs.closeSync(fd); }
    } catch { /* Missing/unreadable; try the next STATE path. */ }
  }
  return [...stateRows, ...readTicketTryLedger(root, stateRows)];
}
