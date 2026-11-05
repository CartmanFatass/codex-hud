import type { LaunchProfile } from '../../core/types/capabilities.js';

const boundedText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\x00-\x1f\x7f]/.test(value);

/** Role names never select an inferred model or an executable template. */
export function claudeManagedRole(
  profile: LaunchProfile,
  options: { role?: string; model?: string; effort?: string }
): { role: string | null; model: string | null; effort: string | null } {
  const role = options.role ?? null;
  const mapping = role !== null && profile.roles && Object.hasOwn(profile.roles, role) ? profile.roles[role] : null;
  const model = options.model ?? mapping?.model ?? null;
  const effort = options.effort ?? mapping?.effort ?? null;
  if (role !== null && model === null) throw new Error('role_model_unconfigured');
  for (const value of [role, model, effort])
    if (value !== null && !boundedText(value)) throw new Error('invalid_role_options');
  for (const value of [model, effort]) if (value?.startsWith('-')) throw new Error('invalid_role_options');
  return { role, model, effort };
}

/** Task text stays stdin data. Claims and guessed session identities never enter the prompt. */
export function claudeManagedInstructions(runId: string): string {
  return (
    `\n\n[HUD delegation]\nCall delegate_whoami before doing this task. ` +
    `Only proceed after it confirms this run. Call delegate_report with runId ${JSON.stringify(runId)} ` +
    `when reporting the result. Do not create another HUD-managed delegation.\n`
  );
}
