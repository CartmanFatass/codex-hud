/** Last-resort first-prompt recovery. Never paste the brief again. */
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runHerdr } from '../../roles/herdr-run.js';
import { request, type HerdrReply } from '../../runtime/herdr-socket.js';
import { isProcAlive } from '../../utils/proc.js';
import type { DirectStartIdentity } from './direct-exec.js';

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

/** Read only Claude's bottom composer, not a matching line in the conversation. */
function claudeComposer(screen: string) {
  const rows = screen.trimEnd().split(/\r?\n/);
  let top = -1, bottom = -1;
  for (const [i, row] of rows.entries()) {
    if (/^─{3,}$/.test(row.trim())) { top = bottom; bottom = i; }
  }
  if (top < 0 || top + 1 >= bottom || rows[top].trim() !== rows[bottom].trim()) return;
  const footer = rows.slice(bottom + 1).filter(row => row.trim());
  if (footer.length > 3 || /\b(?:enter to|esc to|arrow keys|select model)\b/i.test(footer.join('\n'))) return;
  const input = rows.slice(top + 1, bottom).join('\n');
  if (!/^\s*❯(?:\s|$)/.test(input)) return;
  const context = /\b(?:ctx|context)\s*:?\s*(\d+(?:\.\d+)?)%/i.exec(footer.join('\n'));
  return { input: input.replace(/^\s*❯/, '').replace(/\s+/g, ''), usedContext: !!context && Number(context[1]) > 0 };
}

/** Herdr already waited five seconds for prompt activity. Resend only with positive
 * evidence of our draft still in the new, idle Claude pane. Fail the launch only
 * if the same evidence shows the prompt still there after the one resend. */
export async function claudePromptResendFailed(name: string, identity: DirectStartIdentity, prompt: string, startupScreen: string,
  reported: () => boolean): Promise<boolean> {
  const { paneId, launchId, terminalId, pid, pidStart } = identity;
  const current = (reply: HerdrReply | null) => {
    const agent = !reply?.error && reply?.result?.agent;
    if (agent && agent.name === name && agent.agent === 'claude' && agent.pane_id === paneId &&
        agent.launch_id === launchId && agent.terminal_id === terminalId) return agent.agent_status;
  };
  const active = (state: string | undefined) => state === 'working' || state === 'blocked';
  const get = async () => current(await request('agent.get', { target: name }, { timeoutMs: 800 }));
  const composer = async () => {
    const reply = await request('pane.read', { pane_id: paneId, source: 'visible', format: 'text' }, { timeoutMs: 800 });
    const text = !reply?.error && reply?.result?.read?.text;
    return typeof text === 'string' ? claudeComposer(text) : undefined;
  };
  const startup = claudeComposer(startupScreen);
  const expected = prompt.replace(/\s+/g, '');
  const newlines = prompt.match(/\r\n|\r|\n/g)?.length ?? 0;
  const holdsPrompt = (draft: ReturnType<typeof claudeComposer>) => {
    if (!draft?.input || draft.usedContext || draft.input === startup?.input) return false;
    // Claude can abbreviate bracketed pastes. Only accept a new paste chip with the
    // launch prompt's line count, not an arbitrary nonempty composer at zero context.
    const pasted = /^\[Pastedtext#\d+\+(\d+)lines\]$/.exec(draft.input);
    return draft.input === expected || (!!startup && !!pasted && Number(pasted[1]) === newlines);
  };
  const idle = (state: string | undefined) => state === 'idle' || state === 'done';
  if (!holdsPrompt(await composer()) || !idle(await get()) || reported() || !isProcAlive(pid, pidStart)) return false;

  // A lost send reply does not justify another Enter. Check the client instead.
  await request('pane.send_keys', { pane_id: paneId, keys: ['Enter'] }, { timeoutMs: 800 });
  const waited = await request('agent.wait', { target: name, until: ['working', 'blocked'], timeout_ms: 3000 }, { timeoutMs: 3500 });
  if (active(current(waited)) || reported()) return false;
  return holdsPrompt(await composer()) && idle(await get()) && !reported();
}
