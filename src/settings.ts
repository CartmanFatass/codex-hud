import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HudDisplayConfig } from './render/hud-config.js';
import { getCodexHome } from './utils/codex-path.js';

export interface HudSettings extends HudDisplayConfig {
  statusline: boolean;
  sort: 'active' | 'created';
  mouse: boolean;
  tasks: boolean;
  changes: boolean;
  activity: boolean;
  details: boolean;
  refreshMs: number;
  treeWidth: number;
  /**
   * How long a finished agent stays in the tree's default view, in ms. 0
   * keeps every agent; the panel can still reveal hidden ones on demand.
   */
  finishedLingerMs: number;
  // Monitor visibility is independent of legacy boolean panel preferences.
  agentsPane: 'open' | 'folded' | 'closed';
  worktreesPane: 'open' | 'folded' | 'closed';
  changesPane: 'open' | 'folded' | 'closed';
  detailsPane: 'open' | 'folded' | 'closed';
  /** The session's observed events, newest first. */
  timelinePane: 'open' | 'folded' | 'closed';
  /**
   * How the panel shows the agents: `rich`, a card per agent with the recap
   * as a card above them; `compact`, the tree with the brief and log under it.
   */
  panelStyle: 'rich' | 'compact';
  worktreeRoot: string;
  /**
   * Who writes the agents brief under the tree: nobody, `omp`, `agy`, or any
   * OpenAI-compatible chat completions endpoint (`api`, set up below).
   */
  briefing: 'off' | 'omp' | 'agy' | 'api';
  /** The shortest gap between two briefs, in ms. A brief also waits for something to change. */
  briefingMs: number;
  /** The brief's switch in the panel: true holds the model calls, keeping the last brief. */
  briefingPaused: boolean;
  /** The tree panel's and the brief's language; auto follows the locale. */
  language: 'auto' | 'en' | 'zh';
  /** `api` brief: the endpoint's base URL, up to `/v1`; empty is OpenAI's. */
  briefingApiBase: string;
  /** `api` brief: the model name the endpoint expects. */
  briefingApiModel: string;
  /**
   * `api` brief: the key. Empty falls back to CODEX_HUD_BRIEF_API_KEY, then
   * OPENAI_API_KEY; a local server may need none. The file is written 0600.
   */
  briefingApiKey: string;
  /**
   * `api` brief: the endpoint accepts `reasoning_effort`, so each request's
   * thinking level is sent. Off sends only fields every server accepts.
   */
  briefingApiReasoning: boolean;
  /** The agents brief: subagents' tasks and latest updates go to the backend. On by default once a backend is chosen. */
  briefAgents: boolean;
  /**
   * The main-session recap: the person's prompts and the assistant's public
   * replies go to the backend. Off by default; it is the more sensitive one.
   */
  briefMain: boolean;
  /** The recap's slower trigger: at most one refresh per this while anything changed, in ms. */
  recapFloorMs: number;
  /** Show each agent's log under the tree even with the model backend off (observed entries only). */
  agentLog: boolean;
  /**
   * How much the status card at the foot of the panel shows: `min`, its top
   * edge alone, the session's state on it; `status`, the bar's fields;
   * `full`, those and the main session's brief under them (rich only:
   * compact shows the brief above).
   */
  statusCard: 'min' | 'status' | 'full';
  /** Model calls allowed per hour, over every feature; past it requests are refused with a reason. */
  modelCallsPerHour: number;
  /** A finished agent's final answer in three lines; sends the answer (head and tail when long). */
  resultDigest: boolean;
  /** Short labels for agents from their tasks, and a session title; sends task texts, and the first prompt when there is no recap. */
  agentLabels: boolean;
  /** One line on why a tool call or an agent failed; sends the tail of the error output. */
  failureCause: boolean;
  /** One or two lines on what the current diff does; sends the diff stat and bounded hunks. */
  changeSummary: boolean;
  /** The command awaiting approval in plain words; sends the command. A description, never a verdict. */
  approvalDescription: boolean;
  /** Notifications in tmux on approvals, failures and finished agents. CODEX_HUD_NOTIFY, when set, wins. */
  notify: boolean;
  /** Also notify outside the terminal. CODEX_HUD_NOTIFY_DESKTOP, when set, wins. */
  notifyDesktop: boolean;
  /** A picture drawn in text in the panel's empty space, and its style. */
  art: 'off' | 'dots' | 'color' | 'ascii';
  /** The picture: any image ffmpeg can read. `codex-hud-art <image>` sets it. */
  artImage: string;
}

/** What the brief covers, from its two switches; null when neither is on. */
export function briefingScope(settings: Pick<HudSettings, 'briefAgents' | 'briefMain'>): 'agents' | 'main' | 'both' | null {
  return settings.briefAgents ? settings.briefMain ? 'both' : 'agents' : settings.briefMain ? 'main' : null;
}

