import { resolveLaunchCommand } from '../../core/capabilities.js';
import type { LaunchCommand } from '../../core/types/capabilities.js';

export const CLAUDE_MANAGED_VERSION = '2.1.305';
export const canonicalClaudeSessionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** A finite default-discovery print lane, never a relabelled unmanaged transport.
 * Refuse alternate discovery, fork/latest resume, settings overrides, wrappers,
 * positional prompts and permission bypass rather than silently dropping them.
 */
export function claudeManagedCommand(input: {
  template: LaunchCommand;
  operation: 'spawn' | 'resume';
  cwd: string;
  sourceRoot: string;
  model: string | null;
  effort: string | null;
  resumeSessionId?: string;
}): LaunchCommand & { argv: string[] } {
  if (!input.template.argv) throw new Error('claude_managed_argv_required');
  const variables: Record<string, string> = { cwd: input.cwd, sourceRoot: input.sourceRoot };
  if (input.model !== null) variables.model = input.model;
  if (input.effort !== null) variables.effort = input.effort;
  if (input.operation === 'resume') {
    if (!canonicalClaudeSessionId(input.resumeSessionId)) throw new Error('invalid_claude_resume_session');
    variables.sessionId = input.resumeSessionId;
  } else if (input.resumeSessionId !== undefined) throw new Error('unexpected_resume_session');
  const resolved = resolveLaunchCommand(input.template, variables);
  if (!resolved.argv?.length || !resolved.argv[0] || resolved.argv[0].includes('\0'))
    throw new Error('invalid_launch_template');
  // Executable selection cannot depend on task/session/role values.
  if (input.template.argv[0].includes('{{')) throw new Error('invalid_claude_executable_template');
  const argv = [...resolved.argv];
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    const flag = argument === '--print' ? '-p' : argument;
    if (seen.has(flag)) throw new Error('invalid_claude_managed_arguments');
    seen.add(flag);
    if (flag === '-p' || flag === '--verbose' || flag === '--include-partial-messages') continue;
    if (flag === '--output-format') {
      if (argv[++index] !== 'stream-json') throw new Error('invalid_claude_managed_arguments');
      continue;
    }
    if (flag === '--resume') {
      if (input.operation !== 'resume' || argv[++index] !== input.resumeSessionId)
        throw new Error('invalid_claude_managed_arguments');
      // The identity is supplied by the authoritative current run, never a literal profile session.
      if (input.template.argv[index] !== '{{sessionId}}') throw new Error('invalid_claude_resume_template');
      continue;
    }
    if (flag === '--model' || flag === '--effort') {
      const value = flag === '--model' ? input.model : input.effort;
      if (value === null || argv[++index] !== value) throw new Error('invalid_claude_managed_arguments');
      continue;
    }
    throw new Error('invalid_claude_managed_arguments');
  }
  if (!seen.has('-p') || !seen.has('--output-format') || !seen.has('--verbose'))
    throw new Error('invalid_claude_managed_arguments');
  if (input.operation === 'resume' && !seen.has('--resume')) throw new Error('invalid_claude_resume_template');
  if (input.model !== null && !seen.has('--model')) argv.push('--model', input.model);
  if (input.effort !== null && !seen.has('--effort')) argv.push('--effort', input.effort);
  return { argv };
}
