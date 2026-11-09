/** Observation metadata, not an execution/control command. */
import type { HudIO } from './link-export.js';
import { CliError, privateHome } from './private-home.js';
import { registerExternal, removeExternal } from '../roles/external-association.js';
import { parseRosterRoot } from '../roles/selection.js';

export const OBSERVE_HERDR_HELP = `Usage: hud observe-herdr --root <namespace/session-id> --id <slug> --agent <agent> --pane <pane-id> --tab <tab-id> [--workspace <id>] --label <label>
       hud observe-herdr --root <namespace/session-id> --id <slug> --remove
Registers observation only; never launches, adopts, or closes a Herdr task.
`;
export async function observeHerdrCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(OBSERVE_HERDR_HELP);
    return 0;
  }
  const values = new Map<string, string>();
  let remove = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--remove' && !remove) {
      remove = true;
      continue;
    }
    if (!['--root', '--id', '--agent', '--pane', '--tab', '--workspace', '--label'].includes(key) || values.has(key))
      throw new CliError('invalid_arguments');
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new CliError('invalid_arguments');
    values.set(key, value);
  }
  const root = values.get('--root');
  const id = values.get('--id');
  if (!root || !id) throw new CliError('invalid_arguments');
  try {
    parseRosterRoot(root);
  } catch {
    throw new CliError('invalid_root');
  }
  const home = privateHome(io.env);
  try {
    if (remove) {
      if (values.size !== 2) throw new CliError('invalid_arguments');
      removeExternal(home, root, id);
    } else {
      const agent = values.get('--agent'),
        pane = values.get('--pane'),
        tab = values.get('--tab'),
        label = values.get('--label');
      if (!agent || !pane || !tab || !label) throw new CliError('invalid_arguments');
      registerExternal(home, { root, id, agent, pane, tab, label, workspace: values.get('--workspace') ?? null });
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(error instanceof Error ? error.message : 'registration_failed', 2);
  }
  await io.stdout(remove ? 'removed\n' : 'registered\n');
  return 0;
}
