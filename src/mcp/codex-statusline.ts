/** Codex 0.171's native statusline. Request facts never fall back to another thread or account. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expNativePath, readExpNativeSeen } from '../collectors/exp-native.js';
import { writePrivateFile, readFileBounded } from '../utils/atomic-fs.js';
import { jobRow } from '../collectors/thin-jobs.js';
import { jobCallerPane } from '../roles/job-pane.js';
import { isFileStampCurrent } from '../roles/job-index-cache.js';
import { truncateAnsi } from '../render/colors.js';
import { askOf, NOTICE_MS } from '../render/layout/bar-fields.js';
import { monitorText } from '../render/monitor-text.js';
import { shortModel } from '../render/providers.js';
import { formatWindowLabel } from '../render/quota.js';
import { settingsPath } from '../settings.js';

const URI = 'ui://myhud/codex-statusline';
const MIME = 'application/json';
export const statuslineResource = { uri: URI, name: 'codex-statusline', mimeType: MIME };
export const statuslineTool = {
  name: 'hud_statusline',
  title: 'MyHUD',
  description: 'Compact MyHUD Codex footer summary.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  _meta: { 'openai/ui': { entrypoints: [{ type: 'statusline', resourceUri: URI }] } },
};

type JsonObject = Record<string, unknown>;
const obj = (value: unknown): JsonObject | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const compact = (value: unknown, cols: number): string =>
  typeof value === 'string'
    ? truncateAnsi(monitorText(value.slice(0, 256).replace(/[\ud800-\udfff]/gu, '�')).trim(), cols)
    : '';

/** Only open fixed local files; reject special files and cap each read before parsing. */
function readJson(file: string, maxBytes: number): unknown {
  try {
    const { bytes, stat, truncated } = readFileBounded(file, maxBytes);
    if (!truncated && bytes.length === stat.size) return JSON.parse(bytes.toString('utf8'));
  } catch {
    // A missing or unreadable optional cache is not a statusline failure.
  }
}

interface Fact {
  path: string;
  stamp: string;
  at: number;
  json: JsonObject;
}

/** The bars scope HUD jobs to the inherited pane, not the foreground Codex thread or cwd. */
function workReminder(home: string, pane: string | null, now: number): string | undefined {
  if (!pane) return;
  const rows = readJson(join(home, 'display', 'thin-jobs.json'), 1_048_576);
  if (!Array.isArray(rows) || rows.length > 800) return;
  const receipts = new Map<string, Fact>();
  const statuses = new Map<string, Fact>();
  for (const entry of rows) {
    if (!Array.isArray(entry)) continue;
    const [rel, stamp, raw] = entry;
    const match = typeof rel === 'string' ? /^(j[0-9a-f]{16})\/(job|STATUS)\.json$/.exec(rel) : null;
    const snap = obj(raw), json = obj(snap?.json);
    if (!match || typeof stamp !== 'string' || !json || snap?.whole !== true || !nonnegative(snap.at)) continue;
    const [, id, kind] = match;
    if (kind === 'job' && (json.job !== id || jobCallerPane(json) !== pane)) continue;
    (kind === 'job' ? receipts : statuses).set(id, { path: join(home, 'jobs', rel), stamp, at: snap.at, json });
  }
  let best: { reminder: string; priority: number; at: number; receipt: Fact; status: Fact } | undefined;
  for (const [id, receipt] of receipts) {
    const status = statuses.get(id);
    if (!status) continue;
    const row = jobRow(receipt.json, status.json);
    const role = compact(row.role, 10);
    if (!row.state || !role || row.display_state === 'stopped') continue;
    const asks = row.display_state === 'working' && (row.blocked || row.state === 'waiting_orchestrator');
    const date =
      row.display_state === 'working' || row.display_state === 'queued'
        ? (status.json.started_at ?? receipt.json.created_at)
        : (status.json.settled_at ?? status.json.ended_at);
    const parsed = typeof date === 'string' ? Date.parse(date) : NaN;
    const at = Number.isFinite(parsed) ? parsed : status.at;
    if (!asks && (at > now || now - at >= NOTICE_MS)) continue;
    const priority = asks ? 1 : 0;
    if (best && (priority < best.priority || (priority === best.priority && at <= best.at))) continue;
    const reminder = asks
      ? askOf(role)
      : `${role} ${row.display_state === 'working' ? 'started' : row.display_state}`;
    best = { reminder, priority, at, receipt, status };
  }
  // An unrefreshed cache must not keep a question pinned after the job changes or disappears.
  if (best && isFileStampCurrent(best.receipt.path, best.receipt.stamp) && isFileStampCurrent(best.status.path, best.status.stamp))
    return `HUD: ${best.reminder}`;
}

