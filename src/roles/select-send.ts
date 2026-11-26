/**
 * Send a pane selection with its source to the responsible main session.
 *
 * Worker pane -> job's dispatcher (caller_pane / ORCH / dispatcher session).
 * Other pane  -> project's main session.
 * Delivery uses HUD's normal path: active pane watcher via panel-actions.jsonl,
 * otherwise notify() (Antigravity mailbox, Codex queue, or herdr guarded prompt).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendPanelAction } from '../collectors/panel-actions.js';
import type { Job } from '../mcp/job-contracts.js';
import { herdrEndpoint, request as herdrRequest, watchHerdrPane, type HerdrReply } from '../runtime/herdr-socket.js';
import { readJsonFile, writePrivateFile } from '../utils/atomic-fs.js';
import { herdrId, herdrResult, isRecord, runCommand, runHerdr } from './herdr-run.js';
import { getJobIndexCache } from './job-index-cache.js';
import { jobCallerPane } from './job-pane.js';
import {
  ensureQueueWatcher,
  notify,
  PROMPT_QUIET_MS,
  PROMPT_RETRY_TTL_MS,
  recordPromptExpiry,
  watching,
  type NotifyResult,
} from './notify.js';
import { sharedRoot } from './projects.js';

export const SELECT_SEND_PLUGIN_ID = 'hud.select-send';
export const SELECT_SEND_ACTION_ID = 'send';
export const SELECT_SEND_COMPOSER_ENTRYPOINT = 'composer';
export const MAX_EXCERPT_CHARS = 8000;
export const MAX_QUESTION_CHARS = 1000;
const HANDOFF_DIR = 'select-send';
const HANDOFF_MAX_AGE_MS = 60 * 60_000;
const HANDOFF_MAX_FILES = 16;
const MAX_JOBS_SCAN = 200;
const MAIN_AGENTS = new Set(['claude', 'codex', 'pi', 'agy']);

export interface SelectionPoint {
  row: number;
  col: number;
}

export interface SelectionCoords {
  pane_id?: string;
  anchor: SelectionPoint;
  cursor: SelectionPoint;
  content_revision?: number;
}

export interface PluginSelectionContext {
  workspace_id?: string;
  workspace_label?: string;
  workspace_cwd?: string;
  worktree?: { checkout_path?: string; branch?: string } | null;
  tab_id?: string;
  tab_label?: string;
  focused_pane_id?: string;
  focused_pane_cwd?: string;
  focused_pane_agent?: string;
  focused_pane_status?: string;
  selected_text?: string;
  stale_content?: boolean;
  selection?: SelectionCoords;
  invocation_source?: string;
  correlation_id?: string;
}

export interface LivePane {
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
  launch_id?: string;
  terminal_id?: string;
  label?: string;
  cwd?: string;
  foreground_cwd?: string;
  agent?: string;
  agent_status?: string;
  agent_session?: { kind?: string; value?: string };
}

export interface SelectionSource {
  project: string | null;
  projectRoot: string | null;
  pane: string | null;
  job: string | null;
  role: string | null;
  time: string;
}

export interface ResolvedSelectionTarget {
  source: SelectionSource;
  targetPane: string | null;
  targetAgent: string | null;
  reason?: string;
}

export interface NormalizedExcerpt {
  text: string;
  truncated: boolean;
  empty: boolean;
}

export interface SelectionBaseline {
  screenText: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

export interface RefreshResult {
  stale: boolean;
  changed: boolean;
  excerpt: NormalizedExcerpt;
  baseline?: SelectionBaseline | null;
}

export interface DeliverSelectionResult {
  ok: boolean;
  delivered?: 'watcher' | 'direct' | 'pending';
  detail?: string;
  error?: string;
}

export interface SelectionHandoff {
  version: 1;
  created_at: string;
  context: PluginSelectionContext;
}

export interface PendingRetryPayload {
  version: 1;
  created_at: string;
  pane: string;
  message: string;
  hud_home: string;
}

const stripUnsafeControl = (s: string, keepNewlines: boolean): string =>
  s.replace(
    keepNewlines
      ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g
      : /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    keepNewlines ? '' : ' '
  );

/** Normalize selected text identically for composer display and final delivery. */
export function normalizeSelectionExcerpt(raw: string | null | undefined, maxChars = MAX_EXCERPT_CHARS): NormalizedExcerpt {
  const normalized = stripUnsafeControl(String(raw ?? '').replace(/\r\n?/g, '\n'), true);
  if (!normalized.trim()) return { text: '', truncated: false, empty: true };
  if (normalized.length <= maxChars) return { text: normalized, truncated: false, empty: false };
  const suffix = '\n… (truncated)';
  const kept = normalized.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd();
  return { text: `${kept}${suffix}`, truncated: true, empty: false };
}

