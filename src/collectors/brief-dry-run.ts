import type { HudSettings } from '../settings.js';

export interface DryRunOptions {
  cwd: string;
  settings: HudSettings;
  codexHome: string;
  hudHome: string;
  jobHome?: string;
  now?: number;
}

export async function dryRunText(_options: DryRunOptions): Promise<{ text: string } | { error: string }> {
  return { error: 'Periodic briefs and main recaps have been removed; native card text uses the model queue.' };
}
