import type { EngineInterface, On } from 'claude-code';

// Advisor shadow trigger for Claude Code main sessions: fire-and-forget out-of-band check.
// Never returns or injects any advisor text into the session, prompt, transcript, or hook output.
const WAKE_PREFIX = 'HUD events (status only;';

async function triggerAdvisor(
  $: EngineInterface,
  text: string,
  turnId: string,
  previousReply: string,
  fallbackCwd: string
): Promise<void> {
  if (await $.env.get('HUD_JOB_DIR') !== undefined) return;
  const home = (await $.env.get('HUD_HOME')) || `${await $.env.get('HOME')}/.hud`;
  const settingsFile = (await $.env.get('HUD_SETTINGS_PATH')) || `${home}/hud-settings.json`;
  let enabled = false;
  try {
    const parsed = JSON.parse(await $.fs.read(settingsFile));
    enabled = parsed?.advisorShadow === true && Array.isArray(parsed?.advisorSkillDirs) && parsed.advisorSkillDirs.length > 0;
  } catch {
    return;
  }
  if (!enabled) return;

  const cwd = (await $.session.cwd().catch(() => fallbackCwd)) || fallbackCwd;
  const root = (await $.session.root().catch(() => cwd)) || cwd;
  const argv = [
    'hud',
    'advise',
    '--project',
    root,
    '--turn',
    turnId,
    '--message',
    text.slice(0, 2000),
    ...(previousReply ? ['--prev-reply', previousReply.slice(0, 2000)] : []),
  ];
  await $.process.run(argv, { cwd: cwd || '.', timeoutMs: 10_000 }).catch(() => undefined);
}

export function registerAdvisor(on: On) {
  let sessionCwd = '';
  let lastReply = '';

  on('session.start', async (_, e, next) => {
    if (e.isInteractive) sessionCwd = e.cwd;
    return next(e);
  });

  on('turn.complete', async (_, e, next) => {
    if (e.agentId === undefined && typeof e.answer === 'string' && e.answer.trim()) {
      lastReply = e.answer.slice(0, 2000);
    }
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && typeof e.text === 'string') {
      const trimmed = e.text.trim();
      if (trimmed && !trimmed.startsWith(WAKE_PREFIX) && !trimmed.startsWith('/')) {
        void triggerAdvisor($, trimmed, e.turnId, lastReply, sessionCwd).catch(() => {});
      }
    }
    return next(e);
  });
}
