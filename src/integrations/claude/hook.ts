/** Finite local command hook. Hook JSON selects an event, never supplies native proof. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readPanelInput } from '../panel/cli.js';
import { controlPanel, type PanelOperation, type PanelControlOptions } from '../panel/control.js';
import { PanelStore, panelKey, readJson, saveJson } from '../panel/receipt.js';
import { captureNative, type NativeCapture } from './native.js';
import { setupCommand } from './setup.js';
import type { ClaudeBinding } from './binding.js';
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  command_name?: string;
  command_args?: string;
  prompt?: string;
  expansion_type?: string;
}
export type LocalCommand = { kind: 'panel' | 'setup'; args: string[]; invalid?: boolean };
export function parseCommand(input: HookInput): LocalCommand | null {
  let name: string;
  let tail: string;
  if (input.hook_event_name === 'UserPromptExpansion') {
    if (input.expansion_type !== 'slash_command') return null;
    name = input.command_name ?? '';
    tail = input.command_args ?? '';
  } else if (input.hook_event_name === 'UserPromptSubmit') {
    const match = /^(\/hud:hud|\/hud|\/hud:setup)(?:\s+([^\r\n]*))?$/.exec(input.prompt ?? '');
    if (!match) return null;
    name = match[1].slice(1);
    tail = match[2] ?? '';
  } else return null;
  if (!['hud:hud', 'hud', 'hud:setup'].includes(name)) return null;
  // Fixed grammar, no shell evaluation. Quoting only groups a local file path with spaces.
  const tokens = tail.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g) ?? [];
  const args = tokens.map((v) => (/^['"]/.test(v) ? v.slice(1, -1) : v));
  const remainder = tail.replace(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g, '').trim();
  return { kind: name === 'hud:setup' ? 'setup' : 'panel', args, invalid: !!remainder };
}
function diagnostic(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  return /^[a-z_]{1,120}$/.test(text) ? text : 'local_operation_failed';
}
export async function handleHook(
  input: HookInput,
  binding: ClaudeBinding,
  env: NodeJS.ProcessEnv,
  deps: {
    capture?: () => Promise<NativeCapture>;
    setup?: typeof setupCommand;
    panelProbes?: Pick<PanelControlOptions, 'processInfo' | 'processLaunch' | 'registered'>;
  } = {}
): Promise<object> {
  const command = parseCommand(input);
  const blocked = (reason: string) => ({
    decision: 'block',
    reason: `HUD: ${reason}`.slice(0, 4096),
    hookSpecificOutput: { hookEventName: input.hook_event_name, suppressOriginalPrompt: true },
  });
  const lifecycle = ['SessionStart', 'SessionEnd'].includes(input.hook_event_name ?? '');
  if (!command && !lifecycle) return {};
  try {
    if (command?.invalid) return blocked('invalid_arguments');
    if (command?.kind === 'setup') {
      const result = (deps.setup ?? setupCommand)(command.args, binding, env);
      return blocked(JSON.stringify(result));
    }
    const action = command ? (command.args[0] ?? 'status') : input.hook_event_name === 'SessionStart' ? 'on' : 'off';
    if (command && (command.args.length > 1 || !['on', 'off', 'toggle', 'status', 'help'].includes(action)))
      return blocked('unknown_subcommand; use on|off|toggle|status|help');
    if (action === 'help')
      return blocked(
        'on|off|toggle|status|help. off is session-local. setup preview is read-only; apply --plan FILE; restore --backup FILE.'
      );
    const captured = await (deps.capture?.() ?? captureNative(binding, env));
    const { context, native, herdr } = captured;
    if (input.session_id !== context.target.ref.sessionId) throw new Error('stale_context');
    const stateKey = createHash('sha256')
      .update(panelKey(context) + '\0' + context.target.root)
      .digest('hex');
    const epoch = join(binding.hudHome, 'display/claude-hooks', stateKey + '.json');
    if (input.hook_event_name === 'SessionEnd') saveJson(epoch, { ended: true });
    else if (readJson(epoch) === null) {
      try {
        saveJson(epoch, { ended: false }, true);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    const isCurrent = () => captured.isCurrent() && (readJson(epoch) as { ended?: boolean } | null)?.ended === false;
    const store = new PanelStore(env);
    const old = store.read(panelKey(context));
    // Retain A3's returned generation, persisted in its own receipt; never use a supplied hook generation.
    const generation = old?.target.root === context.target.root ? old.generation : undefined;
    const operation: PanelOperation =
      action === 'on' ? 'open' : action === 'off' ? 'close' : (action as PanelOperation);
    const result = await controlPanel(operation, context, {
      ...deps.panelProbes,
      env,
      native,
      herdr,
      isCurrent,
      generation,
      automatic: input.hook_event_name === 'SessionStart',
      budgetMs: operation === 'close' ? 800 : 3000,
    });
    const reason =
      result.diagnostic === 'panel_worker_session'
        ? 'panel_worker_session; panel belongs to the main session'
        : result.diagnostic;
    return command ? blocked(reason) : { systemMessage: `HUD: ${reason}` };
  } catch (error) {
    const reason = diagnostic(error);
    const message = reason === 'panel_worker_session' ? reason + '; panel belongs to the main session' : reason;
    return command ? blocked(message) : { systemMessage: `HUD: ${message}` };
  }
}
export async function hookMain(binding: ClaudeBinding, lifecycle = false): Promise<void> {
  try {
    const input = await readPanelInput(process.stdin);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('hook_input_invalid');
    const result = await handleHook(input as HookInput, binding, { ...process.env, HUD_HOME: binding.hudHome });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    // Invalid/oversized input cannot safely become an expanded model prompt.
    process.stdout.write(
      JSON.stringify(lifecycle ? {} : { decision: 'block', reason: 'HUD: hook_input_refused' }) + '\n'
    );
  }
}
