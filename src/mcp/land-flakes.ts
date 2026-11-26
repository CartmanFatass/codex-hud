/** Collect rerun-pass land gate flakes into the project's running-list ticket and dispatch one imp job when ready. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { scanScratch, slugify } from '../cli/tickets.js';
import { targetKey, ticketFileEvidence } from '../collectors/ticket-evidence.js';
import { SETTLED_JOB_STATES, ticketJobState } from '../collectors/ticket-rollup.js';
import { herdrId } from '../roles/herdr-run.js';
import { JobIndexCache } from '../roles/job-index-cache.js';
import { projectJobFilter } from '../roles/job-project.js';
import { sharedRoot } from '../roles/projects.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { readDirSafe, readFileBounded, readJsonBounded, readJsonFile } from '../utils/atomic-fs.js';
import { dispatchTicketJob } from './dispatch/orchestrator.js';
import type { Job } from './job-contracts.js';
import {
  activeLand, isFlowId, landAttempt, landFile, updateLandFlakeCollection,
  type LandFlakeCollection, type LandFlow,
} from './land-state.js';
import { jobFiles } from './paths.js';
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
  unidentified?: boolean;
}

export interface FlakeCase {
  name: string;
  file?: string;
  flow?: string;
  log?: string;
  unidentified?: boolean;
}

export interface CollectFlakesOptions {
  landedTickets?: readonly string[];
  retryDispatch?: boolean;
  pendingTicket?: string;
  dispatch?: (input: {
    role: 'imp';
    cwd: string;
    isolation: 'worktree';
    ticket: string;
    brief_file: string;
    request_key: string;
  }, pane: string | undefined) => Promise<{
    job?: string;
    ok?: boolean;
    state?: string;
    display_state?: string;
    reason?: string;
    error?: string;
    code?: string;
  } | Record<string, unknown>>;
}

export interface CollectFlakesPending {
  stage: 'edit' | 'dispatch';
  error: string;
  ticket?: string;
}

export interface CollectFlakesResult {
  ticket?: string;
  path?: string;
  created?: boolean;
  promoted?: boolean;
  dispatchedJob?: string;
  pending?: CollectFlakesPending;
}

const FEATURE_RE = /^[a-z0-9-]+$/;
const STATUS_FIELD = /((?:^|·)[ \t]*\*\*Status:\*\*[ \t]*)([^·\r\n]*?)([ \t]*)(?=·|\r?$)/im;
const COMMENTS_HEADING = /^## Comments[ \t]*\r?$/m;
const CASES_HEADING = /^###[ \t]+Cases[ \t]*\r?$/m;
const CHECKBOX_LINE = /^[ \t]*[-*] \[[ xX]\]/m;
const MAX_TICKET_BYTES = 256 * 1024;
const MAX_FLOW_BYTES = 128 * 1024;
const DISPATCH_CASE_THRESHOLD = 4;
const WAITING_DISPATCH_ERROR = 'waiting for active flake job';
const BLOCKED_DISPATCH_ERROR = 'ticket is blocked';

const nn = (n: number) => String(n).padStart(2, '0');
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const norm = (text: string) => oneLine(text).toLowerCase();

export function flakeProjectId(mainRoot: string): string {
  return createHash('sha256').update(sharedRoot(mainRoot)).digest('hex').slice(0, 16);
}

export function flakeDispatchKey(mainRoot: string, ticket: string, attempt: number): string {
  return `flakes:${flakeProjectId(mainRoot)}:${ticket}:${attempt}`;
}

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
  const subject = flake.unidentified
    ? (file ? `unidentified failure (\`${name}\`, ${file})` : `unidentified failure (\`${name}\`)`)
    : (file ? `\`${name}\` (${file})` : `\`${name}\``);
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
  let unidentified = false;
  const unidMatch = /^unidentified(?: gate)? failure \(`([^`\r\n]+)`(?:,[ \t]+([^)\r\n]+))?\)$/i.exec(left);
  if (unidMatch) {
    name = unidMatch[1].trim();
    file = unidMatch[2]?.trim() || undefined;
    unidentified = true;
  } else if (left.startsWith('`') && left.endsWith('`') && left.length >= 2) {
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
    ...(unidentified ? { unidentified: true } : {}),
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

function sameTest(a: Pick<FlakeCase, 'name' | 'file' | 'unidentified'>, b: Pick<FlakeCase, 'name' | 'file' | 'unidentified'>): boolean {
  if (a.unidentified || b.unidentified) return false;
  if (norm(a.name) !== norm(b.name)) return false;
  if (a.file && b.file) return norm(a.file) === norm(b.file);
  return true;
}

function sameRecordedEntry(existing: FlakeCase, incoming: GateFlake): boolean {
  if (!existing.flow || norm(existing.flow) !== norm(incoming.flow)) return false;
  if (Boolean(existing.unidentified) !== Boolean(incoming.unidentified)) return false;
  if (norm(existing.name) !== norm(incoming.name)) return false;
  if ((existing.file ? norm(existing.file) : '') !== (incoming.file ? norm(incoming.file) : '')) return false;
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

function loadFeatureJobs(home: string, mainRoot: string, feature: string, checkActive = true) {
  const cache = new JobIndexCache(home);
  const matchesProject = projectJobFilter(mainRoot);
  const projectId = flakeProjectId(mainRoot);
  const prefix = `${feature.toLowerCase()}/`;
  const keyPrefix = `flakes:${projectId}:`;
  const claimedTickets = new Set<string>();
  const failedCounts = new Map<string, number>();
  const maxKeyAttempts = new Map<string, number>();
  let hasActiveFlakeJob = false;
  let ids: readonly string[];
  try {
    ids = cache.listJobIds();
  } catch {
    return { claimedTickets, nextAttempt: (_key: string) => 1, hasActiveFlakeJob };
  }
  for (const id of ids) {
    const receipt = cache.readJob<Job>(id);
    if (receipt.status !== 'ok' || !matchesProject(receipt.value)) continue;
    let key: string | undefined;
    if (receipt.value.ticket) {
      const tk = targetKey(receipt.value.ticket);
      if (tk.startsWith(prefix)) key = tk;
    }
    let keyAttempt = 0;
    if (typeof receipt.value.request_key === 'string' && receipt.value.request_key.startsWith(keyPrefix)) {
      const rest = receipt.value.request_key.slice(keyPrefix.length);
      const m = /^(.+):(\d+)$/.exec(rest);
      if (m) {
        const rkTicket = targetKey(m[1]);
        if (rkTicket.startsWith(prefix)) {
          key ??= rkTicket;
          keyAttempt = Number(m[2]);
        }
      }
    }
    if (!key) continue;
    const statusRes = cache.readStatus(id);
    const state = ticketJobState(receipt.value, statusRes.status === 'ok' ? statusRes.value : {});
    if (state === 'failed' || state === 'stopped') {
      failedCounts.set(key, (failedCounts.get(key) ?? 0) + 1);
      if (keyAttempt > (maxKeyAttempts.get(key) ?? 0)) maxKeyAttempts.set(key, keyAttempt);
    } else {
      claimedTickets.add(key);
    }
    if (checkActive) {
      if (!receipt.value.reaped_at && (!SETTLED_JOB_STATES.has(state) || state === 'idle_grace')) {
        hasActiveFlakeJob = true;
      } else {
        const prior = landAttempt(home, id).prior;
        if (prior && activeLand(prior)) hasActiveFlakeJob = true;
      }
    }
  }
  const nextAttempt = (ticket: string) => {
    const k = targetKey(ticket);
    return Math.max(failedCounts.get(k) ?? 0, maxKeyAttempts.get(k) ?? 0) + 1;
  };
  return { claimedTickets, nextAttempt, hasActiveFlakeJob };
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
    '**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).',
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

type TicketDispatchState =
  | { state: 'ready'; ticket: string; path: string }
  | { state: 'blocked'; ticket: string; path: string }
  | { state: 'resolved'; ticket: string };

function inspectRunningListTicket(
  mainRoot: string,
  feature: string,
  ticket: string,
  claimedTickets: ReadonlySet<string>,
): TicketDispatchState {
  const key = targetKey(ticket);
  if (claimedTickets.has(key)) return { state: 'resolved', ticket };
  const scratch = join(mainRoot, '.scratch');
  const item = listFeatureTickets(scratch, feature).find(t => targetKey(`${feature}/${nn(t.number)}`) === key);
  if (!item) return { state: 'resolved', ticket };
  const canonical = `${feature}/${nn(item.number)}`;
  try {
    const { bytes, truncated } = readFileBounded(item.path, MAX_TICKET_BYTES);
    if (truncated) return { state: 'resolved', ticket: canonical };
    const text = bytes.toString('utf8');
    if (!isRunningListTicket(text)) return { state: 'resolved', ticket: canonical };
    const evidence = ticketFileEvidence(text);
    if (evidence.landed !== undefined) return { state: 'resolved', ticket: canonical };
    if (!/^ready-for-agent$/i.test(evidence.status ?? '')) return { state: 'resolved', ticket: canonical };
    if (evidence.blocked !== undefined && evidence.blocked.trim() && !/^none\b/i.test(evidence.blocked.trim())) {
      return { state: 'blocked', ticket: canonical, path: item.path };
    }
    return { state: 'ready', ticket: canonical, path: item.path };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'resolved', ticket: canonical };
    return { state: 'blocked', ticket: canonical, path: item.path };
  }
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
    const inspected = inspectRunningListTicket(mainRoot, feature, ticket, claimedTickets);
    if (inspected.state === 'ready') return { ticket: inspected.ticket, path: inspected.path };
  }
  return null;
}

function dispatchAdmissionError(res: unknown): string | null {
  if (!res || typeof res !== 'object') return 'dispatch returned no result';
  const r = res as Record<string, unknown>;
  const job = typeof r.job === 'string' && r.job ? r.job : undefined;
  const failed = r.ok === false || r.state === 'failed' || r.state === 'stopped' ||
    r.display_state === 'failed' || r.display_state === 'stopped';
  if (!job || failed) {
    const why = (typeof r.reason === 'string' && r.reason) ||
      (typeof r.error === 'string' && r.error) ||
      (typeof r.code === 'string' && r.code) ||
      (failed && job ? `job ${job} is ${String(r.state ?? r.display_state ?? 'failed')}` : 'dispatch refused');
    return oneLine(why).slice(0, 300);
  }
  return null;
}

export function flakesFromLandFlow(flow: Pick<LandFlow, 'flow' | 'reruns'>): GateFlake[] {
  const out: GateFlake[] = [];
  for (const r of flow.reruns ?? []) {
    if (typeof r === 'string') continue;
    const passed = r.rerun_ok === true || !r.output_path;
    if (!passed) continue;
    if (r.cases?.length) {
      for (const item of r.cases) {
        const named = Boolean(item.name);
        out.push({
          name: item.name ?? item.file ?? r.step,
          ...(item.file ? { file: item.file } : {}),
          flow: flow.flow,
          ...(r.output_path ? { log: r.output_path } : {}),
          ...(!named ? { unidentified: true } : {}),
        });
      }
    } else {
      out.push({
        name: r.step,
        flow: flow.flow,
        ...(r.output_path ? { log: r.output_path } : {}),
        unidentified: true,
      });
    }
  }
  return out;
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
  if (!flakes.length && !landedFlake && !options?.retryDispatch) return {};

  let result: CollectFlakesResult = {};
  let alreadyRecorded = false;

  if (flakes.length) {
    try {
      const editRes = await withTicketEdits(mainRoot, home, 'flake', async (edits) => {
        const scratch = join(mainRoot, '.scratch');
        scanScratch(scratch, true);
        const existing = listFeatureTickets(scratch, feature).sort((a, b) => b.number - a.number);
        const maxNum = existing[0]?.number ?? 0;
        const { claimedTickets } = loadFeatureJobs(home, mainRoot, feature);

        // Scan running-list tickets: find the newest one and collect recorded cases for idempotent retry.
        const seenEntries: { entry: FlakeCase; ticket: string; path: string }[] = [];
        let newestRunning: { number: number; path: string; text: string } | undefined;
        for (const item of existing) {
          try {
            const text = edits.read(item.path);
            if (!isRunningListTicket(text)) continue;
            if (!newestRunning) newestRunning = { ...item, text };
            const ticket = `${feature}/${nn(item.number)}`;
            for (const entry of parseFlakeCases(text)) {
              seenEntries.push({ entry, ticket, path: item.path });
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

        const targetCases = openTarget ? parseFlakeCases(openTarget.text) : [];
        const toAdd: GateFlake[] = [];
        let matchedTarget: { ticket: string; path: string } | undefined;
        for (const flake of flakes) {
          const match = seenEntries.find(e => sameRecordedEntry(e.entry, flake));
          if (match) {
            matchedTarget ??= { ticket: match.ticket, path: match.path };
            continue;
          }
          toAdd.push(flake);
          seenEntries.push({ entry: { ...flake, log: formatLogPath(flake.log) }, ticket: '', path: '' });
        }
        if (!toAdd.length) {
          return {
            alreadyRecorded: true,
            res: matchedTarget
              ? { ticket: matchedTarget.ticket, path: matchedTarget.path, created: false, promoted: false }
              : openTarget
                ? { ticket: `${feature}/${nn(openTarget.number)}`, path: openTarget.path, created: false, promoted: false }
                : newestRunning
                  ? { ticket: `${feature}/${nn(newestRunning.number)}`, path: newestRunning.path, created: false, promoted: false }
                  : {},
          };
        }

        const allCases: FlakeCase[] = [...targetCases, ...toAdd.map(f => ({ ...f, log: formatLogPath(f.log) }))];
        const promoted = shouldTriggerDispatch(allCases);
        const lines = toAdd.map(formatFlakeLine);

        if (openTarget) {
          const ticket = `${feature}/${nn(openTarget.number)}`;
          const updated = appendCaseLines(openTarget.text, lines, promoted);
          const mode = fs.statSync(openTarget.path).mode & 0o777;
          await edits.stage({ ticket, path: openTarget.path, before: openTarget.text, after: updated, mode });
          return { alreadyRecorded: false, res: { ticket, path: openTarget.path, created: false, promoted } };
        }

        const nextNum = maxNum + 1;
        const ticket = `${feature}/${nn(nextNum)}`;
        const { title, body } = buildRunningListTicket(feature, nextNum, maxNum, lines, promoted);
        const path = join(scratch, feature, 'issues', `${nn(nextNum)}-${slugify(title, nextNum)}.md`);
        await edits.stage({ ticket, path, after: body });
        return { alreadyRecorded: false, res: { ticket, path, created: true, promoted } };
      });
      alreadyRecorded = editRes.alreadyRecorded;
      result = editRes.res;
    } catch (err) {
      const error = oneLine(err instanceof Error ? err.message : String(err)).slice(0, 300) || 'ticket edit refused';
      return { pending: { stage: 'edit', error } };
    }
  }

  const mustDispatchTicket = result.promoted
    ? result.ticket
    : options?.retryDispatch
      ? options.pendingTicket
      : alreadyRecorded
        ? result.ticket
        : undefined;

  if (result.promoted || landedFlake || options?.retryDispatch || alreadyRecorded) {
    const dispatchOutcome = await withAbstractLock('land-flakes-dispatch', `${home}\0${sharedRoot(mainRoot)}\0${feature}`, async () => {
      const { claimedTickets, nextAttempt, hasActiveFlakeJob } = loadFeatureJobs(home, mainRoot, feature);
      let candidate: { ticket: string; path: string } | null = null;
      if (mustDispatchTicket) {
        const inspected = inspectRunningListTicket(mainRoot, feature, mustDispatchTicket, claimedTickets);
        if (inspected.state === 'resolved') {
          if (landedFlake && !options?.retryDispatch && !hasActiveFlakeJob) {
            candidate = findReadyRunningListTicket(mainRoot, feature, claimedTickets);
          }
          if (!candidate) return {};
        } else if (inspected.state === 'blocked') {
          return { pending: { stage: 'dispatch' as const, error: BLOCKED_DISPATCH_ERROR, ticket: inspected.ticket } };
        } else if (hasActiveFlakeJob) {
          return { pending: { stage: 'dispatch' as const, error: WAITING_DISPATCH_ERROR, ticket: inspected.ticket } };
        } else {
          candidate = { ticket: inspected.ticket, path: inspected.path };
        }
      } else if (options?.retryDispatch) {
        const ready = findReadyRunningListTicket(mainRoot, feature, claimedTickets);
        if (!ready) return {};
        if (hasActiveFlakeJob) {
          return { pending: { stage: 'dispatch' as const, error: WAITING_DISPATCH_ERROR, ticket: ready.ticket } };
        }
        candidate = ready;
      } else {
        if (hasActiveFlakeJob) return {};
        candidate = findReadyRunningListTicket(mainRoot, feature, claimedTickets);
        if (!candidate) return {};
      }
      const validPane = pane && herdrId(pane) ? pane : undefined;
      const input = {
        role: 'imp' as const,
        cwd: mainRoot,
        isolation: 'worktree' as const,
        ticket: candidate.ticket,
        brief_file: candidate.path,
        request_key: flakeDispatchKey(mainRoot, candidate.ticket, nextAttempt(candidate.ticket)),
      };
      try {
        const res = options?.dispatch
          ? await options.dispatch(input, validPane)
          : await dispatchTicketJob(
              { role: input.role, cwd: input.cwd, ticket: input.ticket, brief_file: input.brief_file, request_key: input.request_key },
              validPane,
            );
        const error = dispatchAdmissionError(res);
        if (error) return { pending: { stage: 'dispatch' as const, error, ticket: candidate.ticket } };
        if (!options?.dispatch) ensureJobWatcher(home);
        return { job: (res as { job: string }).job, ticket: candidate.ticket };
      } catch (err) {
        const error = oneLine(err instanceof Error ? err.message : String(err)).slice(0, 300) || 'dispatch threw';
        return { pending: { stage: 'dispatch' as const, error, ticket: candidate.ticket } };
      }
    });
    if (dispatchOutcome.job) {
      result.dispatchedJob = dispatchOutcome.job;
      result.ticket ??= dispatchOutcome.ticket;
    } else if (dispatchOutcome.pending) {
      result.pending = dispatchOutcome.pending;
    }
  }

  return result;
}

function landedTicketsForFlow(home: string, flow: LandFlow): string[] {
  if (flow.state !== 'completed') return [];
  try {
    const receipt = readJsonFile(join(home, 'jobs', flow.job, jobFiles.job)) as Job;
    return typeof receipt.ticket === 'string' && receipt.ticket ? [receipt.ticket] : [];
  } catch {
    return [];
  }
}

export async function collectAndRecordLandFlakes(
  home: string,
  mainRoot: string,
  flow: LandFlow,
  options?: { landedTickets?: readonly string[]; pane?: string | null; dispatch?: CollectFlakesOptions['dispatch'] },
): Promise<CollectFlakesResult> {
  const config = readFlakesConfig(mainRoot);
  if (!config) return {};
  const flakes = flakesFromLandFlow(flow);
  const landedTickets = options?.landedTickets ?? landedTicketsForFlow(home, flow);
  const landedFlake = landedTickets.some(t => targetKey(t).startsWith(`${config.feature.toLowerCase()}/`));
  const prev = flow.flake_collection;
  const wasPending = prev?.state === 'pending';
  if (!flakes.length && !landedFlake && !wasPending) return {};

  const retryDispatch = wasPending && prev?.stage === 'dispatch';
  const effectivePane = options?.pane !== undefined ? options.pane : flow.pane;
  const res = await collectGateFlakes(
    home,
    mainRoot,
    retryDispatch ? [] : flakes,
    effectivePane,
    {
      landedTickets,
      retryDispatch,
      ...(retryDispatch && prev?.ticket ? { pendingTicket: prev.ticket } : {}),
      dispatch: options?.dispatch,
    },
  );

  const attempts = (prev?.attempts ?? 0) + 1;
  const updated_at = new Date().toISOString();
  if (res.pending) {
    const ticket = res.pending.ticket ?? res.ticket ?? prev?.ticket;
    const unchanged = prev?.state === 'pending' &&
      prev.stage === res.pending.stage &&
      prev.error === res.pending.error &&
      prev.ticket === ticket;
    if (!unchanged) {
      const collection: LandFlakeCollection = {
        state: 'pending',
        stage: res.pending.stage,
        error: res.pending.error,
        ...(ticket ? { ticket } : {}),
        attempts,
        updated_at,
      };
      await updateLandFlakeCollection(home, flow.flow, collection);
    }
  } else if (res.ticket || res.dispatchedJob || wasPending) {
    const ticket = res.ticket ?? prev?.ticket;
    const collection: LandFlakeCollection = {
      state: 'done',
      ...(ticket ? { ticket } : {}),
      ...(res.dispatchedJob ? { job: res.dispatchedJob } : {}),
      attempts,
      updated_at,
    };
    await updateLandFlakeCollection(home, flow.flow, collection);
  }
  return res;
}

const EMPTY_CLAIMED: ReadonlySet<string> = new Set();

export function hasPendingFlakeCollection(
  home: string,
  flow: Partial<Pick<LandFlow, 'wt' | 'flake_collection'>> | null | undefined,
): boolean {
  const fc = flow?.flake_collection;
  if (!fc || fc.state !== 'pending') return false;
  if (fc.stage !== 'dispatch' || !fc.ticket) return true;
  const mainRoot = flow.wt?.main_root;
  if (typeof mainRoot !== 'string' || !mainRoot) return true;
  const config = readFlakesConfig(mainRoot);
  if (!config) return true;
  if (inspectRunningListTicket(mainRoot, config.feature, fc.ticket, EMPTY_CLAIMED).state === 'resolved') return false;
  const { claimedTickets } = loadFeatureJobs(home, mainRoot, config.feature, false);
  return !claimedTickets.has(targetKey(fc.ticket));
}

export function listPendingFlakeFlows(home: string, mainRoot: string, excludeFlow?: string): LandFlow[] {
  const dir = join(home, 'flows');
  const names = readDirSafe(dir);
  if (!names.length) return [];
  const targetRoot = sharedRoot(mainRoot);
  const pending: LandFlow[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (id === excludeFlow || !isFlowId(id)) continue;
    try {
      const f = readJsonBounded(landFile(home, id), MAX_FLOW_BYTES) as LandFlow | null;
      if (!f || activeLand(f) || f.flake_collection?.state !== 'pending') continue;
      const flowMain = f.wt?.main_root;
      if (!flowMain || (flowMain !== mainRoot && sharedRoot(flowMain) !== targetRoot)) continue;
      pending.push(f);
    } catch { /* Skip unreadable flow receipt. */ }
  }
  return pending.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.flow.localeCompare(b.flow));
}

export async function retryPendingFlakeCollections(
  home: string,
  mainRoot: string,
  pane: string | null,
  options?: { excludeFlow?: string; dispatch?: CollectFlakesOptions['dispatch'] },
): Promise<{ retried: number; resolved: number; pending: number }> {
  if (!readFlakesConfig(mainRoot)) return { retried: 0, resolved: 0, pending: 0 };
  if (!listPendingFlakeFlows(home, mainRoot, options?.excludeFlow).length) {
    return { retried: 0, resolved: 0, pending: 0 };
  }
  return withAbstractLock('land-flakes-retry', `${home}\0${sharedRoot(mainRoot)}`, async () => {
    const flows = listPendingFlakeFlows(home, mainRoot, options?.excludeFlow);
    let retried = 0;
    let resolved = 0;
    let pending = 0;
    for (const flow of flows) {
      retried++;
      const res = await collectAndRecordLandFlakes(home, mainRoot, flow, {
        pane: pane ?? flow.pane,
        dispatch: options?.dispatch,
      });
      if (res.pending) pending++;
      else resolved++;
    }
    return { retried, resolved, pending };
  });
}
