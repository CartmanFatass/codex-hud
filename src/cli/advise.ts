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

function readStdinBounded(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    process.stdin.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (total < MAX_STDIN_BYTES) {
        const take = buf.subarray(0, MAX_STDIN_BYTES - total);
        chunks.push(take);
        total += take.length;
      }
    });
    process.stdin.once('end', done);
    process.stdin.once('error', done);
  });
}

export async function adviseCommand(args: readonly string[], io: HudIO): Promise<number> {
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
