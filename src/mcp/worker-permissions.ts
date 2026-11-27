import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { hasLocalHerdrTarget, request } from '../runtime/herdr-socket.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { readDirSafe, readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';
import { claimDelivery, type DeliveryNotice } from '../utils/delivery-record.js';
import { isProcAlive, readProcCwd, readProcEnviron } from '../utils/proc.js';
import { getJobIndexCache, type JobIndexCache } from '../roles/job-index-cache.js';
import type { Job, JobStatus } from './job-contracts.js';
import { jobFiles } from './paths.js';
import { classifyPermission, provePermission, type PermissionDecision, type PermissionTarget } from './permission-policy.js';

const MAX_LOG = 12;
const MAX_LEDGER_BYTES = 65_536;
const PERMISSION_LOCK_TIMEOUT_MS = 10_000;
const FOOTER = /^(?:(?:Enter to (?:select|confirm) · )?(?:(?:Tab\/arrow keys|↑\/↓|↑↓|arrows|arrow keys) to navigate · )?Esc to cancel|Enter to (?:select|confirm) · (?:Esc to cancel|Tab to amend)(?: · Esc to cancel)?|Press enter to confirm or esc to cancel)(?:\s*·\s*(?:Tab to amend|Ctrl\+e to explain))*$/i;
const CLAUDE_TITLE = /^(?:Bash command|(?:Edit|Write|Create) file(?::?\s+.+)?|Do you want to allow this connection\?)$/i;
const CLAUDE_COUNTDOWN = /^⚠\uFE0F? Claude Code will automatically block this request in \d+:[0-5]\d, to avoid holding up an unattended session$/;
const MAX_COUNTDOWN_LINES = 4;
const BOTTOM_BORDER = /^[╰╯─━—]+$/;
const OTHER_TITLE = /^(?:Permission required|Permission request|Tool approval required|Command approval required|(?:Edit|Write|Create|File) approval required|(?:Edit|Write|Create) file(?::?\s+.+)?|Allow command\?|Would you like to (?:run the following command|make the following edits)\?)$/i;
const CWD_LINE = /^(?:Cwd|Working directory|Directory):\s+(.+)$/i;
const FILE_LINE = /^(?:File|Path):\s+(.+)$/i;
const CLAUDE_FILE_TITLE = /^(Edit|Write|Create) file(?::?\s+(.+))?$/i;
const CLAUDE_FILE_QUESTION = /^Do you want to (?:make this edit to|create|overwrite) (.+)\?$/i;
const CODEX_EDIT_LINE = /^(?:(?:\*\*\*\s+)?(?:Update|Add)\s+File:\s+|(?:Edit|Write|Create|Modify|Update|Add)(?:\s+file)?:\s+|(?:File|Path):\s+|[MAU]\s+)?([^\s]+)(?:\s+\(\+\d+\s+-\d+\))?$/i;
const PI_FILE_LINE = /^(Edit|Write|Create|File|Path):\s+(.+)$/i;
export const PERMISSION_ID = /^perm-[a-f0-9]{16}$/;
type Option = { label: string; value?: 'approve' | 'decline' };
type Prompt = { text: string; command?: string; target?: PermissionTarget; options: Option[]; selected: number; manualReason?: string };
type Capture = Prompt | 'unrecognized' | null | undefined;
export type PermissionEntry = PermissionDecision & {
  id: string; key: string; launch: string; pane: string; at: string; text: string;
  options: Option[]; selected?: number;
  outcome: 'pending' | 'gone' | 'sending' | 'answered' | 'uncertain'; answer?: 'approve' | 'decline';
  resolved_at?: string;
};
type Ledger = { active?: string; entries: PermissionEntry[] };

function isClaudeCountdown(lines: readonly string[]): boolean {
  if (!lines.length || lines.length > MAX_COUNTDOWN_LINES || !lines[0].startsWith('⚠')) return false;
  const match = (index: number, prefix: string): boolean => {
    if (index === lines.length) return CLAUDE_COUNTDOWN.test(prefix);
    return match(index + 1, `${prefix} ${lines[index]}`) || match(index + 1, `${prefix}${lines[index]}`);
  };
  return match(1, lines[0]);
}

