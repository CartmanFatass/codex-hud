/** Collect rerun-pass land gate flakes into the project's running-list ticket and dispatch one imp job when ready. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { scanScratch, slugify } from '../cli/tickets.js';
import { targetKey, ticketFileEvidence } from '../collectors/ticket-evidence.js';
import { SETTLED_JOB_STATES, ticketJobState } from '../collectors/ticket-rollup.js';
import { JobIndexCache } from '../roles/job-index-cache.js';
import { projectJobFilter } from '../roles/job-project.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { readFileBounded, readJsonBounded } from '../utils/atomic-fs.js';
import { dispatchJob } from './dispatch/orchestrator.js';
import type { Job } from './job-contracts.js';
import { activeLand, landAttempt } from './land-state.js';
import { withTicketEdits } from './ticket-commits.js';
import { ensureJobWatcher } from './watch-pid.js';

export interface FlakesConfig {
  feature: string;
}

export interface GateFlake {
  name: string;
  file?: string;
  flow: string;
  log?: string;
}

export interface FlakeCase {
  name: string;
  file?: string;
  flow?: string;
  log?: string;
}

export interface CollectFlakesOptions {
  landedTickets?: readonly string[];
  dispatch?: (input: {
    role: 'imp';
    cwd: string;
    isolation: 'worktree';
    ticket: string;
    brief_file: string;
    request_key: string;
  }, pane: string | undefined) => Promise<{ job?: string } | Record<string, unknown>>;
}

export interface CollectFlakesResult {
  ticket?: string;
  path?: string;
  created?: boolean;
  promoted?: boolean;
  dispatchedJob?: string;
}

const FEATURE_RE = /^[a-z0-9-]+$/;
const STATUS_FIELD = /((?:^|·)[ \t]*\*\*Status:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
const COMMENTS_HEADING = /^## Comments[ \t]*\r?$/m;
const CASES_HEADING = /^###[ \t]+Cases[ \t]*\r?$/m;
const CHECKBOX_LINE = /^[ \t]*[-*] \[[ xX]\]/m;
const MAX_TICKET_BYTES = 256 * 1024;
const DISPATCH_CASE_THRESHOLD = 4;

const nn = (n: number) => String(n).padStart(2, '0');
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const norm = (text: string) => oneLine(text).toLowerCase();

export function readFlakesConfig(mainRoot: string): FlakesConfig | null {
  try {
    const raw = readJsonBounded(join(mainRoot, '.hud', 'project.json'), 256 * 1024) as { flakes?: unknown } | null;
    const flakes = raw?.flakes;
    if (!flakes || typeof flakes !== 'object' || Array.isArray(flakes)) return null;
    const feature = (flakes as { feature?: unknown }).feature;
    if (typeof feature !== 'string' || !FEATURE_RE.test(feature)) return null;
    return { feature };
  } catch {
    return null;
  }
}

export function formatLogPath(log: string | undefined): string | undefined {
  if (!log) return undefined;
  const trimmed = oneLine(log);
  if (!trimmed) return undefined;
  const homeDir = homedir();
  const resolvedHome = resolve(homeDir);
  const resolvedLog = resolve(trimmed);
  if (resolvedLog.startsWith(resolvedHome + sep)) {
    return `~/${relative(resolvedHome, resolvedLog).split(sep).join('/')}`;
  }
  return trimmed;
}

export function formatFlakeLine(flake: GateFlake): string {
  const name = oneLine(flake.name);
  const file = flake.file ? oneLine(flake.file) : undefined;
  const flow = oneLine(flake.flow);
  const log = formatLogPath(flake.log);
  const subject = file ? `\`${name}\` (${file})` : `\`${name}\``;
  return log
    ? `- ${subject} — flow \`${flow}\`, log \`${log}\``
    : `- ${subject} — flow \`${flow}\``;
}

function parseStructuredLine(line: string): FlakeCase | null {
  const splitIdx = line.lastIndexOf(' — flow ');
  if (splitIdx < 0) return null;
  const left = line.slice(0, splitIdx).replace(/^[ \t]*-[ \t]+/, '').trim();
  const right = line.slice(splitIdx + ' — flow '.length).trim();
  const flowMatch = /^`([^`\r\n]+)`(?:,[ \t]+log[ \t]+`([^`\r\n]+)`)?$/.exec(right);
  if (!flowMatch) return null;
  let name: string | undefined;
  let file: string | undefined;
  if (left.startsWith('`') && left.endsWith('`') && left.length >= 2) {
    name = left.slice(1, -1).trim();
  } else if (left.startsWith('`') && left.endsWith(')')) {
    const fileStart = left.lastIndexOf('` (');
    if (fileStart > 1) {
      name = left.slice(1, fileStart).trim();
      file = left.slice(fileStart + 3, -1).trim();
    }
  }
  if (!name) return null;
  return {
    name,
    ...(file ? { file } : {}),
    flow: flowMatch[1].trim(),
    ...(flowMatch[2] ? { log: flowMatch[2].trim() } : {}),
  };
}

export function isRunningListTicket(text: string): boolean {
  const body = text.split(COMMENTS_HEADING, 1)[0];
  return /\brunning list\b/i.test(body) || CASES_HEADING.test(body);
}

export function parseFlakeCases(text: string): FlakeCase[] {
  const body = text.split(COMMENTS_HEADING, 1)[0];
  const cases: FlakeCase[] = [];
  for (const line of body.split(/\r?\n/)) {
    const parsed = parseStructuredLine(line);
    if (parsed) cases.push(parsed);
  }
  // Also recognize legacy hand-written running-list prose (`Cases: ...`) before `### Cases` or acceptance items.
  const prosePart = body.split(CASES_HEADING, 1)[0].split(CHECKBOX_LINE, 1)[0];
  const inlineIdx = prosePart.search(/\bCases:/i);
  if (inlineIdx >= 0) {
    const inline = prosePart.slice(inlineIdx + 'Cases:'.length);
    const re = /`([^`\r\n]+)`(?:[ \t]*\(([^()\r\n]+\.(?:[cm]?js|[cm]?ts))\b[^()\r\n]*\))?/g;
    for (const match of inline.matchAll(re)) {
      const name = match[1].trim();
      if (!name) continue;
      cases.push({ name, ...(match[2] ? { file: match[2].trim() } : {}) });
    }
  }
  return cases;
}

function sameTest(a: Pick<FlakeCase, 'name' | 'file'>, b: Pick<FlakeCase, 'name' | 'file'>): boolean {
  if (norm(a.name) !== norm(b.name)) return false;
  if (a.file && b.file) return norm(a.file) === norm(b.file);
  return true;
}

function sameRecordedEntry(existing: FlakeCase, incoming: GateFlake): boolean {
  if (!existing.flow || norm(existing.flow) !== norm(incoming.flow)) return false;
  if (!sameTest(existing, incoming)) return false;
  const inLog = formatLogPath(incoming.log);
  if (existing.log && inLog && norm(existing.log) !== norm(inLog)) return false;
  return true;
}

function shouldTriggerDispatch(allCases: readonly FlakeCase[]): boolean {
  if (allCases.length >= DISPATCH_CASE_THRESHOLD) return true;
  for (let i = 0; i < allCases.length; i++) {
    for (let j = i + 1; j < allCases.length; j++) {
      if (sameTest(allCases[i], allCases[j])) return true;
    }
  }
  return false;
}

function listFeatureTickets(scratchDir: string, feature: string): { number: number; path: string }[] {
  const issues = join(scratchDir, feature, 'issues');
  const st = fs.lstatSync(issues, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return [];
  return fs.readdirSync(issues, { withFileTypes: true }).flatMap(entry => {
    const match = /^(\d+)-.+\.md$/.exec(entry.name);
    return match && entry.isFile() ? [{ number: Number(match[1]), path: join(issues, entry.name) }] : [];
  });
}

function loadFeatureJobs(home: string, mainRoot: string, feature: string) {
  const cache = new JobIndexCache(home);
  const matchesProject = projectJobFilter(mainRoot);
  const prefix = `${feature.toLowerCase()}/`;
  const claimedTickets = new Set<string>();
  let hasActiveFlakeJob = false;
  let ids: readonly string[];
  try {
    ids = cache.listJobIds();
  } catch {
    return { claimedTickets, hasActiveFlakeJob };
  }
  for (const id of ids) {
    const receipt = cache.readJob<Job>(id);
    if (receipt.status !== 'ok' || !receipt.value.ticket || !matchesProject(receipt.value)) continue;
    const key = targetKey(receipt.value.ticket);
    if (!key.startsWith(prefix)) continue;
    const statusRes = cache.readStatus(id);
    const state = ticketJobState(receipt.value, statusRes.status === 'ok' ? statusRes.value : {});
    if (state !== 'failed' && state !== 'stopped') {
      claimedTickets.add(key);
    }
    if (!receipt.value.reaped_at && (!SETTLED_JOB_STATES.has(state) || state === 'idle_grace')) {
      hasActiveFlakeJob = true;
    } else {
      const prior = landAttempt(home, id).prior;
      if (prior && activeLand(prior)) hasActiveFlakeJob = true;
    }
  }
  return { claimedTickets, hasActiveFlakeJob };
}

function appendCaseLines(original: string, lines: readonly string[], promote: boolean): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const commentsIdx = original.search(COMMENTS_HEADING);
  let before = commentsIdx < 0 ? original : original.slice(0, commentsIdx);
  const after = commentsIdx < 0 ? `${eol}## Comments${eol}` : original.slice(commentsIdx);

  const casesMatch = CASES_HEADING.exec(before);
  if (casesMatch) {
    const headingEnd = before.indexOf('\n', casesMatch.index);
    const sectionStart = headingEnd < 0 ? before.length : headingEnd + 1;
    const rest = before.slice(sectionStart);
    const nextHeading = rest.search(/^#/m);
    const nextCheckbox = rest.search(CHECKBOX_LINE);
    let sectionEndRel = rest.length;
    if (nextHeading >= 0) sectionEndRel = Math.min(sectionEndRel, nextHeading);
    if (nextCheckbox >= 0) sectionEndRel = Math.min(sectionEndRel, nextCheckbox);
    const section = rest.slice(0, sectionEndRel).trimEnd();
    const tail = rest.slice(sectionEndRel);
    const head = before.slice(0, sectionStart);
    const joined = section
      ? `${section}${eol}${lines.join(eol)}`
      : `${eol}${lines.join(eol)}`;
    before = tail
      ? `${head}${joined}${eol}${eol}${tail}`
      : `${head}${joined}${eol}${eol}`;
  } else {
    const checkIdx = before.search(CHECKBOX_LINE);
    const block = `### Cases${eol}${eol}${lines.join(eol)}`;
    if (checkIdx >= 0) {
      const prefix = before.slice(0, checkIdx).trimEnd();
      const suffix = before.slice(checkIdx);
      before = `${prefix}${eol}${eol}${block}${eol}${eol}${suffix}`;
    } else {
      before = `${before.trimEnd()}${eol}${eol}${block}${eol}${eol}`;
    }
  }

  if (promote && STATUS_FIELD.test(before)) {
    before = before.replace(STATUS_FIELD, (_, prefix, _old, suffix) => `${prefix}ready-for-agent${suffix}`);
  }
  return `${before}${after}`;
}

function buildRunningListTicket(
  feature: string,
  nextNum: number,
  prevMaxNum: number,
  lines: readonly string[],
  promote: boolean,
): { title: string; body: string } {
  const title = prevMaxNum > 0
    ? `Gate flakes collected after ${feature}/${nn(prevMaxNum)}`
    : 'Gate flakes running list';
  const body = [
    `# ${nn(nextNum)}: ${title}`,
    '',
    `**Status:** ${promote ? 'ready-for-agent' : 'needs-triage'}`,
    '**Owner try:** no',
    '**Live try:** none',
    '**Blocked by:** none',
    '',
    '**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).',
    '',
    '### Cases',
    '',
    ...lines,
    '',
    '- [ ] Each listed case passes 20 consecutive runs under parallel load',
    '- [ ] No assertion or product bound weakened',
    '',
    '## Comments',
    '',
  ].join('\n');
  return { title, body };
}

function findReadyRunningListTicket(
  mainRoot: string,
  feature: string,
  claimedTickets: ReadonlySet<string>,
): { ticket: string; path: string } | null {
  const scratch = join(mainRoot, '.scratch');
  const tickets = listFeatureTickets(scratch, feature).sort((a, b) => a.number - b.number);
  for (const item of tickets) {
    const ticket = `${feature}/${nn(item.number)}`;
    if (claimedTickets.has(targetKey(ticket))) continue;
    try {
      const { bytes, truncated } = readFileBounded(item.path, MAX_TICKET_BYTES);
      if (truncated) continue;
      const text = bytes.toString('utf8');
      if (!isRunningListTicket(text)) continue;
      const evidence = ticketFileEvidence(text);
      if (!/^ready-for-agent$/i.test(evidence.status ?? '')) continue;
      if (evidence.landed !== undefined) continue;
      if (evidence.blocked !== undefined && evidence.blocked.trim() && !/^none\b/i.test(evidence.blocked.trim())) continue;
      return { ticket, path: item.path };
    } catch { /* Skip unreadable ticket. */ }
  }
  return null;
}

