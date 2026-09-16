import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function panelWidth(requested:number,windowWidth:number):number {
  const desired = requested > 0 ? requested : Math.max(20,Math.min(30,Math.floor(windowWidth/5)));
  const max = windowWidth-41 >= 10 ? windowWidth-41 : Math.floor(windowWidth/3);
  return Math.max(1,Math.min(max,Math.max(16,desired)));
}
export async function resizeTreePane(requested:number):Promise<void> {
  const pane = process.env.TMUX_PANE;
  if (!pane || !/^%\d+$/.test(pane) || !process.env.CODEX_HUD_MAIN_PANE) return;
  const {stdout} = await exec('tmux',['display-message','-p','-t',pane,'#{window_width}'],{timeout:2000});
  const width = Number(stdout.trim());
  if (!Number.isInteger(width) || width < 1) return;
  await exec('tmux',['resize-pane','-t',pane,'-x',String(panelWidth(requested,width))],{timeout:2000});
}