function stripClaudeCountdown(lines: string[]): boolean {
  for (let start = 0; start < lines.length; start++) {
    if (!lines[start].startsWith('⚠')) continue;
    const maxLen = Math.min(MAX_COUNTDOWN_LINES, lines.length - start);
    for (let len = 1; len <= maxLen; len++) {
      if (isClaudeCountdown(lines.slice(start, start + len))) {
        lines.splice(start, len);
        return true;
      }
    }
  }
  return false;
}

/** Parse the visible native menu, never a recent/scrollback tail. Unsupported layouts never send keys. */
export function parsePermissionPrompt(screen: string, harness: string): Prompt | null {
  const normalized = screen.replaceAll('\r\n', '\n');
  const cleanLine = (line: string) => line.trim().replace(/^[│║]\s*|\s*[│║]$/g, '').trim();
  const title = harness === 'claude' ? CLAUDE_TITLE : OTHER_TITLE;
  const manual = (text: string, manualReason: string): Prompt => ({ text, options: [], selected: -1, manualReason });
  const oversized = 'The visible permission preview exceeds the safe parsing limit.';
  const unsafe = /[\x00-\x09\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(normalized);
  if (screen.length > 32_768 || unsafe) {
    // Only identify a possible menu; do not parse controls or keep an unsafe or oversized preview.
    for (const [line] of normalized.matchAll(/[^\n]+/g)) {
      const heading = cleanLine(line);
      if (title.test(heading)) return unsafe ? manual('Native permission prompt', 'The visible permission menu contains unsupported characters.')
        : manual(heading.slice(0, 120), oversized);
    }
    return null;
  }
  const lines = normalized.split('\n').map(cleanLine);
  if (!lines.some(line => title.test(line))) return null;
  const headings = lines.flatMap((line, i) => CLAUDE_TITLE.test(line) || OTHER_TITLE.test(line) ? [i] : []);
  const body = lines.slice(headings[0]).filter(Boolean);
  while (BOTTOM_BORDER.test(body.at(-1) ?? '')) body.pop();
  const text = body.join('\n');
  if (Buffer.byteLength(text) > 3500) return manual(body[0].slice(0, 120), oversized);
  // On a confirmed block, an earlier complete menu (or a heading in a preview) makes the current menu ambiguous.
  if (headings.length !== 1) return manual(text, 'The visible pane contains multiple permission menu headings.');
  // Output after a single finished menu is not evidence of a permission wait.
  const unknownLayout = () => body.slice(1, -1).some(line => FOOTER.test(line) || /^╰[─━—]+╯$/.test(line)) ? null
    : manual(text, 'HUD could not safely map the visible permission menu.');
  // In a visible box, the heading must be its first row, never a row of the command preview.
  const preceding = lines.slice(0, headings[0]).filter(Boolean).reverse();
  const box = preceding.findIndex(line => /^(?:╭[─━—]+╮|╰[─━—]+╯)$/.test(line));
  if (box > 0 && preceding[box].startsWith('╭')) return unknownLayout();
  const question = body.findIndex(line => /^(?:Do you want to (?:proceed|allow this connection|make this edit(?: to .+)?|create .+|overwrite .+)\?|Allow this (?:tool|command|edit)\?)$/i.test(line));
  let firstOption = body.findIndex(line => /^(?:[❯›>]\s*)?1[.)]\s+/.test(line));
  if (firstOption < 1 || (harness === 'claude' && (question < 0 || question >= firstOption))) return unknownLayout();
  // Treat the native countdown as menu chrome, never as part of a command preview or option label.
  if (harness === 'claude' && firstOption > question + 1 && isClaudeCountdown(body.slice(question + 1, firstOption))) {
    body.splice(question + 1, firstOption - question - 1);
    firstOption = question + 1;
  }
  const options: Option[] = [];
  let selected = -1;
  let i = firstOption;
  for (; i < body.length; i++) {
    const match = /^([❯›>])?\s*(\d+)[.)]\s+(.+)$/.exec(body[i]);
    if (!match || Number(match[2]) !== options.length + 1) break;
    if (match[1]) selected = selected < 0 && selected !== -2 ? options.length : -2;
    const label = match[3];
    const value = /^(?:Yes|Yes, proceed(?: \(y\))?|Yes, allow once|Allow once|Approve once)(?:[.!])?$/i.test(label) ? 'approve'
      : /^(?:No|No, and tell (?:Claude|Codex) what to do differently(?: \(esc\))?|Deny|Decline|Cancel)(?:[.!])?$/i.test(label) ? 'decline' : undefined;
    options.push({ label, value });
  }
  if (options.length < 2 || options.length > 6 || selected < 0) return unknownLayout();
  const footerLines = body.slice(i);
  if (harness === 'claude' && stripClaudeCountdown(footerLines)) {
    while (BOTTOM_BORDER.test(footerLines.at(-1) ?? '')) footerLines.pop();
  }
  const footer = footerLines.join(' ');
  if (!FOOTER.test(footer)) return unknownLayout();
  const parsedTarget = parsePromptTarget(harness, body, question, firstOption);
  if (parsedTarget.manualReason) return manual(text, parsedTarget.manualReason);
  return {
    text: [...body.slice(0, firstOption), ...options.map((option, i) => `${i + 1}. ${option.label}`), footer].join('\n'),
    command: parsedTarget.command,
    target: parsedTarget.target,
    options,
    selected,
  };
}

