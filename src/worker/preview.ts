import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { Job } from '../mcp/job-contracts.js';
import { sharedRoot } from '../roles/projects.js';
import type { PreviewReceipt } from '../roles/report-meta.js';
import { loadSettings } from '../settings.js';
import { readFileBounded, writePrivateFile } from '../utils/atomic-fs.js';

export async function openPreview(file: string, wsl = /microsoft/i.test(release()), launch = launchPreview,
  windowsPath = (path: string) => execFileSync('wslpath', ['-w', path], { encoding: 'utf8', timeout: 2000 }).trimEnd()) {
  const path = wsl ? windowsPath(file) : file;
  if (!path) throw new Error('no browser path');
  await launch(wsl ? windowsExplorer() : 'xdg-open', [path]);
}

/** WSL may run without Windows directories on PATH (appendWindowsPath=false), so prefer Explorer's fixed path. */
const windowsExplorer = (fixed = '/mnt/c/Windows/explorer.exe') => fs.existsSync(fixed) ? fixed : 'explorer.exe';

function launchPreview(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // Orphan the opener so worker-tree cleanup cannot close a browser that stays attached to it.
    const child = spawn('/bin/sh', ['-c', '( "$@" 3>&-; printf "%s\\n" "$?" >&3 ) &', 'hud-preview', command, ...args],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    const receipt = child.stdio[3]!;
    const timer = setTimeout(() => { receipt.destroy(); resolve(); }, 2000);
    const finish = (code: string) => {
      clearTimeout(timer);
      receipt.destroy();
      // Explorer commonly exits with 1 after handing the document to Windows Shell.
      if (code === '0' || (basename(command) === 'explorer.exe' && code === '1')) resolve();
      else reject(new Error('browser opener exited unsuccessfully'));
    };
    child.once('error', () => finish(''));
    receipt.once('error', () => finish(''));
    receipt.once('end', () => finish(''));
    receipt.once('data', chunk => finish(String(chunk).trim()));
  });
}

export async function publishPreview(dir: string, job: Job, source: string, previous?: PreviewReceipt, opener = openPreview): Promise<PreviewReceipt> {
  let copy: string, stamp: string;
  try {
    const cwd = fs.realpathSync(job.cwd), file = fs.realpathSync(join(cwd, source)), rel = relative(cwd, file);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('outside cwd');
    const { bytes, stat, truncated } = readFileBounded(file, 16 * 1024 * 1024);
    if (truncated) throw new Error('preview too large');
    let target = fs.realpathSync(job.project_root ?? job.worktree?.main_root ?? sharedRoot(job.cwd));
    for (const part of ['tmp', 'preview', job.job]) {
      target = join(target, part);
      if (!fs.lstatSync(target, { throwIfNoEntry: false })) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(target).isDirectory()) throw new Error('not a preview directory');
    }
    copy = join(target, basename(source));
    stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (previous?.stamp === stamp && previous.path === copy && fs.lstatSync(copy, { throwIfNoEntry: false })?.isFile()) return previous;
    writePrivateFile(copy, bytes, { mkdir: false });
  } catch (error) {
    return { source, error: `Preview ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'not copied'}: ${source}` };
  }
  const result: PreviewReceipt = { source, path: copy, stamp };
  try {
    if (loadSettings({ ...process.env, HUD_HOME: dirname(dirname(dir)) }).openPreviews) await opener(copy);
  } catch { result.error = 'could not open in the default browser'; }
  return result;
}
