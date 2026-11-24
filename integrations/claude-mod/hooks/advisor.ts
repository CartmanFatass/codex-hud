import type { EngineInterface, On } from 'claude-code';

// Advisor shadow trigger for Claude Code main sessions: fire-and-forget out-of-band check.
// Never returns or injects any advisor text into the session, prompt, transcript, or hook output.
const WAKE_PREFIX = 'HUD events (status only;';

async function triggerAdvisor(
  $: EngineInterface,
  text: string,
  turnId: string,
  previousReply: string,
  fallbackCwd: string,
  reply?: string
): Promise<void> {
  if (await $.env.get('HUD_JOB_DIR') !== undefined) return;
  const home = (await $.env.get('HUD_HOME')) || `${await $.env.get('HOME')}/.hud`;
  const settingsFile = (await $.env.get('HUD_SETTINGS_PATH')) || `${home}/hud-settings.json`;
  let enabled = false;
  try {
    const parsed = JSON.parse(await $.fs.read(settingsFile));
    enabled = parsed?.advisorShadow === true && (reply !== undefined
      ? typeof parsed.advisorRulesFile === 'string' && parsed.advisorRulesFile.length > 0
      : Array.isArray(parsed.advisorSkillDirs) && parsed.advisorSkillDirs.length > 0);
  } catch {
    return;
  }
  if (!enabled) return;

  const cwd = (await $.session.cwd().catch(() => fallbackCwd)) || fallbackCwd;
  const root = (await $.session.root().catch(() => cwd)) || cwd;
  const session = await $.env.get('CLAUDE_CODE_SESSION_ID');
  // Leave headroom for the CLI to scrub secrets before applying the Decision API text caps.
  const argv = [
    'hud',
    'advise',
    ...(session ? ['--session', session] : []),
    '--project',
    root,
    '--turn',
    turnId,
    '--message',
    text.slice(0, reply === undefined ? 2000 : 16_000),
    ...(reply !== undefined ? ['--reply', reply.slice(-16_000)]
      : previousReply ? ['--prev-reply', previousReply.slice(0, 2000)] : []),
  ];
  await $.process.run(argv, { cwd: cwd || '.', timeoutMs: 10_000 }).catch(() => undefined);
}

export function registerAdvisor(on: On) {
  let sessionCwd = '';
  let interactive = false;
  let lastReply = '';
  let owner: { turn: string; text: string } | undefined;

  on('session.start', async (_, e, next) => {
    interactive = e.isInteractive;
    sessionCwd = e.cwd;
    lastReply = '';
    owner = undefined;
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const latest = owner?.turn === e.turnId ? owner : undefined;
      if (latest) owner = undefined; // Consume the reply boundary, even if no rule check runs.
      if (typeof e.answer === 'string' && e.answer.trim()) {
        lastReply = e.answer.slice(0, 2000);
        if (latest && e.reason !== 'aborted') {
          void triggerAdvisor($, latest.text, e.turnId, '', sessionCwd, e.answer).catch(() => {});
        }
      }
    }
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    if (interactive && e.agentId === undefined && typeof e.text === 'string') {
      const trimmed = e.text.trim();
      owner = undefined;
      if (trimmed && !trimmed.startsWith(WAKE_PREFIX) && !trimmed.startsWith('/')) {
        owner = { turn: e.turnId, text: trimmed.slice(0, 16_000) };
        void triggerAdvisor($, trimmed, e.turnId, lastReply, sessionCwd).catch(() => {});
      }
    }
    return next(e);
  });
}