function fileOpKind(verb: string): 'file_edit' | 'file_write' | 'file_create' {
  const lower = verb.toLowerCase();
  return lower === 'create' ? 'file_create' : lower === 'write' ? 'file_write' : 'file_edit';
}

function extractSingleCwd(lines: string[]): { cwd?: string; rest: string[] } | null {
  let cwd: string | undefined;
  const rest: string[] = [];
  for (const line of lines) {
    const match = CWD_LINE.exec(line);
    if (match) {
      if (cwd !== undefined) return null;
      cwd = match[1].trim();
    } else {
      rest.push(line);
    }
  }
  return { cwd, rest };
}

function parsePromptTarget(harness: string, body: string[], question: number, firstOption: number): Pick<Prompt, 'command' | 'target' | 'manualReason'> {
  const heading = body[0];
  if (harness === 'claude') {
    if (firstOption !== question + 1) return {};
    const split = extractSingleCwd(body.slice(1, question));
    if (!split) return {};
    if (/^Bash command$/i.test(heading)) {
      if (split.rest.length !== 1) return {};
      const command = split.rest[0];
      return { command, target: { kind: 'shell', command, cwd: split.cwd } };
    }
    const fileHeading = CLAUDE_FILE_TITLE.exec(heading);
    if (fileHeading) {
      let path = fileHeading[2]?.trim();
      let cwd: string | undefined;
      if (path) {
        // A Cwd-shaped line inside a diff preview is not reliable cwd evidence.
        if (split.rest.length === 0) cwd = split.cwd;
      } else if (split.rest.length === 1) {
        cwd = split.cwd;
        path = FILE_LINE.exec(split.rest[0])?.[1]?.trim() ?? split.rest[0];
      } else if (split.rest.length > 1) {
        const labeled = split.rest.map(line => FILE_LINE.exec(line)?.[1]?.trim()).filter((v): v is string => !!v);
        if (labeled.length === 1 && FILE_LINE.test(split.rest[0])) path = labeled[0];
      }
      const qPath = CLAUDE_FILE_QUESTION.exec(body[question])?.[1]?.trim();
      if (qPath) {
        if (path) {
          // Claude may abbreviate the question to just the filename, but a qualified path must agree exactly.
          if (qPath !== path && (qPath !== basename(qPath) || qPath !== basename(path))) {
            return { manualReason: 'The displayed file paths disagree; HUD cannot verify the target.' };
          }
        } else if (split.rest.length === 0 && isAbsolute(qPath)) {
          cwd = split.cwd;
          path = qPath;
        }
      }
      if (!path) return {};
      return { target: { kind: fileOpKind(fileHeading[1]), paths: [path], cwd } };
    }
    return {};
  }

  const end = question > 0 && question < firstOption ? question : firstOption;
  const split = extractSingleCwd(body.slice(1, end));
  if (!split) return {};

  if (harness === 'codex') {
    if (/^Would you like to run the following command\?$/i.test(heading)) {
      if (split.rest.length !== 1 || !split.rest[0].startsWith('$ ')) return {};
      const command = split.rest[0].slice(2);
      return { command, target: { kind: 'shell', command, cwd: split.cwd } };
    }
    if (/^Would you like to make the following edits\?$/i.test(heading)) {
      if (!split.rest.length || split.rest.length > 32) return {};
      const paths: string[] = [];
      for (const line of split.rest) {
        if (/^(?:(?:\*\*\*\s+)?Delete\s+File:|Delete(?:\s+file)?:|D\s+)/i.test(line)) return {};
        const match = CODEX_EDIT_LINE.exec(line);
        if (!match?.[1]) return {};
        paths.push(match[1]);
      }
      return { target: { kind: 'file_edit', paths, cwd: split.cwd } };
    }
    return {};
  }

  if (harness === 'pi') {
    if (/^(?:Command approval required|Allow command\?|Tool approval required|Permission required|Permission request)$/i.test(heading)) {
      let command: string | undefined;
      let ok = true;
      for (const line of split.rest) {
        if (/^Tool:\s+(?:bash|shell|command)$/i.test(line)) continue;
        if (line.startsWith('Command: ')) {
          if (command !== undefined) { ok = false; break; }
          command = line.slice('Command: '.length);
        } else {
          ok = false; break;
        }
      }
      if (ok && command !== undefined) return { command, target: { kind: 'shell', command, cwd: split.cwd } };
    }
    const fileHeading = CLAUDE_FILE_TITLE.exec(heading);
    const approvalHeading = /^(Edit|Write|Create|File) approval required$/i.exec(heading);
    if (fileHeading || approvalHeading || /^(?:Tool approval required|Permission required|Permission request)$/i.test(heading)) {
      let kind: 'file_edit' | 'file_write' | 'file_create' | undefined = fileHeading
        ? fileOpKind(fileHeading[1])
        : approvalHeading && approvalHeading[1].toLowerCase() !== 'file' ? fileOpKind(approvalHeading[1]) : undefined;
      const paths: string[] = [];
      if (fileHeading?.[2]) paths.push(fileHeading[2].trim());
      for (const line of split.rest) {
        const toolMatch = /^Tool:\s+(edit|write|create)$/i.exec(line);
        if (toolMatch) {
          const toolKind = fileOpKind(toolMatch[1]);
          if (kind && kind !== toolKind) return {};
          kind = toolKind;
          continue;
        }
        const pathMatch = PI_FILE_LINE.exec(line);
        if (!pathMatch) return {};
        const label = pathMatch[1].toLowerCase();
        if (label === 'edit' || label === 'write' || label === 'create') {
          const lineKind = fileOpKind(label);
          if (kind && kind !== lineKind) return {};
          kind = lineKind;
        }
        paths.push(pathMatch[2].trim());
      }
      if (kind && paths.length > 0 && paths.length <= 32) {
        return { target: { kind, paths, cwd: split.cwd } };
      }
    }
  }
  return {};
}