/** Built-in defaults; callers apply environment or runtime display overrides. */
export function defaultSettings(): HudSettings {
  return {
    density: 'balanced', theme: 'terminal', glyphs: 'both', motion: 'full', context: 'used',
    statusline: true, sort: 'active', mouse: true, tasks: false, changes: true, activity: false,
    details: true, refreshMs: 1000, treeWidth: 32, finishedLingerMs: 180_000,
    agentsPane: 'open', worktreesPane: 'closed', changesPane: 'closed', detailsPane: 'closed', timelinePane: 'closed', panelStyle: 'rich',
    worktreeRoot: '', briefing: 'off', briefingMs: 300_000, briefingPaused: false, language: 'auto',
    briefingApiBase: '', briefingApiModel: '', briefingApiKey: '', briefingApiReasoning: false,
    briefAgents: true, briefMain: false, recapFloorMs: 900_000, statusCard: 'full', modelCallsPerHour: 60,
    agentLog: false, notify: false, notifyDesktop: false,
    resultDigest: false, agentLabels: false, failureCause: false, changeSummary: false, approvalDescription: false,
    art: 'off', artImage: '',
  };
}

const MAX_SETTINGS_BYTES = 65_536;
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const isIntegerBetween = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const oneOf = (...allowed: string[]) => (value: unknown): boolean =>
  typeof value === 'string' && allowed.includes(value);

const isText = (max: number) => (value: unknown): boolean =>
  typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value);

const validators: Record<keyof HudSettings, (value: unknown) => boolean> = {
  statusline: isBoolean,
  density: oneOf('focus', 'balanced', 'full'),
  theme: oneOf('terminal', 'mocha', 'latte', 'none'),
  glyphs: oneOf('glyph', 'text', 'both'),
  motion: oneOf('full', 'reduced'),
  context: oneOf('used', 'remaining'),
  sort: oneOf('active', 'created'),
  mouse: isBoolean, tasks: isBoolean, changes: isBoolean,
  activity: isBoolean, details: isBoolean,
  refreshMs: (value) => isIntegerBetween(value, 100, 60_000),
  treeWidth: (value) => value === 0 || isIntegerBetween(value, 16, 200),
  finishedLingerMs: (value) => value === 0 || isIntegerBetween(value, 10_000, 86_400_000),
  agentsPane: oneOf('open', 'folded', 'closed'),
  worktreesPane: oneOf('open', 'folded', 'closed'),
  changesPane: oneOf('open', 'folded', 'closed'),
  detailsPane: oneOf('open', 'folded', 'closed'),
  timelinePane: oneOf('open', 'folded', 'closed'),
  panelStyle: oneOf('rich', 'compact'),
  worktreeRoot: value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0'),
  briefing: oneOf('off', 'omp', 'agy', 'api'),
  briefingMs: (value) => isIntegerBetween(value, 30_000, 3_600_000),
  briefingPaused: isBoolean,
  language: oneOf('auto', 'en', 'zh'),
  briefingApiBase: (value) => isText(2048)(value) && (value === '' || /^https?:\/\/\S+$/.test(value as string)),
  briefingApiModel: isText(200),
  briefingApiKey: isText(4096),
  briefingApiReasoning: isBoolean,
  briefAgents: isBoolean,
  briefMain: isBoolean,
  recapFloorMs: (value) => isIntegerBetween(value, 60_000, 7_200_000),
  statusCard: oneOf('min', 'status', 'full'),
  agentLog: isBoolean,
  notify: isBoolean,
  notifyDesktop: isBoolean,
  modelCallsPerHour: (value) => isIntegerBetween(value, 1, 1000),
  resultDigest: isBoolean,
  agentLabels: isBoolean,
  failureCause: isBoolean,
  changeSummary: isBoolean,
  approvalDescription: isBoolean,
  art: oneOf('off', 'dots', 'color', 'ascii'),
  artImage: isText(4096),
};

function mergeValidated(base: HudSettings, raw: unknown): HudSettings {
  const result = { ...base };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const values = raw as Record<string, unknown>;
  for (const key of Object.keys(validators) as Array<keyof HudSettings>) {
    if (Object.hasOwn(values, key) && validators[key](values[key])) {
      Object.assign(result, { [key]: values[key] });
    }
  }
  return result;
}

export function settingsPath(): string {
  return process.env.CODEX_HUD_SETTINGS_PATH || path.join(getCodexHome(), 'hud-settings.json');
}

function readSettings(file: string): HudSettings {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings();
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_SETTINGS_BYTES) throw new Error('HUD settings file is too large (maximum 64 KiB).');
    return mergeValidated(defaultSettings(), JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } finally {
    fs.closeSync(fd);
  }
}

/** Missing files use defaults. Malformed JSON and I/O failures belong to the caller. */
export function loadSettings(): HudSettings {
  return readSettings(settingsPath());
}

/** Validate a patch against existing preferences and atomically replace the file. */
export function saveSettings(patch: Partial<HudSettings>): HudSettings {
  const file = settingsPath();
  const settings = mergeValidated(readSettings(file), patch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Renamed successfully, or cleanup failed after the original error. */ }
  }
  return settings;
}
