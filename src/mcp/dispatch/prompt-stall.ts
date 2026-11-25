/** Last-resort first-prompt recovery. Never paste the brief again. */
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runHerdr } from '../../roles/herdr-run.js';

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
type Boundary = { file: string; offset: number; inode?: bigint; dev?: bigint };
/** Snapshot before `agent prompt`. Missing proof disables only recovery, not ordinary submission. */
export function promptBoundary(task: string, reported: unknown): Boundary | undefined {
  try {
    const file = boundSession(task, reported);
    if (!file) return;
    const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) return { file, offset: 0 };
    if (stat.isFile() && Number.isSafeInteger(Number(stat.size))) return { file, offset: Number(stat.size), inode: stat.ino, dev: stat.dev };
  } catch { /* Cannot establish a baseline. */ }
}
function delivered(b: Boundary, prompt: string) {
  let fd;
  try { fd = fs.openSync(b.file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
  catch (error) { if (b.inode === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size < b.offset || b.inode !== undefined && (stat.ino !== b.inode || stat.dev !== b.dev))
      throw Error('stalled prompt transcript changed');
    if (stat.size === BigInt(b.offset)) return false;
    const length = Number(stat.size) - b.offset;
    if (length > 1024 * 1024) throw Error('too much new transcript for safe recovery');
    const bytes = Buffer.alloc(length);
    if (fs.readSync(fd, bytes, 0, length, b.offset) !== length) throw Error('incomplete stalled prompt transcript');
    for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
      const content = entry.message.content;
      if (content === prompt || Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && content[0].text === prompt) return true;
      throw Error('different user input since submission');
    }
    return false;
  } finally { fs.closeSync(fd); }
}

export async function recoverStalledPrompt(task: string, name: string, pane: string, prompt: string, boundary: Boundary | undefined,
  herdr = (args: string[]) => runHerdr(args, process.env)) {
  const hint = `inspect with: herdr agent read ${name} --source detection --format text`;
  const checked = async (...args: string[]) => {
    const result = await herdr(args);
    if (!result.ok) throw Error(`${args.join(' ')}: ${result.stderr || result.reason}`);
    return result.stdout;
  };
  const get = async () => {
    const agent = JSON.parse(await checked('agent', 'get', name)).result?.agent;
    if (agent?.name !== name || agent.pane_id !== pane || !boundary || boundSession(task, agent.agent_session?.value) !== boundary.file)
      throw Error('stalled prompt agent or transcript does not match the just-started agent');
    return agent;
  };
  try {
    if (!boundary) throw Error('no pre-submission transcript boundary');
    const live = await get();
    if (delivered(boundary, prompt)) return;
    // Text-format detection does not identify editor borders or soft wraps. Never
    // discard screen prefixes, rule-looking prompt lines or additional newlines.
    const text = await checked('agent', 'read', name, '--source', 'detection', '--format', 'text');
    if (live.agent_status !== 'idle' || !prompt || (text !== prompt && text !== `${prompt}\n`)) throw Error('ambiguous idle editor');
    if (delivered(boundary, prompt)) return;
    if ((await get()).agent_status !== 'idle') throw Error('stalled prompt is not still in the idle editor');
    await checked('pane', 'send-keys', pane, 'Enter');
    const waited = await herdr(['agent', 'wait', name, '--until', 'working', '--until', 'blocked', '--until', 'done', '--timeout', '120000']);
    if (!delivered(boundary, prompt)) throw Error(waited.ok ? 'no matching new user message after one Enter' : 'stalled prompt did not start after one Enter');
  } catch (error) { throw Error(`${(error as Error).message}; ${hint}`); }
}