function validLedger(value: Ledger | undefined): value is Ledger {
  return !!value && Array.isArray(value.entries) && value.entries.length <= MAX_LOG &&
    value.entries.every(entry => entry && typeof entry.text === 'string' && typeof entry.reason === 'string' && Array.isArray(entry.options));
}
function ledger(dir: string, strict = false): Ledger {
  try {
    const value = readJsonBounded(join(dir, jobFiles.permissions), MAX_LEDGER_BYTES) as Ledger;
    if (!validLedger(value)) throw Error('invalid permission record');
    return value;
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { entries: [] };
  }
}
const PERMISSION_NOTICE_MARKER = /^(perm-[a-f0-9]{16})\.(?:noticed|observed)$/;
function prunePermissionNoticeMarkers(dir: string, state: Ledger) {
  const kept = new Set(state.entries.map(entry => entry.id));
  try {
    for (const file of readDirSafe(dir)) {
      const match = PERMISSION_NOTICE_MARKER.exec(file);
      if (match && !kept.has(match[1])) rmSync(join(dir, file), { force: true });
    }
  } catch { /* Best-effort marker cleanup must not fail ledger writes. */ }
}
function save(dir: string, state: Ledger) {
  while (state.entries.length > 1 && Buffer.byteLength(JSON.stringify(state)) >= MAX_LEDGER_BYTES) state.entries.shift();
  writeJsonPrivate(join(dir, jobFiles.permissions), state, { mkdir: false });
  prunePermissionNoticeMarkers(dir, state);
}
const current = (state: Ledger) => state.entries.at(-1)?.id === state.active ? state.entries.at(-1) : undefined;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function permissionStatus(dir: string, cache?: JobIndexCache) {
  const read = cache?.readJson<Ledger>(join(dir, jobFiles.permissions));
  const state = read ? (read.status === 'ok' ? read.value : undefined) : ledger(dir);
  return validLedger(state) ? { active: current(state), latest: state.entries.at(-1) } : {};
}