export function normalizeQuestion(raw: string | null | undefined): string {
  return stripUnsafeControl(String(raw ?? ''), false)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUESTION_CHARS);
}

function chooseFence(text: string): string {
  let maxRun = 2;
  for (const match of text.matchAll(/`+/g)) {
    if (match[0].length > maxRun) maxRun = match[0].length;
  }
  return '`'.repeat(maxRun + 1);
}

export function formatSelectionMessage(input: {
  excerpt: string;
  source: SelectionSource;
  question?: string;
}): string {
  const meta: string[] = [];
  if (input.source.project) meta.push(`project=${stripUnsafeControl(input.source.project, false)}`);
  if (input.source.pane) meta.push(`pane=${stripUnsafeControl(input.source.pane, false)}`);
  if (input.source.job) {
    const role = input.source.role ? ` (${stripUnsafeControl(input.source.role, false)})` : '';
    meta.push(`job=${stripUnsafeControl(input.source.job, false)}${role}`);
  }
  meta.push(`time=${stripUnsafeControl(input.source.time, false)}`);
  const fence = chooseFence(input.excerpt);
  const question = normalizeQuestion(input.question);
  const lines = [
    '[HUD selection]',
    `Source: ${meta.join(' | ')}`,
    fence,
    input.excerpt,
    fence,
    ...(question ? [`Question: ${question}`] : []),
  ];
  return lines.join('\n');
}

function parsePoint(value: unknown): SelectionPoint | null {
  if (!isRecord(value)) return null;
  const { row, col } = value;
  if (typeof row !== 'number' || typeof col !== 'number' || !Number.isInteger(row) || !Number.isInteger(col)) {
    return null;
  }
  return { row, col };
}

function parseSelectionCoords(value: unknown): SelectionCoords | undefined {
  if (!isRecord(value)) return undefined;
  const anchor = parsePoint(value.anchor);
  const cursor = parsePoint(value.cursor);
  if (!anchor || !cursor) return undefined;
  const pane_id = herdrId(value.pane_id) ? value.pane_id : undefined;
  const content_revision =
    typeof value.content_revision === 'number' && Number.isSafeInteger(value.content_revision)
      ? value.content_revision
      : undefined;
  return { ...(pane_id ? { pane_id } : {}), anchor, cursor, ...(content_revision !== undefined ? { content_revision } : {}) };
}

/** Parse HERDR_PLUGIN_CONTEXT_JSON with fallback to herdr pane/tab/workspace env vars. */
export function parsePluginContext(env: NodeJS.ProcessEnv = process.env): PluginSelectionContext {
  let raw: Record<string, unknown> = {};
  if (typeof env.HERDR_PLUGIN_CONTEXT_JSON === 'string' && env.HERDR_PLUGIN_CONTEXT_JSON.trim()) {
    try {
      const parsed = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON) as unknown;
      if (isRecord(parsed)) raw = parsed;
    } catch {
      /* Ignore malformed context JSON; fall back to individual env vars. */
    }
  }
  const str = (key: string): string | undefined => (typeof raw[key] === 'string' && raw[key] ? raw[key] : undefined);
  const worktree = isRecord(raw.worktree)
    ? {
        ...(typeof raw.worktree.checkout_path === 'string' ? { checkout_path: raw.worktree.checkout_path } : {}),
        ...(typeof raw.worktree.branch === 'string' ? { branch: raw.worktree.branch } : {}),
      }
    : undefined;
  const selection = parseSelectionCoords(raw.selection);
  return {
    workspace_id: str('workspace_id') ?? (herdrId(env.HERDR_WORKSPACE_ID) ? env.HERDR_WORKSPACE_ID : undefined),
    workspace_label: str('workspace_label'),
    workspace_cwd: str('workspace_cwd'),
    ...(worktree ? { worktree } : {}),
    tab_id: str('tab_id') ?? (herdrId(env.HERDR_TAB_ID) ? env.HERDR_TAB_ID : undefined),
    tab_label: str('tab_label'),
    focused_pane_id: str('focused_pane_id') ?? (herdrId(env.HERDR_PANE_ID) ? env.HERDR_PANE_ID : undefined),
    focused_pane_cwd: str('focused_pane_cwd'),
    focused_pane_agent: str('focused_pane_agent'),
    focused_pane_status: str('focused_pane_status'),
    selected_text: typeof raw.selected_text === 'string' ? raw.selected_text : undefined,
    stale_content: raw.stale_content === true,
    ...(selection ? { selection } : {}),
    invocation_source: str('invocation_source'),
    correlation_id: str('correlation_id'),
  };
}

function asLivePanes(raw: unknown): LivePane[] | null {
  if (!Array.isArray(raw)) return null;
  const panes: LivePane[] = [];
  for (const row of raw) {
    if (!isRecord(row) || !herdrId(row.pane_id)) continue;
    panes.push({
      pane_id: row.pane_id,
      tab_id: herdrId(row.tab_id) ? row.tab_id : undefined,
      workspace_id: herdrId(row.workspace_id) ? row.workspace_id : undefined,
      launch_id: herdrId(row.launch_id) ? row.launch_id : undefined,
      terminal_id: herdrId(row.terminal_id) ? row.terminal_id : undefined,
      label: typeof row.label === 'string' ? row.label : undefined,
      cwd: typeof row.cwd === 'string' && row.cwd ? row.cwd : undefined,
      foreground_cwd: typeof row.foreground_cwd === 'string' && row.foreground_cwd ? row.foreground_cwd : undefined,
      agent: typeof row.agent === 'string' && row.agent ? row.agent : undefined,
      agent_status: typeof row.agent_status === 'string' ? row.agent_status : undefined,
      agent_session: isRecord(row.agent_session)
        ? {
            kind: typeof row.agent_session.kind === 'string' ? row.agent_session.kind : undefined,
            value: typeof row.agent_session.value === 'string' ? row.agent_session.value : undefined,
          }
        : undefined,
    });
  }
  return panes;
}

export async function listLivePanes(env: NodeJS.ProcessEnv = process.env): Promise<LivePane[] | null> {
  if (herdrEndpoint(env)) {
    const reply = await herdrRequest('pane.list', {}, { env, timeoutMs: 1500 }).catch(() => null);
    const panes = asLivePanes(reply?.result?.panes);
    if (panes) return panes;
  }
  const cli = await runHerdr(['pane', 'list'], env, { budgetMs: 2000 }).catch(() => null);
  if (!cli?.ok) return null;
  const result = herdrResult(cli.stdout);
  return asLivePanes(result?.panes);
}

function jobProjectRoot(job: Partial<Job>): string | null {
  if (typeof job.project_root === 'string' && job.project_root) return job.project_root;
  if (typeof job.worktree?.main_root === 'string' && job.worktree.main_root) return job.worktree.main_root;
  if (typeof job.cwd === 'string' && job.cwd) return sharedRoot(job.cwd);
  return null;
}

function projectNameFromRoot(root: string | null, fallback?: string): string | null {
  if (root) return basename(root) || root;
  return fallback?.trim() || null;
}

function paneMatchesSession(
  paneId: string,
  livePane: LivePane | undefined,
  fields: { left?: string; right?: string; herdrSocket?: string; launchId?: string; terminalId?: string },
  currentSocket: string | undefined,
  reaped: boolean
): boolean {
  if (fields.left !== paneId && fields.right !== paneId) return false;
  if (fields.herdrSocket && currentSocket && fields.herdrSocket !== currentSocket) return false;
  if (fields.launchId && livePane?.launch_id && fields.launchId !== livePane.launch_id) return false;
  if (fields.left === paneId && fields.terminalId && livePane?.terminal_id && fields.terminalId !== livePane.terminal_id) {
    return false;
  }
  if (reaped) {
    const strongIdentity =
      (fields.launchId && livePane?.launch_id && fields.launchId === livePane.launch_id) ||
      (fields.left === paneId && fields.terminalId && livePane?.terminal_id && fields.terminalId === livePane.terminal_id);
    if (!strongIdentity) return false;
  }
  return true;
}

/**
 * Resolve source metadata and responsible main session:
 * - Worker pane -> the job's dispatcher (caller_pane / ORCH / dispatcher session)
 * - Other pane  -> the project's main session
 */
export async function resolveSelectionTarget(
  ctx: PluginSelectionContext,
  hudHome: string,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date()
): Promise<ResolvedSelectionTarget> {
  const sourcePane = ctx.selection?.pane_id ?? ctx.focused_pane_id ?? null;
  const panes = await listLivePanes(env);
  const paneById = new Map((panes ?? []).map((p) => [p.pane_id, p]));
  const sourcePaneInfo = sourcePane ? paneById.get(sourcePane) : undefined;
  const sourceWorkspace = ctx.workspace_id ?? sourcePaneInfo?.workspace_id ?? null;
  const currentSocket = herdrEndpoint(env);

  const cache = getJobIndexCache(hudHome);
  const { dirs } = cache.listJobDirsByMtime();
  const workerPanes = new Set<string>();
  const recentProjectCaller = new Map<string, string>();
  let matchedJob: { job: Job; caller: string | null; root: string | null } | null = null;

  for (const { id } of dirs.slice(0, MAX_JOBS_SCAN)) {
    const receipt = cache.readJob<Job>(id);
    if (receipt.status !== 'ok' || receipt.value.job !== id) continue;
    const job = receipt.value;
    const sess = cache.readSession(id);
    const fields = sess?.fields;
    const reaped = Boolean(job.reaped_at);
    const root = jobProjectRoot(job);
    const caller = jobCallerPane(job) || (herdrId(fields?.orch) ? fields.orch : '');

    if (root && caller && (!panes || paneById.has(caller)) && !recentProjectCaller.has(root)) {
      recentProjectCaller.set(root, caller);
    }

    if (fields) {
      for (const wp of [fields.left, fields.right]) {
        if (wp && herdrId(wp) && paneMatchesSession(wp, paneById.get(wp), fields, currentSocket, reaped)) {
          workerPanes.add(wp);
        }
      }
      if (!matchedJob && sourcePane && paneMatchesSession(sourcePane, sourcePaneInfo, fields, currentSocket, reaped)) {
        matchedJob = { job, caller: herdrId(caller) ? caller : null, root };
      }
    }
  }

  const pickProjectMain = (projectRoot: string | null): LivePane | null => {
    if (!panes) {
      if (projectRoot) {
        const caller = recentProjectCaller.get(projectRoot);
        if (caller) return { pane_id: caller };
      }
      return null;
    }
    const candidates = panes.filter(
      (p) => p.agent && MAIN_AGENTS.has(p.agent) && !workerPanes.has(p.pane_id) && p.label !== 'hud panel'
    );
    const rootCache = new Map<string, string>();
    const rootOf = (cwd?: string): string | null => {
      if (!cwd) return null;
      if (!rootCache.has(cwd)) rootCache.set(cwd, sharedRoot(cwd));
      return rootCache.get(cwd)!;
    };

    const score = (p: LivePane): number => {
      let s = 0;
      if (watching(p.pane_id, hudHome)) s += 8;
      if (projectRoot && recentProjectCaller.get(projectRoot) === p.pane_id) s += 4;
      if (sourceWorkspace && p.workspace_id === sourceWorkspace) s += 2;
      if (sourcePane && p.pane_id !== sourcePane) s += 1;
      return s;
    };

    const pickBest = (pool: LivePane[]): LivePane | null => {
      if (!pool.length) return null;
      return [...pool].sort((a, b) => score(b) - score(a) || a.pane_id.localeCompare(b.pane_id))[0] ?? null;
    };

    if (projectRoot) {
      const sameProject = candidates.filter((p) => rootOf(p.foreground_cwd ?? p.cwd) === projectRoot);
      const best = pickBest(sameProject);
      if (best) return best;
      const caller = recentProjectCaller.get(projectRoot);
      if (caller && paneById.has(caller) && !workerPanes.has(caller)) {
        return paneById.get(caller)!;
      }
    }

    if (sourceWorkspace) {
      const sameWorkspace = candidates.filter((p) => {
        if (p.workspace_id !== sourceWorkspace) return false;
        const pRoot = rootOf(p.foreground_cwd ?? p.cwd);
        return !projectRoot || !pRoot || pRoot === projectRoot;
      });
      const best = pickBest(sameWorkspace);
      if (best) return best;
    }

    return null;
  };

  const time = now.toISOString();

  if (matchedJob) {
    const { job, caller, root } = matchedJob;
    const source: SelectionSource = {
      project: projectNameFromRoot(root, ctx.workspace_label),
      projectRoot: root,
      pane: sourcePane,
      job: job.job,
      role: typeof job.role === 'string' ? job.role : null,
      time,
    };
    // Prefer the job's recorded dispatcher pane when live.
    if (caller && (!panes || paneById.has(caller))) {
      const live = paneById.get(caller);
      return { source, targetPane: caller, targetAgent: live?.agent ?? null };
    }
    // Fall back to matching the recorded dispatcher session identity across live panes.
    if (panes && job.dispatcher?.harness && job.dispatcher?.id) {
      const bySession = panes.find(
        (p) =>
          !workerPanes.has(p.pane_id) &&
          p.agent === job.dispatcher!.harness &&
          p.agent_session?.value === job.dispatcher!.id
      );
      if (bySession) {
        return { source, targetPane: bySession.pane_id, targetAgent: bySession.agent ?? null };
      }
    }
    const projectMain = pickProjectMain(root);
    if (projectMain) {
      return { source, targetPane: projectMain.pane_id, targetAgent: projectMain.agent ?? null };
    }
    return { source, targetPane: null, targetAgent: null, reason: 'No live main session found for this job' };
  }

  const rawCwd =
    ctx.worktree?.checkout_path ??
    ctx.focused_pane_cwd ??
    sourcePaneInfo?.foreground_cwd ??
    sourcePaneInfo?.cwd ??
    ctx.workspace_cwd ??
    null;
  const projectRoot = rawCwd ? sharedRoot(rawCwd) : null;
  const source: SelectionSource = {
    project: projectNameFromRoot(projectRoot, ctx.workspace_label),
    projectRoot,
    pane: sourcePane,
    job: null,
    role: null,
    time,
  };
  const projectMain = pickProjectMain(projectRoot);
  if (projectMain) {
    return { source, targetPane: projectMain.pane_id, targetAgent: projectMain.agent ?? null };
  }
  return { source, targetPane: null, targetAgent: null, reason: 'No main session found for this project' };
}

async function paneReadText(paneId: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!herdrEndpoint(env)) return null;
  for (const source of ['screen', 'recent'] as const) {
    const reply = await herdrRequest('pane.read', { pane_id: paneId, source }, { env, timeoutMs: 800 }).catch(() => null);
    const text = reply?.result?.read?.text ?? reply?.result?.text;
    if (!reply?.error && typeof text === 'string') return text.replace(/\r\n?/g, '\n');
  }
  return null;
}

