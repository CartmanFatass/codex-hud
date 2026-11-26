/** HUD worker profiles for both tabs and headless jobs. General keeps Pi's native defaults. */
export type GuardMode = 'strict' | 'oracle';
interface PiDefaults { model?: string; thinking?: string; guard?: GuardMode; instructions: string }
export type PiProfile = 'sonic' | 'implementer' | 'reviewer' | 'architect' | 'general';
export const piRoleDefaults: Record<PiProfile, PiDefaults> = {
  sonic: { model: 'mistral/deepseek-v4-1-flash-1017', thinking: 'high', instructions: 'sonic' },
  implementer: { model: 'openai/gpt-6.2-sol', thinking: 'high', instructions: 'implementer' },
  reviewer: { model: 'openai/gpt-6.2-sol', thinking: 'xhigh', instructions: 'reviewer', guard: 'strict' },
  architect: { model: 'openai/gpt-6.2-astra', thinking: 'high', instructions: 'oracle', guard: 'oracle' },
  general: { instructions: 'general' },
};
export const isPiProfile = (value: unknown): value is PiProfile => typeof value === 'string' && Object.hasOwn(piRoleDefaults, value);
export const implicitPiProfile = <T>(instructions: T) => instructions === 'oracle' ? 'architect' : instructions;
export const piProfileError = `Unknown pi_role; expected ${Object.keys(piRoleDefaults).join(', ')}`;