export function permissionBlockAt(status: Partial<JobStatus> | null | undefined, statusAt?: number | null) {
  const at = Date.parse(status?.blocked_at ?? status?.updated_at ?? '');
  return Number.isFinite(at) ? at : statusAt ?? -Infinity;
}

export const permissionPredatesBlock = (entry: PermissionEntry, blockAt: number) =>
  blockAt > Date.parse(entry.resolved_at ?? entry.at);

// Allow the watcher's 30 s safety check plus capture, classification, and a fresh menu check.
export const PERMISSION_GRACE_MS = 45_000;

export function permissionRecheckMs(
  dir: string,
  job: Pick<Job, 'job' | 'cli' | 'reaped_at' | 'headless' | 'bro' | 'jev'>,
  status: Partial<JobStatus> | null | undefined,
  statusAt: number | null | undefined,
  cache?: JobIndexCache,
  recheckCapMs = 5_000,
): number {
  if ((!status?.blocked && status?.state !== 'blocked') || !job.cli || job.reaped_at || job.headless || job.bro || job.jev) return 0;
  const index = cache ?? getJobIndexCache(dirname(dirname(dir)));
  if (!permissionTarget(index.readSession(job.job))) return 0;
  const blockAt = permissionBlockAt(status, statusAt);
  // A menu may clear before the supervisor publishes that the worker is running again.
  const latest = permissionStatus(dir, index).latest;
  const resolvedAt = latest?.resolved_at && !permissionPredatesBlock(latest, blockAt) ? Date.parse(latest.resolved_at) : -Infinity;
  const left = Math.max(blockAt, resolvedAt) + PERMISSION_GRACE_MS - Date.now();
  return left > 0 ? Math.min(left, recheckCapMs) : 0;
}

export function permissionNoticeable(entry: PermissionEntry | undefined): entry is PermissionEntry {
  return !!entry && PERMISSION_ID.test(entry.id) &&
    (entry.outcome === 'uncertain' || (entry.action === 'main' && entry.outcome === 'pending'));
}

export const permissionNoticeMarker = (dir: string, id: string, all = false) =>
  join(dir, `${id}.${all ? 'observed' : 'noticed'}`);

export function claimPermissionNotice(dir: string, entry: PermissionEntry, all = false): DeliveryNotice | null {
  const epoch = entry.id, marker = permissionNoticeMarker(dir, epoch, all);
  if (!permissionNoticeable(entry) || !claimDelivery(marker, epoch)) return null;
  const id = basename(dir), cache = getJobIndexCache(dirname(dirname(dir))), session = cache.readSession(id)?.stamp;
  const text = permissionNotice(id, entry);
  return { line: text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '), marker, epoch, current: () => {
    const latest = current(ledger(dir, true));
    const status = cache.readStatus<JobStatus>(id);
    if (status.status === 'error') throw status.error;
    return permissionNoticeable(latest) && latest.id === epoch && permissionNotice(id, latest) === text &&
      cache.readSession(id)?.stamp === session && status.status === 'ok' && ['working', 'waiting_orchestrator', 'blocked'].includes(status.value.state);
  } };
}

