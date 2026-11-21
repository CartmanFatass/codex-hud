import * as fs from 'node:fs';
import { join } from 'node:path';
import { scanScratch, slugify, ticketsCommand, writeFileAtomic } from '../../../src/cli/tickets.js';
import { TICKET_STATUSES } from '../../../src/roles/tool-definitions.js';

const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nn = (value: number) => String(value).padStart(2, '0');
function invalid(field: string): never {
  throw new Error(`invalid_arguments: ${field}`);
}
function line(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) return invalid(field);
  return value.replace(/\s+/g, ' ').trim();
}
function status(value: unknown): string {
  const label = TICKET_STATUSES.find((label) => label === value);
  return label ?? invalid('status');
}
function numbers(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || !value.every(number)) return invalid(field);
  return value;
}
function directoryExists(path: string): boolean {
  const st = fs.lstatSync(path, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) throw new Error(`not a directory: ${path}`);
  return !!st;
}

export async function editTickets(cwd: string, args: Record<string, unknown>) {
  const { op, feature } = args;
  if (op === 'sync') {
    const output: string[] = [];
    const capture = (text: string) => {
      output.push(...text.trimEnd().split(/\r?\n/));
    };
    await ticketsCommand(['sync', '--cwd', cwd], { env: process.env, stdout: capture, stderr: capture });
    return { ok: true, output };
  }
  if (op !== 'add' && op !== 'update') return invalid('op');
  if (typeof feature !== 'string' || !/^[a-z0-9-]+$/.test(feature)) return invalid('feature');
  const scratch = join(cwd, '.scratch');
  scanScratch(scratch, true);
  const featureDir = join(scratch, feature),
    issues = join(featureDir, 'issues');
  const existing =
    directoryExists(featureDir) && directoryExists(issues)
      ? fs.readdirSync(issues, { withFileTypes: true }).flatMap((entry) => {
          const match = /^(\d+)-.+\.md$/.exec(entry.name);
          return match && entry.isFile() ? [{ number: Number(match[1]), path: join(issues, entry.name) }] : [];
        })
      : [];
  if (op === 'add') {
    if (!Array.isArray(args.tickets) || !args.tickets.length) return invalid('tickets');
    const known = new Set(existing.map((ticket) => ticket.number));
    let next = existing.reduce((max, ticket) => Math.max(max, ticket.number), 0);
    // Plan the entire batch before making directories or writing any ticket.
    const plans = args.tickets.map((ticket: Record<string, unknown>) => {
      if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return invalid('tickets');
      if (!number(++next)) throw new Error('ticket numbering exhausted');
      const title = line(ticket.title, 'title'),
        what = line(ticket.what, 'what');
      const label = ticket.status === undefined ? 'ready-for-agent' : status(ticket.status);
      const blockers = numbers(ticket.blocked_by, 'blocked_by');
      for (const blocker of blockers) if (!known.has(blocker)) throw new Error(`unknown blocked_by ticket: ${blocker}`);
      if (!Array.isArray(ticket.acceptance)) return invalid('acceptance');
      const items = ticket.acceptance.map((item) => `- [ ] ${line(item, 'acceptance')}`);
      const body = [
        `# ${nn(next)}: ${title}`,
        '',
        `**Status:** ${label}`,
        `**Blocked by:** ${blockers.length ? blockers.map(nn).join(', ') : 'none'}`,
        '',
        `**What to build:** ${what}`,
        '',
        ...items,
        ...(items.length ? [''] : []),
        '## Comments',
        '',
      ].join('\n');
      known.add(next);
      return { number: next, path: join(issues, `${nn(next)}-${slugify(title, next)}.md`), body };
    });
    fs.mkdirSync(issues, { recursive: true });
    const tickets = plans.map(({ number, path, body }) => {
      fs.writeFileSync(path, body, { flag: 'wx' });
      return { number, path };
    });
    return { ok: true, tickets };
  }

  if (!number(args.ticket)) return invalid('ticket');
  if (args.status === undefined && args.tick === undefined) return invalid('status or tick');
  const matches = existing.filter(({ number }) => number === args.ticket);
  if (!matches.length) throw new Error(`unknown ticket: ${args.ticket}`);
  if (matches.length > 1) throw new Error(`ambiguous ticket: ${args.ticket}`);
  const [ticket] = matches;
  const original = fs.readFileSync(ticket.path, 'utf8');
  const comments = original.search(/^## Comments[ \t]*\r?$/m);
  let body = comments < 0 ? original : original.slice(0, comments);
  if (args.status !== undefined) {
    const field = /((?:^|·)[ \t]*\*\*Status:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
    const label = status(args.status);
    if (!field.test(body)) throw new Error(`missing Status field in ticket: ${args.ticket}`);
    body = body.replace(field, (_, prefix, _old, suffix) => `${prefix}${label}${suffix}`);
  }
  if (args.tick !== undefined) {
    const tick = new Set(numbers(args.tick, 'tick'));
    let count = 0;
    body = body.replace(/^([ \t]*[-*] \[)([ xX])\]/gm, (box, prefix, mark) =>
      tick.has(++count) && mark === ' ' ? `${prefix}x]` : box
    );
    for (const item of tick) if (item > count) throw new Error(`unknown acceptance item: ${item}`);
  }
  const updated = body + (comments < 0 ? '' : original.slice(comments));
  if (updated !== original) writeFileAtomic(ticket.path, updated, fs.statSync(ticket.path).mode & 0o777);
  return { ok: true, ...ticket };
}