function locateExcerptSpan(screenText: string, excerptText: string): { startLine: number; endLine: number } | null {
  const screenLines = screenText.split('\n');
  const excerptLines = excerptText.split('\n');
  if (!excerptLines.length) return null;
  for (let i = 0; i <= screenLines.length - excerptLines.length; i++) {
    let ok = true;
    for (let j = 0; j < excerptLines.length; j++) {
      if (!screenLines[i + j]!.includes(excerptLines[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) return { startLine: i, endLine: i + excerptLines.length };
  }
  return null;
}

function extractUpdatedFromScreen(screenText: string, lineCount: number, baseline?: SelectionBaseline | null): string {
  const lines = screenText.split('\n');
  if (baseline && baseline.startLine < lines.length) {
    const slice = lines.slice(baseline.startLine, Math.min(lines.length, baseline.endLine)).join('\n');
    if (slice.trim()) return slice;
  }
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (!nonEmpty.length) return '';
  return nonEmpty.slice(-Math.max(1, lineCount)).join('\n');
}

export async function captureSelectionBaseline(
  ctx: PluginSelectionContext,
  excerpt: NormalizedExcerpt,
  env: NodeJS.ProcessEnv = process.env
): Promise<SelectionBaseline | null> {
  const paneId = ctx.selection?.pane_id ?? ctx.focused_pane_id;
  if (!paneId || excerpt.empty) return null;
  const screenText = await paneReadText(paneId, env);
  if (screenText === null) return null;
  const lineCount = excerpt.text.split('\n').length;
  const span = locateExcerptSpan(screenText, excerpt.text);
  return {
    screenText,
    startLine: span?.startLine ?? Math.max(0, screenText.split('\n').length - lineCount),
    endLine: span?.endLine ?? screenText.split('\n').length,
    lineCount,
  };
}

/**
 * Refresh the excerpt when selection coordinates report `stale_content`, when context
 * arrived with `stale_content: true`, or when the source pane's screen text changed.
 */
export async function refreshSelectionExcerpt(
  ctx: PluginSelectionContext,
  current: NormalizedExcerpt,
  baseline: SelectionBaseline | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<RefreshResult> {
  const paneId = ctx.selection?.pane_id ?? ctx.focused_pane_id;
  if (!paneId) return { stale: Boolean(ctx.stale_content), changed: false, excerpt: current, baseline };

  if (ctx.selection) {
    const { anchor, cursor, content_revision } = ctx.selection;
    if (!ctx.stale_content && content_revision !== undefined) {
      const checked: HerdrReply | null = await herdrRequest(
        'pane.selection.read',
        { pane_id: paneId, anchor, cursor, content_revision },
        { env, timeoutMs: 1500 }
      ).catch(() => null);
      if (checked?.error?.code === 'stale_content') {
        const latest = await herdrRequest('pane.selection.read', { pane_id: paneId, anchor, cursor }, { env, timeoutMs: 1500 }).catch(
          () => null
        );
        const rawText = typeof latest?.result?.text === 'string' ? latest.result.text : '';
        const next = normalizeSelectionExcerpt(rawText);
        return { stale: true, changed: next.text !== current.text || next.empty !== current.empty, excerpt: next, baseline };
      }
      if (!checked?.error && typeof checked?.result?.text === 'string') {
        const next = normalizeSelectionExcerpt(checked.result.text);
        const changed = next.text !== current.text;
        return { stale: changed, changed, excerpt: next, baseline };
      }
      return { stale: false, changed: false, excerpt: current, baseline };
    }

    const latest = await herdrRequest('pane.selection.read', { pane_id: paneId, anchor, cursor }, { env, timeoutMs: 1500 }).catch(
      () => null
    );
    if (!latest?.error && typeof latest?.result?.text === 'string') {
      const next = normalizeSelectionExcerpt(latest.result.text);
      const changed = next.text !== current.text || next.empty !== current.empty;
      return { stale: Boolean(ctx.stale_content || changed), changed, excerpt: next, baseline };
    }
    return { stale: Boolean(ctx.stale_content), changed: false, excerpt: current, baseline };
  }

  const screenText = await paneReadText(paneId, env);
  if (screenText === null) return { stale: Boolean(ctx.stale_content), changed: false, excerpt: current, baseline };

  const lineCount = Math.max(1, baseline?.lineCount ?? current.text.split('\n').length);
  if (ctx.stale_content) {
    const updated = extractUpdatedFromScreen(screenText, lineCount, baseline);
    const next = normalizeSelectionExcerpt(updated);
    const nextBaseline: SelectionBaseline = {
      screenText,
      startLine: locateExcerptSpan(screenText, next.text)?.startLine ?? 0,
      endLine: locateExcerptSpan(screenText, next.text)?.endLine ?? lineCount,
      lineCount: Math.max(1, next.text.split('\n').length),
    };
    return {
      stale: true,
      changed: next.text !== current.text || next.empty !== current.empty,
      excerpt: next.empty ? current : next,
      baseline: nextBaseline,
    };
  }

  if (baseline && screenText !== baseline.screenText && !current.empty && !screenText.includes(current.text)) {
    const updated = extractUpdatedFromScreen(screenText, lineCount, baseline);
    const next = normalizeSelectionExcerpt(updated);
    const nextBaseline: SelectionBaseline = {
      screenText,
      startLine: locateExcerptSpan(screenText, next.text)?.startLine ?? baseline.startLine,
      endLine: locateExcerptSpan(screenText, next.text)?.endLine ?? baseline.endLine,
      lineCount: Math.max(1, next.text.split('\n').length),
    };
    return {
      stale: true,
      changed: next.text !== current.text || next.empty !== current.empty,
      excerpt: next,
      baseline: nextBaseline,
    };
  }

  return { stale: false, changed: false, excerpt: current, baseline };
}

function handoffDir(hudHome: string): string {
  return join(hudHome, HANDOFF_DIR);
}

function pruneHandoffDir(dir: string, nowMs = Date.now()): void {
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        try {
          const full = join(dir, name);
          const st = fs.lstatSync(full);
          return st.isFile() ? [{ full, mtimeMs: st.mtimeMs }] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const [i, item] of entries.entries()) {
      if (i >= HANDOFF_MAX_FILES || nowMs - item.mtimeMs > HANDOFF_MAX_AGE_MS) {
        try {
          fs.unlinkSync(item.full);
        } catch {
          /* Already removed. */
        }
      }
    }
  } catch {
    /* Directory may not exist yet. */
  }
}

export function writeSelectionHandoff(hudHome: string, context: PluginSelectionContext): string {
  const dir = handoffDir(hudHome);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneHandoffDir(dir);
  const file = join(dir, `${randomUUID()}.json`);
  const payload: SelectionHandoff = { version: 1, created_at: new Date().toISOString(), context };
  writePrivateFile(file, JSON.stringify(payload) + '\n', { mkdir: false });
  return file;
}

export function readAndRemoveSelectionHandoff(file: string): PluginSelectionContext | null {
  try {
    const payload = readJsonFile(file) as Partial<SelectionHandoff>;
    try {
      fs.unlinkSync(file);
    } catch {
      /* Already removed. */
    }
    return payload?.version === 1 && isRecord(payload.context) ? (payload.context as PluginSelectionContext) : null;
  } catch {
    return null;
  }
}

function writePendingRetryFile(hudHome: string, pane: string, message: string): string {
  const dir = handoffDir(hudHome);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneHandoffDir(dir);
  const file = join(dir, `retry-${randomUUID()}.json`);
  const payload: PendingRetryPayload = { version: 1, created_at: new Date().toISOString(), pane, message, hud_home: hudHome };
  writePrivateFile(file, JSON.stringify(payload) + '\n', { mkdir: false });
  return file;
}

export async function waitAndRetryGuardedPrompt(
  pane: string,
  message: string,
  hudHome: string,
  initialRetry: NonNullable<NotifyResult['retryPrompt']>,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal
): Promise<DeliverSelectionResult> {
  const until = performance.now() + PROMPT_RETRY_TTL_MS;
  let retry = initialRetry;
  return new Promise<DeliverSelectionResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let sending = false;
    const finish = (result: DeliverSelectionResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stopWatch();
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, error: 'aborted' });
    const schedule = (ms: number) => {
      if (settled || sending) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(attempt, Math.min(ms, Math.max(0, until - performance.now())));
    };
    const attempt = async () => {
      if (settled || sending) return;
      if (performance.now() >= until) {
        recordPromptExpiry(hudHome);
        finish({ ok: false, error: 'pending typed selection expired' });
        return;
      }
      sending = true;
      const result = await retry(message, signal).catch(() => null);
      sending = false;
      if (settled) return;
      if (result && !result.retryPrompt) {
        finish(result.status === 0 || result.uncertain ? { ok: true, delivered: 'direct' } : { ok: false, error: result.error?.message ?? 'delivery failed' });
        return;
      }
      if (result?.retryPrompt) retry = result.retryPrompt;
      schedule(PROMPT_QUIET_MS);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const stopWatch = watchHerdrPane(pane, env, () => schedule(50), () => finish({ ok: false, error: 'pane closed' }));
    schedule(PROMPT_QUIET_MS);
  });
}

function spawnDetachedRetry(retryFile: string, env: NodeJS.ProcessEnv): void {
  const hud = fileURLToPath(new URL('../../bin/hud', import.meta.url));
  const child = spawn(process.execPath, [hud, 'select-send', '--retry', retryFile], {
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * Deliver the formatted selection message ONCE via HUD's normal delivery path:
 * - Active pane watcher (claude-mod, pi, hud watch --queue) -> panel-actions.jsonl
 * - Otherwise -> notify() (Antigravity mailbox, Codex queue, or herdr guarded prompt)
 */
export async function deliverSelection(
  targetPane: string,
  message: string,
  hudHome: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { retry?: 'detach' | 'inline' | 'none'; signal?: AbortSignal } = {}
): Promise<DeliverSelectionResult> {
  if (!herdrId(targetPane)) return { ok: false, error: 'invalid target pane' };
  if (!message.trim()) return { ok: false, error: 'empty selection message' };

  if (watching(targetPane, hudHome)) {
    appendPanelAction(hudHome, { type: 'select-send', pane: targetPane, text: message });
    return { ok: true, delivered: 'watcher', detail: 'queued for active session watcher' };
  }

  const sent = await notify(targetPane, message, hudHome, { env, signal: options.signal });
  if (sent.retryPrompt) {
    const mode = options.retry ?? 'detach';
    if (mode === 'inline') {
      return waitAndRetryGuardedPrompt(targetPane, message, hudHome, sent.retryPrompt, env, options.signal);
    }
    if (mode === 'detach') {
      const retryFile = writePendingRetryFile(hudHome, targetPane, message);
      spawnDetachedRetry(retryFile, env);
    }
    return { ok: true, delivered: 'pending', detail: 'waiting for idle empty prompt' };
  }
  if (sent.status === 0 || sent.uncertain) {
    // For Antigravity pending mailbox writes without a watcher, wake the queue watcher when available.
    if (sent.detail?.includes('pending for Antigravity')) {
      void ensureQueueWatcher(targetPane, hudHome);
    }
    return { ok: true, delivered: 'direct', detail: sent.detail };
  }
  return {
    ok: false,
    error: sent.error?.message || sent.stderr?.trim() || sent.detail || `delivery failed (exit ${sent.status})`,
  };
}

export async function runDetachedRetryFile(file: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<number> {
  let payload: PendingRetryPayload;
  try {
    const parsed = readJsonFile(file) as Partial<PendingRetryPayload>;
    try {
      fs.unlinkSync(file);
    } catch {
      /* Already removed. */
    }
    if (parsed?.version !== 1 || !herdrId(parsed.pane) || typeof parsed.message !== 'string' || typeof parsed.hud_home !== 'string') {
      return 1;
    }
    payload = parsed as PendingRetryPayload;
  } catch {
    return 1;
  }
  const result = await deliverSelection(payload.pane, payload.message, payload.hud_home, env, { retry: 'inline', signal });
  return result.ok ? 0 : 1;
}

export async function openComposerPopup(handoffFile: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; error?: string }> {
  const params = {
    plugin_id: SELECT_SEND_PLUGIN_ID,
    entrypoint: SELECT_SEND_COMPOSER_ENTRYPOINT,
    placement: 'popup',
    env: { HUD_SELECT_SEND_FILE: handoffFile },
  };
  if (herdrEndpoint(env)) {
    const reply = await herdrRequest('plugin.pane.open', params, { env, timeoutMs: 2000 }).catch(() => null);
    if (reply && !reply.error) return { ok: true };
    if (reply?.error) return { ok: false, error: `${reply.error.code}: ${reply.error.message ?? ''}`.trim() };
  }
  const bin = env.HERDR_BIN_PATH || 'herdr';
  const cli = await runCommand(
    bin,
    [
      'plugin',
      'pane',
      'open',
      '--plugin',
      SELECT_SEND_PLUGIN_ID,
      '--entrypoint',
      SELECT_SEND_COMPOSER_ENTRYPOINT,
      '--placement',
      'popup',
      '--env',
      `HUD_SELECT_SEND_FILE=${handoffFile}`,
    ],
    env,
    { budgetMs: 3000 }
  );
  return cli.ok ? { ok: true } : { ok: false, error: cli.stderr.trim() || cli.reason };
}

/**
 * Entry point for the herdr plugin action (`hud.select-send.send`).
 * Empty selection does nothing (exits cleanly without opening the composer).
 */
export async function handleSelectionAction(
  hudHome: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ opened: boolean; reason?: string; handoffFile?: string }> {
  const ctx = parsePluginContext(env);
  let excerpt = normalizeSelectionExcerpt(ctx.selected_text);
  let contextToStore = ctx;

  if (excerpt.empty) {
    if (!ctx.selection) return { opened: false, reason: 'empty_selection' };
    const refreshed = await refreshSelectionExcerpt(ctx, excerpt, null, env);
    excerpt = refreshed.excerpt;
    if (excerpt.empty) return { opened: false, reason: 'empty_selection' };
    contextToStore = { ...ctx, selected_text: excerpt.text, stale_content: refreshed.stale };
  }

  const handoffFile = writeSelectionHandoff(hudHome, contextToStore);
  const opened = await openComposerPopup(handoffFile, env);
  if (!opened.ok) {
    try {
      fs.unlinkSync(handoffFile);
    } catch {
      /* Already removed. */
    }
    return { opened: false, reason: opened.error ?? 'popup_open_failed' };
  }
  return { opened: true, handoffFile };
}
