import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { hasLocalHerdrTarget, request } from '../runtime/herdr-socket.js';
import { withAbstractLock } from '../utils/abstract-lock.js';
import { readJsonBounded, writeJsonPrivate } from '../utils/atomic-fs.js';
import { isProcAlive, readProcEnviron } from '../utils/proc.js';
import { getJobIndexCache, type JobIndexCache } from '../roles/job-index-cache.js';
import type { Job, JobStatus } from './job-contracts.js';
import { jobFiles } from './paths.js';
import { classifyPermission, permissionDirectory, permissionProof, type PermissionDecision } from './permission-policy.js';

const MAX_LOG = 12;
const MAX_LEDGER_BYTES = 65_536;
const FOOTER = /^(?:(?:Enter to (?:select|confirm) · )?(?:(?:Tab\/arrow keys|↑\/↓|↑↓|arrows|arrow keys) to navigate · )?Esc to cancel|Enter to (?:select|confirm) · (?:Esc to cancel|Tab to amend)(?: · Esc to cancel)?|Press enter to confirm or esc to cancel)(?:\s*·\s*(?:Tab to amend|Ctrl\+e to explain))*$/i;
export const PERMISSION_ID = /^perm-[a-f0-9]{16}$/;
type Option = { label: string; value?: 'approve' | 'decline' };
type Prompt = { text: string; command?: string; options: Option[]; selected: number };
export type PermissionEntry = PermissionDecision & {
  id: string; key: string; launch: string; pane: string; at: string; text: string;
  options: Option[];
  outcome: 'pending' | 'gone' | 'sending' | 'answered' | 'uncertain'; answer?: 'approve' | 'decline';
};
type Ledger = { active?: string; entries: PermissionEntry[] };

