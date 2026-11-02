/** Process context only. HostAdapter owns surfaces, readiness, input and focus. */
export interface VisibleHostContext {
  kind: 'herdr' | 'none';
  env: Readonly<Record<string, string>>;
  workspace: string | null;
  tab: string | null;
  pane: string | null;
}

export function visibleHostContext(env: NodeJS.ProcessEnv): VisibleHostContext {
  const context: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (name.startsWith('HERDR_') && value !== undefined) context[name] = value;
  return {
    kind: Object.keys(context).length ? 'herdr' : 'none',
    env: Object.freeze(context),
    workspace: context.HERDR_WORKSPACE_ID ?? null,
    tab: context.HERDR_TAB_ID ?? null,
    pane: context.HERDR_PANE_ID ?? null,
  };
}
