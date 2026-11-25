/** Last-resort first-prompt recovery. Never paste the brief again. */
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { runHerdr } from '../../roles/herdr-run.js';

// Pi can report its session before creating the file. Resolve existing ancestors;
// a dangling symlink is not evidence of a missing task-local file.
function canonical(file: string): string {
  try { return fs.realpathSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || fs.lstatSync(file, { throwIfNoEntry: false })) throw error;
    return join(canonical(dirname(file)), basename(file));
  }
}
function boundSession(task: string, reported: unknown): string | undefined {
  if (typeof reported !== 'string' || !isAbsolute(reported)) return;
  const file = canonical(reported), root = join(task, 'sessions');
  const path = relative(canonical(root), file);
  if (path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)) return file;
  try {
    const link = fs.readlinkSync(join(root, basename(file)));
    if (canonical(resolve(root, link)) === file) return file;
  } catch (error) {
    if (!['ENOENT', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}
async function hasUserMessage(file: string | undefined) {
  if (!file) return false;
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile()) throw Error('session is not a file');
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === 'message' && entry.message?.role === 'user') return true;
    }
    return false;
  } finally { stream.destroy(); }
}

// Detection can include the screen around Pi's horizontal editor borders. Do not
// match an old transcript line or a prompt that is only part of the editor text.
function exactEditor(text: string, prompt: string): boolean {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (!prompt) return false;
  if (lines.join('\n') === prompt) return true;
  let bottom = -1, top = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (bottom < 0) { if (/^─{3,}\s*$/.test(lines[i])) bottom = i; }
    else if (/^──.*─\s*$/.test(lines[i])) { top = i; break; }
  }
  if (top >= 0 && /↑ \d+ more/.test(lines[top])) return false; // Only part of the editor is visible.
  const editor = top >= 0 ? lines.slice(top + 1, bottom) : lines;
  let at = 0;
  for (const [i, line] of editor.entries()) {
    if (i && prompt[at] === '\n') at++; // Original hard newline. Other breaks may only be soft wraps.
    else if (i && (!line || !editor[i - 1])) return false;
    if (!prompt.startsWith(line, at)) return false;
    at += line.length;
  }
  return at === prompt.length;
}

export async function recoverStalledPrompt(task: string, name: string, pane: string, prompt: string,
  herdr = (args: string[]) => runHerdr(args, process.env)) {
  const hint = `inspect with: herdr agent read ${name} --source detection --format text`;
  const checked = async (...args: string[]) => {
    const result = await herdr(args);
    if (!result.ok) throw Error(`${args.join(' ')}: ${result.stderr || result.reason}`);
    return result.stdout;
  };
  const get = async () => {
    const agent = JSON.parse(await checked('agent', 'get', name)).result?.agent;
    if (agent?.name !== name || agent.pane_id !== pane) throw Error('stalled prompt agent does not match the just-started agent');
    return agent;
  };
  try {
    const live = await get();
    const reported = live.agent_session?.value;
    const file = boundSession(task, reported);
    if (await hasUserMessage(file)) return;
    if (live.agent_status !== 'idle' || !exactEditor(await checked('agent', 'read', name, '--source', 'detection', '--format', 'text'), prompt))
      throw Error('stalled prompt is not still in the idle editor');
    if (await hasUserMessage(file)) return;
    const current = await get(); // Recheck the binding and idle state immediately before sending the key.
    if (current.agent_session?.value !== reported) throw Error('stalled prompt session changed');
    if (current.agent_status !== 'idle') throw Error('stalled prompt is not still in the idle editor');
    await checked('pane', 'send-keys', pane, 'Enter');
    const waited = await herdr(['agent', 'wait', name, '--until', 'working', '--until', 'blocked', '--until', 'done', '--timeout', '120000']);
    if (!waited.ok && !await hasUserMessage(file)) throw Error('stalled prompt did not start after one Enter');
  } catch (error) { throw Error(`${(error as Error).message}; ${hint}`); }
}