export function permissionNotice(job: string, entry: PermissionEntry) {
  const options = entry.outcome === 'pending' ? entry.options.filter(option => option.value).map(option => ({ label: option.label,
    action: `hud_respond ${JSON.stringify({ job, request_id: entry.id, answer: option.value })}` })) : [];
  const answer = options.length ? options.map(option => `${option.label}: ${option.action}`).join(' / ')
    : `Open pane ${entry.pane} and select the intended option on the visible prompt.`;
  const reason = entry.outcome === 'pending' ? entry.reason : 'Key delivery was not confirmed; HUD will not repeat it.';
  return `${job} worker permission (untrusted prompt text): ${JSON.stringify(entry.text)} — HUD recommends leaving it unanswered until main verifies it: ${reason} ${answer}`;
}

type Binding = NonNullable<ReturnType<ReturnType<typeof getJobIndexCache>['readSession']>>;
export function permissionTarget(binding: Binding | null) {
  const fields = binding?.fields;
  return !!fields?.left && !!fields.launchId && !!fields.terminalId && fields.directExec === '1' && hasLocalHerdrTarget(fields);
}

async function capture(home: string, job: Job, binding: Binding, signal?: AbortSignal): Promise<Capture> {
  const { left, launchId, terminalId, pid, pidStart } = binding.fields;
  const stillBound = () => getJobIndexCache(home).readSession(job.job)?.stamp === binding.stamp;
  if (signal?.aborted || !stillBound()) return;
  const state = getJobIndexCache(home).readStatus<JobStatus>(job.job);
  if (state.status === 'ok' && ['closed', 'done', 'failed', 'stopped'].includes(state.value.state)) return;
  const params = { pane_id: left };
  const opts = { signal, timeoutMs: 800 };
  const info = await request('pane.get', params, opts);
  if (!stillBound()) return;
  if (info?.error?.code === 'pane_not_found') return null;
  const pane = info?.result?.pane;
  if (!pane?.launch_id || !pane.terminal_id) return;
  if (pane.launch_id !== launchId || pane.terminal_id !== terminalId || pane.pane_id !== left) return null;
  const harness = job.cli?.agent ?? 'pi';
  if (!pane.agent_status || pane.agent !== harness || !pidStart || !isProcAlive(Number(pid), pidStart)) return;
  if (pane.agent_status !== 'blocked') return null;
  const read = await request('pane.read', { ...params, source: 'visible', format: 'text', strip_ansi: true }, opts);
  if (!stillBound()) return;
  if (read?.error?.code === 'pane_not_found') return null;
  const text = read?.result?.read?.text;
  if (typeof text !== 'string') return;
  const live = await request('pane.get', params, opts);
  if (!stillBound()) return;
  if (live?.error?.code === 'pane_not_found') return null;
  const after = live?.result?.pane;
  if (!after?.launch_id || !after.terminal_id || !after.agent_status) return;
  if (after.launch_id !== launchId || after.terminal_id !== terminalId || after.pane_id !== left) return null;
  if (after.agent !== harness || !isProcAlive(Number(pid), pidStart)) return;
  if (after.agent_status !== 'blocked') return null;
  // A clipped or changed layout is not proof that the native prompt went away.
  return parsePermissionPrompt(text, harness) ?? 'unrecognized';
}

