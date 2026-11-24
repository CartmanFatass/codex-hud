/**
 * Copy text to the terminal clipboard via OSC 52, with a `clip.exe` fallback on WSL.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { release } from 'node:os';

const ESC = '\x1b';
const BEL = '\x07';

/** OSC 52 clipboard sequence (base64 payload), wrapped in tmux DCS passthrough when inside tmux. */
export function osc52Sequence(text: string, options: { tmux?: boolean } = {}): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const payload = `${ESC}]52;c;${encoded}${BEL}`;
  if (!options.tmux) return payload;
  return `${ESC}Ptmux;${payload.split(ESC).join(ESC + ESC)}${ESC}\\`;
}

const windowsClip = (fixed = '/mnt/c/Windows/System32/clip.exe') => (fs.existsSync(fixed) ? fixed : 'clip.exe');

function defaultRunClip(command: string, text: string): boolean {
  try {
    const res = spawnSync(command, [], {
      input: text,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 2000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

export interface ClipboardOptions {
  env?: NodeJS.ProcessEnv;
  wsl?: boolean;
  write?: (seq: string) => void;
  runClip?: (command: string, text: string) => boolean;
}

/** Write OSC 52 to the terminal and, on WSL, also feed `clip.exe` as fallback. */
export function copyToClipboard(text: string, options: ClipboardOptions = {}): boolean {
  const env = options.env ?? process.env;
  const wsl = options.wsl ?? /microsoft/i.test(release());
  const write = options.write ?? ((seq: string) => { process.stdout.write(seq); });
  const runClip = options.runClip ?? defaultRunClip;
  let ok = false;
  try {
    write(osc52Sequence(text, { tmux: Boolean(env.TMUX) }));
    ok = true;
  } catch {
    /* Closed or unavailable stdout: fall through to WSL clip.exe when present. */
  }
  if (wsl) {
    if (runClip(windowsClip(), text)) ok = true;
  }
  return ok;
}
