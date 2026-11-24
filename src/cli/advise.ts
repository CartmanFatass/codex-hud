/**
 * Silent out-of-band CLI trigger for the advisor shadow (spec §2.2).
 * Reads a main-session owner message from stdin JSON or CLI flags, evaluates at most one skill
 * recommendation via the Decision API, records display state + event, and writes nothing to stdout.
 */
import { adviseOnMessage, resolveAdvisorProjectRoot } from '../collectors/advisor-shadow.js';
import { callerSession } from '../collectors/claude-caller-session.js';
import { getHudHome } from '../hud-home.js';
import type { HudIO } from './hud.js';

const MAX_STDIN_BYTES = 64 * 1024;
const STDIN_IDLE_TIMEOUT_MS = 150;
const STDIN_MAX_DURATION_MS = 500;

export const ADVISE_HELP =
  'Usage: hud advise --stdin\n' +
  '       hud advise --message TEXT [--session ID] [--project DIR] [--turn ID] [--prev-reply TEXT]\n' +
  '\n' +
  'Silent out-of-band advisor shadow trigger.\n' +
  'Reads a JSON payload from stdin or flags, writes nothing to stdout/stderr, and exits promptly with no input.\n';

function readStdinBounded(): Promise<string> {
  const stdin = process.stdin as NodeJS.ReadStream & { unref?: () => void };
  if (stdin.isTTY || stdin.readableEnded || stdin.destroyed) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let sawData = false;
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('close', onEnd);
      stdin.off('error', onEnd);
      if (timedOut) {
        stdin.pause();
        stdin.unref?.();
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer | string) => {
      if (!sawData) {
        sawData = true;
        clearTimeout(idleTimer);
      }
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (total < MAX_STDIN_BYTES) {
        const take = buf.subarray(0, MAX_STDIN_BYTES - total);
        chunks.push(take);
        total += take.length;
      }
    };
    const onEnd = () => finish(false);
    const idleTimer = setTimeout(() => finish(true), STDIN_IDLE_TIMEOUT_MS);
    const maxTimer = setTimeout(() => finish(true), STDIN_MAX_DURATION_MS);
    idleTimer.unref?.();
    maxTimer.unref?.();
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('close', onEnd);
    stdin.once('error', onEnd);
    stdin.resume();
  });
}

export async function adviseCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    await io.stdout(ADVISE_HELP);
    return 0;
  }
  let session = '';
  let projectRoot = '';
  let message = '';
  let previousReply = '';
  let messageId: string | undefined;
  let useStdin = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stdin') useStdin = true;
    else if (arg === '--session' && i + 1 < args.length) session = args[++i]!;
    else if (arg === '--project' && i + 1 < args.length) projectRoot = args[++i]!;
    else if (arg === '--turn' && i + 1 < args.length) messageId = args[++i]!;
    else if (arg === '--message' && i + 1 < args.length) message = args[++i]!;
    else if (arg === '--prev-reply' && i + 1 < args.length) previousReply = args[++i]!;
  }

  if (useStdin) {
    try {
      const parsed = JSON.parse(await readStdinBounded()) as Record<string, unknown>;
      if (typeof parsed.session === 'string') session = parsed.session;
      if (typeof parsed.projectRoot === 'string') projectRoot = parsed.projectRoot;
      if (typeof parsed.message === 'string') message = parsed.message;
      if (typeof parsed.previousReply === 'string') previousReply = parsed.previousReply;
      if (typeof parsed.messageId === 'string') messageId = parsed.messageId;
    } catch {
      return 0;
    }
  }

  if (!message.trim()) return 0;
  const resolvedProject = resolveAdvisorProjectRoot(projectRoot || process.cwd());
  if (!session) {
    const caller = await callerSession(io.env).catch(() => undefined);
    session = caller?.session || (io.env.HERDR_PANE_ID ? `pane:${io.env.HERDR_PANE_ID}` : `project:${resolvedProject}`);
  }

  try {
    await adviseOnMessage(
      getHudHome(io.env),
      {
        session,
        projectRoot: resolvedProject,
        message,
        previousReply: previousReply || undefined,
        messageId,
      },
      { env: io.env }
    );
  } catch {
    /* Silent best-effort: advisor shadow never disrupts or writes into a session. */
  }
  return 0;
}