function proofFor(dir: string, job: Job, binding: Binding, prompt: Prompt) {
  const { pid, pidStart } = binding.fields;
  if (!prompt.target || !pidStart || !isProcAlive(Number(pid), pidStart)) return;
  const env = readProcEnviron(Number(pid));
  if (!env || env.HUD_JOB_DIR !== dir || env.BASH_ENV || env.ENV || env.CDPATH ||
      Object.keys(env).some(key => key.startsWith('BASH_FUNC_'))) return;
  const worktree = job.worktree?.root && (!job.worktree.owner || job.worktree.owner === job.job) ? job.worktree.root : undefined;
  // Only shell prompts can use process cwd; native tools must display their own base directory.
  const cwd = prompt.target.kind === 'shell' && !prompt.target.cwd ? readProcCwd(Number(pid)) ?? undefined : undefined;
  if (!isProcAlive(Number(pid), pidStart)) return;
  return provePermission(prompt.target, { task: dir, worktree, cwd, path: env.PATH ?? '' });
}

const fingerprint = (binding: Binding, prompt: Prompt) => hash(JSON.stringify([
  binding.fields.left, binding.fields.launchId, binding.fields.terminalId,
  prompt.manualReason ? ['manual', prompt.text] : prompt.text, prompt.command, prompt.target,
]));
const permissionId = (key: string, prior?: string) => `perm-${hash(`${key}\0${Date.now()}\0${prior ?? ''}`).slice(0, 16)}`;
function appendEntry(state: Ledger, binding: Binding, prompt: Prompt, decision: PermissionDecision) {
  const key = fingerprint(binding, prompt);
  const entry: PermissionEntry = { ...decision, id: permissionId(key, state.entries.at(-1)?.id), key,
    launch: binding.fields.launchId!, pane: binding.fields.left!, at: new Date().toISOString(), text: prompt.text,
    options: prompt.selected < 0 ? [] : prompt.options, selected: prompt.selected, outcome: 'pending' };
  state.entries = [...state.entries, entry].slice(-MAX_LOG);
  state.active = entry.id;
  return entry;
}
function requireManual(entry: PermissionEntry, reason: string) {
  entry.action = 'main'; entry.reason = reason; entry.options = [];
}
function retire(state: Ledger, entry: PermissionEntry) {
  if (entry.outcome === 'pending') { entry.outcome = 'gone'; entry.resolved_at = new Date().toISOString(); }
  if (entry.outcome === 'sending') entry.outcome = 'uncertain';
  delete state.active;
}

async function sendAnswer(home: string, dir: string, job: Job, binding: Binding, state: Ledger, entry: PermissionEntry,
  answer: 'approve' | 'decline', observed: Capture, signal?: AbortSignal) {
  if (entry.outcome !== 'pending') return { ok: entry.outcome === 'answered', written: false, code: entry.outcome };
  const gone = () => {
    retire(state, entry); save(dir, state);
    return { ok: false, written: false, code: 'gone' };
  };
  if (observed === null) return gone();
  if (!observed || signal?.aborted || existsSync(join(dir, jobFiles.stopRequested))) return { ok: false, written: false, code: 'prompt_unavailable' };
  const changed = () => {
    requireManual(entry, 'The visible prompt or its selected option changed or could not be confirmed before delivery; no key was sent.');
    state.active = entry.id = permissionId(entry.key, entry.id);
    save(dir, state);
    return { ok: false, written: false, code: 'prompt_changed' };
  };
  if (observed === 'unrecognized' || fingerprint(binding, observed) !== entry.key || observed.selected !== entry.selected) return changed();
  const matches = observed.options.flatMap((option, i) => option.value === answer ? [i] : []);
  if (observed.selected < 0 || matches.length !== 1) return { ok: false, written: false, code: 'option_unavailable' };
  const delta = matches[0] - observed.selected;
  const keys = [...Array<string>(Math.abs(delta)).fill(delta < 0 ? 'Up' : 'Down'), 'Enter'];
  const fresh = await capture(home, job, binding, signal);
  if (signal?.aborted || existsSync(join(dir, jobFiles.stopRequested))) return { ok: false, written: false, code: 'prompt_unavailable' };
  if (fresh === null) return gone();
  if (!fresh || fresh === 'unrecognized' || fingerprint(binding, fresh) !== entry.key || fresh.selected !== observed.selected) return changed();
  // HerdR provides no conditional key send. Spend before this single write; never retry a lost reply or crash.
  entry.outcome = 'sending'; entry.answer = answer; entry.resolved_at = new Date().toISOString(); save(dir, state);
  const reply = await request('pane.send_keys', { pane_id: entry.pane, keys }, { signal, timeoutMs: 800 });
  entry.outcome = reply?.result?.type === 'ok' && !reply.error ? 'answered' : reply?.error?.code === 'pane_not_found' ? 'gone' : 'uncertain';
  if (entry.outcome === 'gone') delete state.active;
  save(dir, state);
  return { ok: entry.outcome === 'answered', written: entry.outcome === 'answered', code: entry.outcome };
}

