/** Invocation proof is published by the process that will exec the agent, not
 * by observing whoever happens to be in the pane after `agent start`. */
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { binScript } from '../mcp/paths.js';
import { readJsonBounded, writeFileAtomic, writeJsonPrivate, writePrivateFile } from '../utils/atomic-fs.js';
import { isValidPid, procStat } from '../utils/proc.js';
import { recordStartupShellSessionAt, STARTUP_SESSION_FILE } from './tab-shell.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function launchDir(task: string, launch: string) {
  if (!uuid.test(launch)) throw Error('invalid CLI invocation generation');
  return join(task, 'cli-invocations', launch);
}
/** Let zsh run the owner's startup files before putting the shim first. Non-zsh
 * shells ignore ZDOTDIR and retain the normal PATH lookup and witness refusal. */
function prepareZshStartup(dir: string): string {
  const zdotdir = join(dir, 'zsh');
  const initial = process.env.ZDOTDIR;
  // Start with the caller's normal PATH and ZDOTDIR. Each owner file can
  // redirect the next one by changing ZDOTDIR, just as in native startup.
  const init = `PATH=\${PATH#${quote(dir)}:}\n${initial === undefined ? 'unset ZDOTDIR' : `export ZDOTDIR=${quote(initial)}`}`;
  const restore = 'if [[ -v _hud_owner_zdotdir ]]; then ZDOTDIR=$_hud_owner_zdotdir; else unset ZDOTDIR; fi';
  for (const [file, next] of [
    ['.zshenv', '[[ -o interactive || -o login ]]'],
    ['.zprofile', 'true'],
    ['.zshrc', '[[ -o login ]]'],
    ['.zlogin', 'false'],
  ]) {
    writePrivateFile(join(zdotdir, file), `${file === '.zshenv' ? init : restore}
if [[ -r "\${ZDOTDIR-$HOME}/${file}" ]]; then builtin source "\${ZDOTDIR-$HOME}/${file}"; fi
if [[ -o rcs ]] && ${next}; then
  if [[ -v ZDOTDIR ]]; then typeset -g _hud_owner_zdotdir=$ZDOTDIR; else unset _hud_owner_zdotdir; fi
  export ZDOTDIR=${quote(zdotdir)}
else
  unset _hud_owner_zdotdir
  export PATH=${quote(dir)}:"$PATH"
fi
`, { exclusive: true });
  }
  return zdotdir;
}
export function prepareCliInvocation(task: string, launch: string, agent: string, target: string) {
  const dir = launchDir(task, launch), token = randomUUID();
  if (!/^[a-z]+$/.test(agent) || /[:\r\n]/.test(dir)) throw Error('invalid CLI invocation path');
  const exec = [process.execPath, binScript('hud-cli'), '--exec-witness'].map(quote).join(' ');
  // Both branches set argv[0]; an empty witness path runs without publishing proof.
  writeFileAtomic(join(dir, agent), `#!/bin/sh
if [ "$HUD_INVOCATION_TOKEN" = ${quote(token)} ]; then
  unset HUD_INVOCATION_TOKEN
  exec ${exec} ${quote(join(dir, 'witness.json'))} ${quote(target)} "$@"
fi
exec ${exec} '' ${quote(target)} "$@"
`, { mode: 0o700, exclusive: true });
  return { dir, env: { HUD_INVOCATION_TOKEN: token, PATH: `${dir}:${process.env.PATH ?? ''}`, ZDOTDIR: prepareZshStartup(dir) } };
}
export function invocationWitness(task: string, launch?: string): { pid: number; start: string } | null {
  try {
    if (!launch) return null;
    const record = readJsonBounded(join(launchDir(task, launch), 'witness.json'), 512) as { pid?: unknown; start?: unknown };
    return isValidPid(record?.pid) && typeof record.start === 'string' && /^\d+$/.test(record.start) ? { pid: record.pid, start: record.start } : null;
  } catch { return null; }
}
export function execWitness(file: string, target: string, argv: string[]): never {
  const execve = (process as NodeJS.Process & { execve?: (path: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve;
  if (!execve) throw Error('cannot exec CLI invocation');
  if (file) {
    const start = procStat(process.pid)?.start;
    if (!start) throw Error('cannot witness CLI invocation');
    // Atomic link, never overwrite: replaying the same command cannot adopt a later PID.
    writeJsonPrivate(file, { pid: process.pid, start }, { mkdir: false, exclusive: true });
    const dir = dirname(file), launch = basename(dir);
    if (process.env.HUD_TAB_LAUNCH === launch)
      recordStartupShellSessionAt(join(dir, STARTUP_SESSION_FILE), launch, process.env.HERDR_PANE_ID, { mkdir: false });
  }
  // Linux derives comm from the exec path's basename, even when it is a symlink.
  return execve(target, [basename(target), ...argv], process.env);
}
