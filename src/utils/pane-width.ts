import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runHerdr, herdrResult, isRecord, herdrId } from '../roles/herdr-run.js';
const exec = promisify(execFile);
/** A request for none (0, from older settings) uses DEFAULT_WIDTH. */
export const DEFAULT_WIDTH = 56;
/** Home's width presets; other saved widths still draw. */
export const PANEL_WIDTHS: readonly number[] = [40, 48, 56, 64, 80, 100];

/**
 * The panel takes the width asked for, 56 unless told otherwise,
 * and the agent keeps at least 41 columns. bin/codex-hud-toggle and bin/codex-hud
 * open the pane at that width before this takes over.
 */
export function panelWidth(requested: number, windowWidth: number): number {
  const desired = requested > 0 ? requested : DEFAULT_WIDTH;
  const max = windowWidth - 41 >= 10 ? windowWidth - 41 : Math.floor(windowWidth / 3);
  return Math.max(1, Math.min(max, Math.max(16, desired)));
}

/**
 * Keeps the tree pane at its policy width as the window around it changes.
 *
 * tmux shares a window's growth equally between side-by-side panes. A
 * session created at one terminal width and attached at another therefore
 * hands the tree half of the difference: a 24-column panel sized for a
 * 120-column launch became 58 columns once a 188-column terminal attached.
 * Re-applying the policy whenever the window width changes undoes that. A
 * resize that leaves the window width alone is someone dragging the border,
 * and the pane is left the way they set it.
 */
export class TreeWidthKeeper {
  private applied: number | null = null;
  private generation = 0;
  constructor(
    private readonly readWindowWidth: () => Promise<number | null>,
    private readonly resize: (paneWidth: number) => Promise<void>,
    private readonly requested: () => number
  ) {}
  /** Size the pane now: at startup, and when a new width is saved. */
  async apply(): Promise<void> {
    const generation = ++this.generation;
    const width = await this.readWindowWidth();
    if (width === null || generation !== this.generation) return;
    this.applied = width;
    await this.resize(panelWidth(this.requested(), width));
  }
  /** Size it again only if the window is no longer the width it was sized for. */
  async follow(): Promise<void> {
    const generation = this.generation;
    const width = await this.readWindowWidth();
    if (width === null || width === this.applied || generation !== this.generation) return;
    this.applied = width;
    await this.resize(panelWidth(this.requested(), width));
  }
}

async function tmuxWindowWidth(pane: string): Promise<number | null> {
  const { stdout } = await exec('tmux', ['display-message', '-p', '-t', pane, '#{window_width}'], { timeout: 2000 });
  const width = Number(stdout.trim());
  return Number.isInteger(width) && width >= 1 ? width : null;
}

/** The keeper for the right split opened by openPanelPane, never another pane. */
function herdrWidthKeeper(requested: () => number): TreeWidthKeeper | null {
  const env = process.env, pane = env.HERDR_PANE_ID, caller = env.HUD_PANEL_CALLER_PANE;
  if (!herdrId(pane) || !herdrId(caller) || pane === caller) return null;
  let ratio = 0, total = 0;
  return new TreeWidthKeeper(async () => {
    const reply = await runHerdr(['pane', 'layout', '--pane', pane], env, { budgetMs: 2000 });
    const layout = reply.ok ? herdrResult(reply.stdout)?.layout : null;
    if (!isRecord(layout) || !Array.isArray(layout.panes) || !Array.isArray(layout.splits)) return null;
    const own = layout.panes.find((p) => p.pane_id === pane)?.rect;
    const agent = layout.panes.find((p) => p.pane_id === caller)?.rect;
    if (!own || !agent || own.x !== agent.x + agent.width || own.y !== agent.y || own.height !== agent.height) return null;
    const split = layout.splits.find((s) => s.direction === 'right' && s.rect?.x === agent.x &&
      s.rect?.y === own.y && s.rect?.height === own.height && s.rect?.width === agent.width + own.width);
    if (!split || !Number.isFinite(split.ratio) || !(split.rect.width > 0)) return null;
    ratio = split.ratio;
    return total = split.rect.width;
  }, async (width) => {
    const delta = 1 - width / total - ratio;
    if (Math.abs(delta) * total < 0.5) return;
    const reply = await runHerdr(['pane', 'resize', '--pane', pane, '--direction', delta > 0 ? 'right' : 'left',
      '--amount', String(Math.abs(delta))], env, { budgetMs: 2000 });
    if (!reply.ok) throw Error(`herdr_${reply.reason}`);
  }, requested);
}

/** The keeper for this process's own pane, or null outside a HUD tree pane. */
export function treeWidthKeeper(requested: () => number): TreeWidthKeeper | null {
  const pane = process.env.TMUX_PANE;
  if (!pane || !/^%\d+$/.test(pane) || !process.env.CODEX_HUD_MAIN_PANE) return herdrWidthKeeper(requested);
  return new TreeWidthKeeper(
    () => tmuxWindowWidth(pane),
    async (width) => {
      await exec('tmux', ['resize-pane', '-t', pane, '-x', String(width)], { timeout: 2000 });
    },
    requested
  );
}
