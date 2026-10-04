/**
 * Put text in tmux's paste buffer, for the person to paste where they like.
 * It only fills the buffer: nothing is typed into any pane.
 */
import { execFile } from 'node:child_process';

/** `set-buffer -w` (also send to the system clipboard) arrived in tmux 3.2. */
export function tmuxSupportsClipboard(versionOutput: string): boolean {
  const match = versionOutput.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 3 || (major === 3 && minor >= 2);
}

/** The arguments of one `tmux set-buffer`; `--` keeps text that starts with a dash from reading as a flag. */
export function tmuxCopyArgs(text: string, clipboard: boolean): string[] {
  return ['set-buffer', ...(clipboard ? ['-w'] : []), '--', text];
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}

let clipboard: boolean | undefined;

export async function copyToTmuxBuffer(text: string): Promise<void> {
  if (!process.env.TMUX) throw new Error('not inside tmux');
  if (clipboard === undefined) clipboard = tmuxSupportsClipboard(await run(['-V']).catch(() => ''));
  await run(tmuxCopyArgs(text, clipboard));
}
