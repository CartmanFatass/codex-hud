/**
 * Launch-adapter ids stored in a herdr backend's `recipe`.
 * The registry is closed. Routing rejects anything else at parse time.
 */

export const LAUNCH_ADAPTERS = ['pi-role', 'codex-zsh', 'grok', 'claude'] as const;
export type LaunchAdapterId = (typeof LAUNCH_ADAPTERS)[number];

export const ADAPTER_HARNESS = {
  'pi-role': 'pi',
  'codex-zsh': 'codex',
  grok: 'grok',
  claude: 'claude',
} as const;

export function isLaunchAdapter(value: string): value is LaunchAdapterId {
  return (LAUNCH_ADAPTERS as readonly string[]).includes(value);
}
