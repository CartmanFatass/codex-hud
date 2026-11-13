/** Per-kind launch facts (probed 2026-11-13). A new kind is a row. `phantom-working` is waited out before the prompt. */
export const cliAgents = ['grok', 'agy', 'claude', 'codex'] as const;
export type CliAgent = (typeof cliAgents)[number];

export interface CliKind {
  model: (model: string) => string[];
  effort: (thinking: string) => string[];
  bypass: readonly string[];
  /**
   * Null when this kind shows no directory-trust dialog under its bypass flag.
   * `text` null means the sentence was not measured yet (a later ticket fills it); decline keys are.
   */
  trust: { text: string | null; decline: readonly string[] } | null;
  /** Null keeps `herdr agent start`'s own timeout. */
  startTimeoutMs: number | null;
  startupQuirk: 'none' | 'done-before-prompt' | 'phantom-working';
}

export const cliKinds: Record<CliAgent, CliKind> = {
  grok: {
    model: (model) => ['-m', model],
    effort: (thinking) => ['--reasoning-effort', thinking],
    bypass: ['--permission-mode', 'bypassPermissions'],
    trust: { text: 'Do you trust the contents of this directory?', decline: ['n'] },
    startTimeoutMs: null,
    startupQuirk: 'none',
  },
  agy: {
    model: (model) => ['--model', model],
    effort: (thinking) => ['--effort', thinking],
    bypass: ['--dangerously-skip-permissions'],
    trust: { text: 'Do you trust the contents of this project?', decline: ['down', 'enter'] },
    startTimeoutMs: null,
    startupQuirk: 'done-before-prompt',
  },
  claude: {
    model: (model) => ['--model', model],
    effort: (thinking) => ['--effort', thinking],
    bypass: ['--dangerously-skip-permissions'],
    trust: { text: 'Is this a project you created or one you trust?', decline: ['enter'] },
    startTimeoutMs: null,
    startupQuirk: 'none',
  },
  codex: {
    model: (model) => ['-m', model],
    effort: (thinking) => ['-c', `model_reasoning_effort=${thinking}`],
    bypass: ['--dangerously-bypass-approvals-and-sandbox'],
    trust: null,
    startTimeoutMs: 90000,
    startupQuirk: 'phantom-working',
  },
};
