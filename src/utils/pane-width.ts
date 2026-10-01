import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
/** The narrow preset, and the width of a request for none (0, from older settings). */
export const NARROW_WIDTH = 32;

/**
 * The panel takes the width asked for, narrow (32) unless told otherwise,
 * and Codex keeps at least 41 columns. bin/codex-hud-toggle and bin/codex-hud
 * open the pane at the narrow width before this takes over.
 */
export function panelWidth(requested:number,windowWidth:number):number {
  const desired = requested > 0 ? requested : NARROW_WIDTH;
  const max = windowWidth-41 >= 10 ? windowWidth-41 : Math.floor(windowWidth/3);
  return Math.max(1,Math.min(max,Math.max(16,desired)));
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
  constructor(
    private readonly readWindowWidth: () => Promise<number | null>,
    private readonly resize: (paneWidth: number) => Promise<void>,
    private readonly requested: () => number,
  ) {}
  /** Size the pane now: at startup, and when a new width is saved. */
  async apply(): Promise<void> {
    const width = await this.readWindowWidth();
    if (width === null) return;
    this.applied = width;
    await this.resize(panelWidth(this.requested(), width));
  }
  /** Size it again only if the window is no longer the width it was sized for. */
  async follow(): Promise<void> {
    const width = await this.readWindowWidth();
    if (width === null || width === this.applied) return;
    this.applied = width;
    await this.resize(panelWidth(this.requested(), width));
  }
}

async function tmuxWindowWidth(pane:string):Promise<number|null> {
  const {stdout} = await exec('tmux',['display-message','-p','-t',pane,'#{window_width}'],{timeout:2000});
  const width = Number(stdout.trim());
  return Number.isInteger(width) && width >= 1 ? width : null;
}

/** The keeper for this process's own pane, or null outside a HUD tree pane. */
export function treeWidthKeeper(requested:()=>number):TreeWidthKeeper|null {
  const pane = process.env.TMUX_PANE;
  if (!pane || !/^%\d+$/.test(pane) || !process.env.CODEX_HUD_MAIN_PANE) return null;
  return new TreeWidthKeeper(()=>tmuxWindowWidth(pane),
    async width=>{await exec('tmux',['resize-pane','-t',pane,'-x',String(width)],{timeout:2000});},requested);
}
