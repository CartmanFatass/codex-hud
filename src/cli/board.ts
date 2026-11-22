/** `hud board [--html] [--cwd DIR] [--out FILE] [--open]`: write the project's review board as one static HTML file. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ProjectCollector } from '../collectors/project-board.js';
import { STATE_BYTES } from '../collectors/state-ledger.js';
import { SmallModel } from '../collectors/small-model.js';
import { writePrivateFile } from '../utils/atomic-fs.js';
import { readThinJobs } from '../collectors/thin-jobs.js';
import { TryBriefs } from '../collectors/try-brief.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { getHudDisplayHome, getHudHome } from '../hud-home.js';
import { renderHtmlBoard } from '../render/html-board.js';
import { resolveLanguage, type Language } from '../render/i18n.js';
import { executable } from '../roles/roster.js';
import { loadSettings, type HudSettings } from '../settings.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';

export const BOARD_HELP =
  'Usage: hud board [--html] [--cwd DIR] [--out FILE] [--open]\n' +
  'Write this project\'s review board (progress, to-try work, jobs, tickets, newest review) as one static HTML file\n' +
  'and print its path. Default: $HUD_HOME/display/board-<project>.html (0600). --open: wslview or xdg-open, if installed.\n';

export interface BoardRun {
  cwd: string;
  hudHome: string;
  env: NodeJS.ProcessEnv;
  now: number;
  lang: Language;
  acceptance?: HudSettings['acceptance'];
  workboard: WorkboardSnapshot;
  /** Stored briefs only: `TryBriefs.apply` reads its cache and starts no model call. */
  briefs: Pick<TryBriefs, 'apply'>;
  out?: string;
}

const slug = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64) || 'project';

/** The newest review, read like STATE: bounded and never through a link. */
function readReview(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const bytes = Buffer.alloc(STATE_BYTES);
      return bytes.toString('utf8', 0, fs.readSync(fd, bytes));
    } finally { fs.closeSync(fd); }
  } catch { return undefined; }
}

/** One full collection of the project, rendered and written atomically (0600); returns the path. */
export async function writeBoard(run: BoardRun): Promise<string> {
  const root = fs.realpathSync(run.cwd);
  const collected = await new ProjectCollector(root, run.hudHome, run.env).collect('export', run.workboard, run.now);
  const project = collected && run.briefs.apply(root, collected);
  if (!project) throw new Error('no project facts');
  const html = renderHtmlBoard({
    projectName: basename(root), root, project, workboard: run.workboard, generatedAt: run.now, lang: run.lang, acceptance: run.acceptance,
    reviewText: readReview(project.docs.find((d) => d.label === 'review')?.path),
  });
  const file = run.out ? resolve(run.out) : join(getHudDisplayHome(run.env), `board-${slug(basename(root))}.html`);
  // Temp file + rename: an existing link at `file` is replaced, never followed.
  writePrivateFile(file, html);
  return file;
}

/** wslview, else xdg-open, detached; false when neither is on PATH. */
export function openBoard(file: string, env: NodeJS.ProcessEnv): boolean {
  const opener = executable('wslview', env) ?? executable('xdg-open', env);
  if (!opener) return false;
  try {
    const child = spawn(opener, [file], { detached: true, stdio: 'ignore', env, shell: false });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

function parseArgs(args: readonly string[]): { cwd: string; out?: string; open: boolean } {
  let cwd: string | undefined, out: string | undefined, open = false, html = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], value = () => {
      const v = args[++i];
      if (!v || v.startsWith('-')) throw new CliError(BOARD_HELP.split('\n')[0]);
      return v;
    };
    if (arg === '--cwd' && cwd === undefined) cwd = value();
    else if (arg === '--out' && out === undefined) out = value();
    else if (arg === '--open' && !open) open = true;
    else if (arg === '--html' && !html) html = true;
    else throw new CliError(BOARD_HELP.split('\n')[0]);
  }
  try {
    const dir = fs.realpathSync(cwd ?? process.cwd());
    if (fs.statSync(dir).isDirectory()) return { cwd: dir, ...(out ? { out } : {}), open };
  } catch { /* fall through */ }
  throw new CliError(`not a directory: ${cwd}`);
}

export async function boardCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(BOARD_HELP);
    return 0;
  }
  const { cwd, out, open } = parseArgs(args), now = Date.now(), hudHome = getHudHome(io.env);
  let settings: ReturnType<typeof loadSettings> | undefined;
  try { settings = loadSettings(io.env); } catch { /* Unreadable settings: defaults. */ }
  const lang = resolveLanguage(settings?.language ?? 'auto', io.env);
  // Jobs are the caller pane's (as the panel shows them); outside herdr there is no pane, so none.
  const lanes = readThinJobs(hudHome, { project: cwd, pane: io.env.HERDR_PANE_ID ?? null }, JSON.parse, { settledBefore: now - 3_600_000 });
  const workboard: WorkboardSnapshot = {
    revision: 'board', lanes, workers: lanes.flatMap((l) => l.workers), decisions: lanes.flatMap((l) => l.decisions),
    coverage: { incomplete: false, diagnostics: [], workspace: cwd },
  };
  const briefs = new TryBriefs(new SmallModel(), join(getHudDisplayHome(io.env), 'model-cache', 'try-briefs.json'));
  briefs.configure(settings?.modelEnabled ?? false, lang);
  let file: string;
  try { file = await writeBoard({ cwd, hudHome, env: io.env, now, lang, acceptance: settings?.acceptance, workboard, briefs, out }); }
  catch (error) { throw new CliError(`board_failed: ${(error as NodeJS.ErrnoException).code ?? 'could not write the board'}`, 1); }
  await io.stdout(`${file}\n`);
  if (open && !openBoard(file, io.env)) io.stderr('no opener found (wslview or xdg-open); open the file above in a browser\n');
  return 0;
}