export async function collectGateFlakes(
  home: string,
  mainRoot: string,
  flakes: readonly GateFlake[],
  pane: string | null,
  options?: CollectFlakesOptions,
): Promise<CollectFlakesResult> {
  const config = readFlakesConfig(mainRoot);
  if (!config) return {};
  const { feature } = config;
  const landedFlake = (options?.landedTickets ?? []).some(t => targetKey(t).startsWith(`${feature.toLowerCase()}/`));
  if (!flakes.length && !landedFlake) return {};

  let result: CollectFlakesResult = {};

  if (flakes.length) {
    result = await withTicketEdits(mainRoot, home, 'flake', async (edits) => {
      const scratch = join(mainRoot, '.scratch');
      scanScratch(scratch, true);
      const existing = listFeatureTickets(scratch, feature).sort((a, b) => b.number - a.number);
      const maxNum = existing[0]?.number ?? 0;
      const { claimedTickets } = loadFeatureJobs(home, mainRoot, feature);

      // Find the newest running-list ticket and check if it is still open for collection.
      let newestRunning: { number: number; path: string; text: string } | undefined;
      for (const item of existing) {
        try {
          const text = edits.read(item.path);
          if (isRunningListTicket(text)) {
            newestRunning = { ...item, text };
            break;
          }
        } catch { /* Ignore unreadable file. */ }
      }

      let openTarget: { number: number; path: string; text: string } | undefined;
      if (newestRunning) {
        const evidence = ticketFileEvidence(newestRunning.text);
        const status = (evidence.status ?? '').trim().toLowerCase();
        const key = targetKey(`${feature}/${nn(newestRunning.number)}`);
        if ((status === 'needs-triage' || status === 'needs-info') && evidence.landed === undefined && !claimedTickets.has(key)) {
          openTarget = newestRunning;
        }
      }

      if (openTarget) {
        const ticket = `${feature}/${nn(openTarget.number)}`;
        const existingCases = parseFlakeCases(openTarget.text);
        const toAdd: GateFlake[] = [];
        for (const flake of flakes) {
          const allSoFar: FlakeCase[] = [...existingCases, ...toAdd.map(f => ({ ...f, log: formatLogPath(f.log) }))];
          if (allSoFar.some(c => sameRecordedEntry(c, flake))) continue;
          toAdd.push(flake);
        }
        if (!toAdd.length) return { ticket, path: openTarget.path, created: false, promoted: false };
        const allCases: FlakeCase[] = [...existingCases, ...toAdd.map(f => ({ ...f, log: formatLogPath(f.log) }))];
        const promoted = shouldTriggerDispatch(allCases);
        const updated = appendCaseLines(openTarget.text, toAdd.map(formatFlakeLine), promoted);
        const mode = fs.statSync(openTarget.path).mode & 0o777;
        await edits.stage({ ticket, path: openTarget.path, before: openTarget.text, after: updated, mode });
        return { ticket, path: openTarget.path, created: false, promoted };
      }

      const toAdd: GateFlake[] = [];
      for (const flake of flakes) {
        const soFar: FlakeCase[] = toAdd.map(f => ({ ...f, log: formatLogPath(f.log) }));
        if (soFar.some(c => sameRecordedEntry(c, flake))) continue;
        toAdd.push(flake);
      }
      if (!toAdd.length) return {};

      const nextNum = maxNum + 1;
      const ticket = `${feature}/${nn(nextNum)}`;
      const promoted = shouldTriggerDispatch(toAdd.map(f => ({ ...f, log: formatLogPath(f.log) })));
      const { title, body } = buildRunningListTicket(feature, nextNum, maxNum, toAdd.map(formatFlakeLine), promoted);
      const path = join(scratch, feature, 'issues', `${nn(nextNum)}-${slugify(title, nextNum)}.md`);
      await edits.stage({ ticket, path, after: body });
      return { ticket, path, created: true, promoted };
    });
  }

  if (result.promoted || landedFlake) {
    const dispatchedJob = await withAbstractLock('land-flakes-dispatch', `${home}\0${mainRoot}\0${feature}`, async () => {
      const { claimedTickets, hasActiveFlakeJob } = loadFeatureJobs(home, mainRoot, feature);
      if (hasActiveFlakeJob) return undefined;
      const candidate = findReadyRunningListTicket(mainRoot, feature, claimedTickets);
      if (!candidate) return undefined;
      const input = {
        role: 'imp' as const,
        cwd: mainRoot,
        isolation: 'worktree' as const,
        ticket: candidate.ticket,
        brief_file: candidate.path,
        request_key: `flakes:${candidate.ticket}`,
      };
      const res = options?.dispatch
        ? await options.dispatch(input, pane || undefined)
        : await dispatchJob(input, pane || undefined);
      if (res && 'job' in res && typeof res.job === 'string') {
        if (!options?.dispatch) ensureJobWatcher(home);
        return res.job;
      }
      return undefined;
    });
    if (dispatchedJob) result.dispatchedJob = dispatchedJob;
  }

  return result;
}