export async function observeWorkerPermission(home: string, dir: string, job: Job, _status: Partial<JobStatus> | null,
  binding: Binding, signal: AbortSignal) {
  return withAbstractLock('worker-permission', dir, async () => {
    const observed = await capture(home, job, binding, signal);
    if (observed === undefined || signal.aborted) return;
    const state = ledger(dir, true);
    const previous = current(state);
    if (previous) {
      if (observed && previous.launch === binding.fields.launchId && previous.pane === binding.fields.left) {
        const same = observed !== 'unrecognized' && previous.key === fingerprint(binding, observed);
        if (previous.outcome === 'pending' && (same || !previous.options.length)) return;
        if (same && (previous.outcome === 'sending' || previous.outcome === 'uncertain')) {
          if (previous.outcome === 'uncertain') return;
          previous.outcome = 'uncertain'; save(dir, state);
          return previous;
        }
        // No observed unblocked state: even an identical menu can be a different request (or the old one).
        retire(state, previous);
        const preview = observed === 'unrecognized' ? { text: previous.text, options: [], selected: -1 } : observed;
        const entry = appendEntry(state, binding, { ...preview, options: [], selected: -1 }, { action: 'main',
          reason: 'The pane stayed blocked; HUD cannot tell whether this is the same prompt or a new one.' });
        save(dir, state);
        return entry;
      }
      retire(state, previous); save(dir, state);
    }
    if (!observed || observed === 'unrecognized') return;
    const proof = proofFor(dir, job, binding, observed);
    const decision: PermissionDecision = observed.manualReason ? { action: 'main', reason: observed.manualReason } : await classifyPermission(home, proof);
    if (signal.aborted) return;
    const entry = appendEntry(state, binding, observed, decision);
    if (decision.action === 'approve') {
      if (!proof || proof.fingerprint !== proofFor(dir, job, binding, observed)?.fingerprint) {
        requireManual(entry, 'Local path evidence changed before answering.');
      } else {
        const result = await sendAnswer(home, dir, job, binding, state, entry, 'approve', observed, signal);
        if (result.code === 'uncertain' || result.code === 'prompt_changed') return entry;
        if (result.written || result.code === 'gone') return;
        requireManual(entry, 'Could not verify the prompt and its one-time approve option before answering.');
      }
    }
    save(dir, state);
    return entry;
  }, { timeoutMs: PERMISSION_LOCK_TIMEOUT_MS, signal });
}

export async function answerWorkerPermission(home: string, dir: string, job: Job, id: string, answer: string) {
  if (answer !== 'approve' && answer !== 'decline') return { ok: false, code: 'invalid_permission_answer' };
  return withAbstractLock('worker-permission', dir, async () => {
    const state = ledger(dir, true);
    const entry = current(state);
    if (!entry || entry.id !== id || entry.action !== 'main') return { ok: false, code: 'permission_not_open' };
    if (entry.outcome === 'pending' && !entry.options.some(option => option.value === answer))
      return { ok: false, code: 'option_unavailable' };
    const binding = getJobIndexCache(home).readSession(job.job);
    if (!binding || !permissionTarget(binding)) return { ok: false, code: 'prompt_unavailable' };
    if (entry.launch !== binding.fields.launchId || entry.pane !== binding.fields.left) {
      if (entry.outcome === 'pending') { retire(state, entry); save(dir, state); }
      return { ok: false, code: 'gone' };
    }
    return sendAnswer(home, dir, job, binding, state, entry, answer, await capture(home, job, binding));
  }, { timeoutMs: PERMISSION_LOCK_TIMEOUT_MS });
}