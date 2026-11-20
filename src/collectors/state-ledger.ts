import * as fs from 'node:fs';
import { join } from 'node:path';

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

/** The watch and MCP need just the same bounded ledger read, not the rest of Project collection. */
export function readStateLedger(root: string): ReturnType<typeof parseLedger> {
  for (const path of statePaths(root)) {
    try {
      if (!fs.lstatSync(path).isFile()) continue;
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const bytes = Buffer.alloc(STATE_BYTES);
        return parseLedger(bytes.toString('utf8', 0, fs.readSync(fd, bytes)));
      } finally { fs.closeSync(fd); }
    } catch { /* Missing/unreadable; try the next STATE path. */ }
  }
  return [];
}