/** Parse the visible native menu, never a recent/scrollback tail. Unsupported layouts never send keys. */
export function parsePermissionPrompt(screen: string, harness: string): Prompt | null {
  if (screen.length > 32_768 || /[\x00-\x09\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(screen.replaceAll('\r\n', '\n'))) return null;
  const lines = screen.replaceAll('\r\n', '\n').split('\n').map(line => line.trim().replace(/^[│║]\s*|\s*[│║]$/g, ''));
  const title = harness === 'claude' ? /^(?:Bash command|(?:Edit|Write|Create) file(?: .+)?|Do you want to allow this connection\?)$/i
    : /^(?:Permission required|Permission request|Tool approval required|Command approval required|Allow command\?|Would you like to (?:run the following command|make the following edits)\?)$/i;
  let start = lines.length - 1;
  while (start >= 0 && !title.test(lines[start])) start--;
  if (start < 0) return null;
  const body = lines.slice(start).filter(Boolean);
  while (/^[╰╯─━—]+$/.test(body.at(-1) ?? '')) body.pop();
  const text = body.join('\n');
  if (Buffer.byteLength(text) > 3500) return null;
  const question = body.findIndex(line => /^(?:Do you want to (?:proceed|allow this connection|make this edit(?: to .+)?|create .+|overwrite .+)\?|Allow this (?:tool|command|edit)\?)$/i.test(line));
  if (harness === 'claude' && question < 0) return null;
  // A known permission heading and a live footer can still be handed to main when the menu cannot be keyed safely.
  const manual = FOOTER.test(body.at(-1) ?? '') ? { text, options: [], selected: -1 } : null;
  const firstOption = body.findIndex(line => /^(?:[❯›>]\s*)?1[.)]\s+/.test(line));
  if (firstOption < 1 || (harness === 'claude' && question >= firstOption)) return manual;
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
  if (options.length < 2 || options.length > 6) return manual;
  const footer = body.slice(i).join(' ');
  if (!FOOTER.test(footer)) return manual;
  const command = harness === 'claude' && /^Bash command$/i.test(body[0]) && question === 2 && firstOption === 3 ? body[1]
    : harness === 'codex' && /^Would you like to run the following command\?$/i.test(body[0]) && firstOption === 2 && body[1].startsWith('$ ')
      ? body[1].slice(2)
      : harness === 'pi' && /^Command approval required$/i.test(body[0]) && firstOption === 2 && body[1].startsWith('Command: ')
        ? body[1].slice('Command: '.length) : undefined;
  return { text: [...body.slice(0, firstOption), ...options.map((option, i) => `${i + 1}. ${option.label}`), footer].join('\n'), command, options, selected };
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
function save(dir: string, state: Ledger) {
  while (state.entries.length > 1 && Buffer.byteLength(JSON.stringify(state)) >= MAX_LEDGER_BYTES) state.entries.shift();
  writeJsonPrivate(join(dir, jobFiles.permissions), state, { mkdir: false });
}
const current = (state: Ledger) => state.entries.at(-1)?.id === state.active ? state.entries.at(-1) : undefined;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function permissionStatus(dir: string, cache?: JobIndexCache) {
  const read = cache?.readJson<Ledger>(join(dir, jobFiles.permissions));
  const state = read ? (read.status === 'ok' ? read.value : undefined) : ledger(dir);
  return validLedger(state) ? { active: current(state), latest: state.entries.at(-1) } : {};
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

async function capture(home: string, job: Job, binding: Binding, signal?: AbortSignal): Promise<Prompt | null | undefined> {
  const { left, launchId, terminalId, pid, pidStart } = binding.fields;
  const stillBound = () => getJobIndexCache(home).readSession(job.job)?.stamp === binding.stamp;
  if (signal?.aborted) return;
  if (!stillBound()) return null;
  const state = getJobIndexCache(home).readStatus<JobStatus>(job.job);
  if (state.status === 'ok' && ['closed', 'done', 'failed', 'stopped'].includes(state.value.state)) return null;
  const params = { pane_id: left };
  const opts = { signal, timeoutMs: 800 };
  const info = await request('pane.get', params, opts);
  if (info?.error?.code === 'pane_not_found') return null;
  const pane = info?.result?.pane;
  if (!pane || !pane.launch_id || !pane.terminal_id) return;
  if (pane.launch_id !== launchId || pane.terminal_id !== terminalId || pane.pane_id !== left) return null;
  if (!pane.agent_status) return;
  if (pane.agent_status !== 'blocked') return null;
  const harness = job.cli?.agent ?? 'pi';
  if (pane.agent !== harness || !pidStart || !isProcAlive(Number(pid), pidStart)) return;
  const read = await request('pane.read', { ...params, source: 'visible', format: 'text', strip_ansi: true }, opts);
  if (read?.error?.code === 'pane_not_found' || !stillBound()) return null;
  const text = read?.result?.read?.text;
  if (typeof text !== 'string') return;
  const live = await request('pane.get', params, opts);
  if (live?.error?.code === 'pane_not_found' || !stillBound()) return null;
  const after = live?.result?.pane;
  if (!after?.launch_id || !after.terminal_id || !after.agent_status) return;
  if (after.launch_id !== launchId || after.terminal_id !== terminalId || after.agent_status !== 'blocked') return null;
  // A clipped or changed layout is not proof that the native prompt went away.
  return parsePermissionPrompt(text, harness) ?? undefined;
}

function proofFor(dir: string, job: Job, status: Partial<JobStatus> | null, binding: Binding, prompt: Prompt) {
  const { pid, pidStart } = binding.fields;
  if (!pidStart || !isProcAlive(Number(pid), pidStart)) return;
  const env = readProcEnviron(Number(pid));
  if (!env || env.HUD_JOB_DIR !== dir || env.BASH_ENV || env.ENV || env['BASH_FUNC_rm%%']) return;
  const target = permissionDirectory(prompt.command, env.S);
  if (!target) return;
  const sess = status?.agent_session_id;
  const uid = process.getuid?.();
  const nativeScratch = job.cli?.agent === 'claude' && uid !== undefined && sess && /^[\w-]{8,100}$/.test(sess) &&
    target.startsWith(`/tmp/claude-${uid}/`) && target.endsWith(`/${sess}/scratchpad`) && target.split('/').length === 6 ? target : undefined;
  const ownScratch = job.worktree?.root && (!job.worktree.owner || job.worktree.owner === job.job)
    ? join(job.worktree.root, 'scratchpad') : undefined;
  const temp = env.TMPDIR && isAbsolute(env.TMPDIR) && /^(?:\/tmp|\/dev\/shm)\//.test(env.TMPDIR) &&
    basename(env.TMPDIR).includes(job.job) ? env.TMPDIR : undefined;
  // Relative command paths are accepted only with explicit shell cwd evidence; job.cwd is not that evidence.
  return permissionProof(prompt.command, { task: dir, scratch: nativeScratch ?? ownScratch, temp, variable: env.S });
}

const fingerprint = (binding: Binding, prompt: Prompt) => hash(JSON.stringify([
  binding.fields.launchId, binding.fields.terminalId, prompt.command ?? prompt.text, prompt.options.map(option => option.label),
]));

async function sendAnswer(home: string, dir: string, job: Job, binding: Binding, state: Ledger, entry: PermissionEntry,
  answer: 'approve' | 'decline', fresh: Prompt | null | undefined, signal?: AbortSignal) {
  if (entry.outcome !== 'pending') return { ok: entry.outcome === 'answered', written: false, code: entry.outcome };
  if (fresh === null || (fresh && fingerprint(binding, fresh) !== entry.key)) {
    entry.outcome = 'gone'; delete state.active; save(dir, state);
    return { ok: false, written: false, code: 'gone' };
  }
  if (!fresh || signal?.aborted || existsSync(join(dir, jobFiles.stopRequested))) return { ok: false, written: false, code: 'prompt_unavailable' };
  const matches = fresh.options.flatMap((option, i) => option.value === answer ? [i] : []);
  if (fresh.selected < 0 || matches.length !== 1) return { ok: false, written: false, code: 'option_unavailable' };
  const delta = matches[0] - fresh.selected;
  const keys = [...Array<string>(Math.abs(delta)).fill(delta < 0 ? 'Up' : 'Down'), 'Enter'];
  if (getJobIndexCache(home).readSession(job.job)?.stamp !== binding.stamp) return { ok: false, written: false, code: 'prompt_unavailable' };
  // Spend the answer before sending. A lost reply or a crash after the write is not permission to retry.
  entry.outcome = 'sending'; entry.answer = answer; save(dir, state);
  const reply = await request('pane.send_keys', { pane_id: entry.pane, keys }, { signal, timeoutMs: 800 });
  entry.outcome = reply?.result?.type === 'ok' && !reply.error ? 'answered' : reply?.error?.code === 'pane_not_found' ? 'gone' : 'uncertain';
  save(dir, state);
  return { ok: entry.outcome === 'answered', written: entry.outcome === 'answered', code: entry.outcome };
}

export async function observeWorkerPermission(home: string, dir: string, job: Job, status: Partial<JobStatus> | null,
  binding: Binding, signal: AbortSignal) {
  const observed = await capture(home, job, binding, signal);
  if (observed === undefined || signal.aborted) return;
  return withAbstractLock('worker-permission', dir, async () => {
    const state = ledger(dir, true);
    const previous = current(state);
    const key = observed ? fingerprint(binding, observed) : null;
    if (previous && previous.key === key) {
      if (previous.outcome === 'sending') {
        previous.outcome = 'uncertain'; save(dir, state);
        return previous;
      }
      return;
    }
    if (previous) {
      if (previous.outcome === 'pending') previous.outcome = 'gone';
      if (previous.outcome === 'sending') previous.outcome = 'uncertain';
      delete state.active; save(dir, state);
    }
    if (!observed || !key) return;
    const proof = proofFor(dir, job, status, binding, observed);
    const decision = await classifyPermission(home, proof);
    if (signal.aborted) return;
    const entry: PermissionEntry = { ...decision, id: `perm-${hash(`${key}\0${Date.now()}\0${state.entries.at(-1)?.id ?? ''}`).slice(0, 16)}`,
      key, launch: binding.fields.launchId!, pane: binding.fields.left!, at: new Date().toISOString(), text: observed.text,
      options: observed.selected < 0 ? [] : observed.options, outcome: 'pending' };
    state.entries = [...state.entries, entry].slice(-MAX_LOG);
    state.active = entry.id;
    const fresh = await capture(home, job, binding, signal);
    if (fresh === null || (fresh && fingerprint(binding, fresh) !== key)) {
      entry.outcome = 'gone'; delete state.active; save(dir, state);
      return;
    }
    if (decision.action === 'approve') {
      if (fresh && fingerprint(binding, fresh) === key && !proofFor(dir, job, status, binding, fresh)) {
        entry.action = 'main'; entry.reason = 'Local path evidence changed before answering.';
      } else {
        const result = await sendAnswer(home, dir, job, binding, state, entry, 'approve', fresh, signal);
        if (result.code === 'uncertain') return entry;
        if (result.written || result.code === 'gone') return;
        entry.action = 'main'; entry.reason = 'Could not verify the prompt and its one-time approve option before answering.';
      }
    }
    save(dir, state);
    return entry.action === 'main' && entry.outcome === 'pending' ? entry : undefined;
  }, { signal });
}

export async function answerWorkerPermission(home: string, dir: string, job: Job, id: string, answer: string) {
  if (answer !== 'approve' && answer !== 'decline') return { ok: false, code: 'invalid_permission_answer' };
  return withAbstractLock('worker-permission', dir, async () => {
    const state = ledger(dir, true);
    const entry = current(state);
    if (!entry || entry.id !== id || entry.action !== 'main') return { ok: false, code: 'permission_not_open' };
    const binding = getJobIndexCache(home).readSession(job.job);
    if (!binding || !permissionTarget(binding) || entry.launch !== binding.fields.launchId) {
      if (entry.outcome === 'pending') { entry.outcome = 'gone'; delete state.active; save(dir, state); }
      return { ok: false, code: 'gone' };
    }
    return sendAnswer(home, dir, job, binding, state, entry, answer, await capture(home, job, binding));
  });
}