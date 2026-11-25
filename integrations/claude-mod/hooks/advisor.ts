import type { EngineInterface, SessionStartInput, TurnCompleteInput, TurnStartInput } from 'claude-code';

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

type Advisor = {
  fallbackCwd: string;
  interactive: boolean | undefined;
  lastReply: string;
  owner?: { turn: string; text: string };
};

export function createAdvisor(session?: SessionStartInput): Advisor {
  return { fallbackCwd: session?.cwd ?? '', interactive: session?.isInteractive, lastReply: '' };
}

export async function startAdvisorTurn($: EngineInterface, advisor: Advisor, e: TurnStartInput) {
  // A fresh module can first see a turn after /reload-plugins, not a session start.
  advisor.interactive ??= (await $.session.surfaces()).length > 0;
  advisor.owner = undefined;
  if (!advisor.interactive || typeof e.text !== 'string') return;
  const text = e.text.trim();
  if (!text || text.startsWith(WAKE_PREFIX) || text.startsWith('/') || text.startsWith('<task-notification>')) return;
  if (text.startsWith('<system-reminder>') && !text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()) return;
  advisor.owner = { turn: e.turnId, text: text.slice(0, 16_000) };
  void triggerAdvisor($, text, e.turnId, advisor.lastReply, advisor.fallbackCwd).catch(() => {});
}

export function completeAdvisorTurn($: EngineInterface, advisor: Advisor, e: TurnCompleteInput) {
  if (advisor.owner?.turn !== e.turnId) return;
  const { text } = advisor.owner;
  advisor.owner = undefined; // Consume the reply boundary, even if no rule check runs.
  if (typeof e.answer !== 'string' || !e.answer.trim()) return;
  advisor.lastReply = e.answer.slice(0, 2000);
  if (e.reason !== 'aborted') {
    void triggerAdvisor($, text, e.turnId, '', advisor.fallbackCwd, e.answer).catch(() => {});
  }
}
