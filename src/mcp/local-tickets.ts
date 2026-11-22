import * as fs from 'node:fs';
import { join } from 'node:path';
import { scanScratch, slugify, ticketsCommand, writeFileAtomic } from '../cli/tickets.js';
import { TICKET_STATUSES } from '../roles/tool-definitions.js';

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

function withStatus(body: string, label: string, ticket: number): string {
  const field = /((?:^|·)[ \t]*\*\*Status:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
  if (!field.test(body)) throw new Error(`missing Status field in ticket: ${ticket}`);
  return body.replace(field, (_, prefix, _old, suffix) => `${prefix}${label}${suffix}`);
}

/** Acceptance is the checklist before Comments; checkboxes in discussion aren't acceptance. */
export function landedTicket(original: string, ticket: number, comment: string) {
  const start = original.search(/^## Comments[ \t]*\r?$/m);
  const body = withStatus(start < 0 ? original : original.slice(0, start), 'ready-for-human', ticket)
    .replace(/^([ \t]*[-*] \[) \]/gm, '$1x]');
  return (body + (start < 0 ? '\n## Comments' : original.slice(start))).trimEnd() + `\n\n- ${comment}\n`;
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
  const scratch = join(cwd, '.scratch');
  scanScratch(scratch, true);
  const list = (dir: string) =>
    directoryExists(dir) && directoryExists(join(dir, 'issues'))
      ? fs.readdirSync(join(dir, 'issues'), { withFileTypes: true }).flatMap((entry) => {
          const match = /^(\d+)-.+\.md$/.exec(entry.name);
          return match && entry.isFile() ? [{ number: Number(match[1]), path: join(dir, 'issues', entry.name) }] : [];
        })
      : [];
  const resolveBlockers = (value: unknown, feat: string, known: Set<number>) => {
    if (!Array.isArray(value)) return invalid('blocked_by');
    const refs = value.map(ref => {
      const match = typeof ref === 'string' && /^([a-z0-9-]+)\/(\d+)$/.exec(ref);
      const n = match ? Number(match[2]) : ref;
      if (!number(n)) return invalid('blocked_by');
      const exists = match && match[1] !== feat ? list(join(scratch, match[1])).some(t => t.number === n) : known.has(n);
      if (!exists) throw new Error(`unknown blocked_by ticket: ${ref}`);
      return match ? `${match[1]}/${nn(n)}` : nn(n);
    });
    return refs.join(', ') || 'none';
  };
  if (op === 'add') {
    if (args.updates !== undefined) return invalid('updates');
    if (typeof feature !== 'string' || !/^[a-z0-9-]+$/.test(feature)) return invalid('feature');
    const featureDir = join(scratch, feature),
      issues = join(featureDir, 'issues');
    const existing = list(featureDir);
    const known = new Set(existing.map(t => t.number));
    if (!Array.isArray(args.tickets) || !args.tickets.length) return invalid('tickets');
    let next = existing.reduce((max, ticket) => Math.max(max, ticket.number), 0);
    // Plan the entire batch before making directories or writing any ticket.
    const plans = args.tickets.map((ticket: Record<string, unknown>) => {
      if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return invalid('tickets');
      if (!number(++next)) throw new Error('ticket numbering exhausted');
      const title = line(ticket.title, 'title'),
        what = line(ticket.what, 'what');
      const label = ticket.status === undefined ? 'ready-for-agent' : status(ticket.status);
      const blocked = resolveBlockers(ticket.blocked_by, feature, known);
      if (!Array.isArray(ticket.acceptance)) return invalid('acceptance');
      const items = ticket.acceptance.map((item) => `- [ ] ${line(item, 'acceptance')}`);
      const body = [
        `# ${nn(next)}: ${title}`,
        '',
        `**Status:** ${label}`,
        `**Blocked by:** ${blocked}`,
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

  const updateOne = (feat: unknown, item: Record<string, unknown>) => {
    if (typeof feat !== 'string' || !/^[a-z0-9-]+$/.test(feat)) return invalid('feature');
    if (!number(item.ticket)) return invalid('ticket');
    if (item.status === undefined && item.tick === undefined && item.blocked_by === undefined) return invalid('status, tick or blocked_by');
    const existing = list(join(scratch, feat));
    const known = new Set(existing.map(t => t.number));
    const matches = existing.filter(({ number }) => number === item.ticket);
    if (!matches.length) throw new Error(`unknown ticket: ${item.ticket}`);
    if (matches.length > 1) throw new Error(`ambiguous ticket: ${item.ticket}`);
    const [ticket] = matches;
    const original = fs.readFileSync(ticket.path, 'utf8');
    const comments = original.search(/^## Comments[ \t]*\r?$/m);
    let body = comments < 0 ? original : original.slice(0, comments);
    if (item.status !== undefined) body = withStatus(body, status(item.status), item.ticket);
    if (item.blocked_by !== undefined) {
      const field = /((?:^|·)[ \t]*\*\*Blocked by:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
      if (!field.test(body)) throw new Error(`missing Blocked by field in ticket: ${item.ticket}`);
      const refs = resolveBlockers(item.blocked_by, feat, known);
      body = body.replace(field, (_, prefix, _old, suffix) => `${prefix}${refs}${suffix}`);
    }
    if (item.tick !== undefined) {
      const tick = new Set(numbers(item.tick, 'tick'));
      let count = 0;
      body = body.replace(/^([ \t]*[-*] \[)([ xX])\]/gm, (box, prefix, mark) =>
        tick.has(++count) && mark === ' ' ? `${prefix}x]` : box
      );
      for (const n of tick) if (n > count) throw new Error(`unknown acceptance item: ${n}`);
    }
    const updated = body + (comments < 0 ? '' : original.slice(comments));
    if (updated !== original) writeFileAtomic(ticket.path, updated, fs.statSync(ticket.path).mode & 0o777);
    return { ok: true, ...ticket };
  };

  if (args.updates !== undefined) {
    if (args.ticket !== undefined || args.status !== undefined || args.tick !== undefined || args.blocked_by !== undefined)
      return invalid('updates');
    if (!Array.isArray(args.updates) || !args.updates.length) return invalid('updates');
    if (feature !== undefined && (typeof feature !== 'string' || !/^[a-z0-9-]+$/.test(feature))) return invalid('feature');
    const updates = args.updates.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, code: 'invalid_arguments', error: 'invalid_arguments: updates' };
      }
      const item = raw as Record<string, unknown>;
      const feat = item.feature ?? feature;
      try {
        return { feature: feat as string, ...updateOne(feat, item) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ...(typeof feat === 'string' ? { feature: feat } : {}),
          ...(number(item.ticket) ? { ticket: item.ticket } : {}),
          ok: false,
          code: message.startsWith('invalid_arguments') ? 'invalid_arguments' : 'tool_error',
          error: message,
        };
      }
    });
    return { updates };
  }

  return updateOne(feature, args);
}