function recordLastSeen(home: string, now: number): void {
  const dir = join(home, 'exp');
  const enabled = () => {
    const config = obj(readJson(join(dir, 'config.json'), 65_536));
    return (
      config?.version === 1 &&
      obj(config.codex)?.enabled === true &&
      obj(readJson(settingsPath(), 65_536))?.experiments === true
    );
  };
  try {
    if (!fs.lstatSync(dir).isDirectory() || !enabled()) return;
    // Codex's profile name in request metadata is not a local profile directory.
    const profile = fs.realpathSync(process.env.CODEX_HOME || join(homedir(), '.codex'));
    if (!fs.statSync(profile).isDirectory()) return;
    const file = expNativePath(home, profile);
    const due = () => now - (readExpNativeSeen(file) ?? -Infinity) >= 60_000;
    if (!due()) return;
    // Recheck after acquiring this profile's non-blocking writer slot.
    const lock = `${file}.lock`;
    const fd = fs.openSync(lock, 'wx', 0o600);
    try {
      if (due() && enabled()) writePrivateFile(file, JSON.stringify({ version: 1, lastSeenAt: now }) + '\n');
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  } catch {
    // Observation is best-effort; never delay or fail the footer for EXP state.
  }
}

const text = (color: string, value: string) => ({ type: 'text', props: { color }, children: [value] });

export function readCodexStatusline(meta: unknown, home: string, pane: string | null, now = Date.now()) {
  const state = obj(obj(meta)?.['com.openai/codex-statusline-state']);
  const thread = obj(state?.thread);
  const model = obj(thread?.model);
  const context = obj(obj(thread?.usage)?.context);
  const children: ReturnType<typeof text>[] = [];

  const id = typeof model?.id === 'string' ? model.id.slice(0, 256) : undefined;
  const modelName = compact(shortModel(id), 24) || compact(model?.display_name, 24);
  const effort = compact(model?.reasoning_level, 8);
  if (modelName) children.push(text('status-model', effort ? `${modelName} ${effort}` : modelName));

  const used = context?.used_tokens, window = context?.context_window_size;
  const percent = nonnegative(context?.used_percentage)
    ? context.used_percentage
    : nonnegative(used) && nonnegative(window) && window > 0
      ? (used / window) * 100
      : undefined;
  if (nonnegative(percent)) children.push(text('status-usage', `ctx ${Math.min(100, Math.round(percent))}%`));

  const limits = obj(state?.account)?.rate_limits;
  // Codex 0.171 reports the subscription windows in its `codex` bucket.
  const bucket = Array.isArray(limits) ? obj(limits.find((item) => obj(item)?.limit_id === 'codex')) : undefined;
  for (const key of ['primary_limit', 'secondary_limit']) {
    const quota = obj(bucket?.[key]);
    const minutes = quota?.window_minutes, reset = quota?.resets_at;
    if (!nonnegative(quota?.used_percent) || !nonnegative(minutes) || !Number.isSafeInteger(minutes) || minutes === 0)
      continue;
    if (nonnegative(reset) && reset > 0 && reset * 1000 <= now) continue;
    const left = Math.max(0, 100 - Math.round(quota.used_percent));
    children.push(text('status-limit', `${formatWindowLabel(minutes)} ${left}% left`));
  }

  const reminder = workReminder(home, pane, now);
  if (reminder) children.push(text('status-state', reminder));
  const tree = { type: 'row', props: { gap: 2, wrap: 'nowrap' }, children };
  if (state) recordLastSeen(home, now);
  return { contents: [{ uri: URI, mimeType: MIME, text: JSON.stringify(tree) }] };
}
