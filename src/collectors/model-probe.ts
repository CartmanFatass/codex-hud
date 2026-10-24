import { createHash } from 'node:crypto';
import type { HudSettings } from '../settings.js';
import { SmallModel, modelHttpRequest, type ModelResult, type ModelHandle, type SmallModelOptions } from './small-model.js';

export interface ProbeRow { tier: 'lite' | 'low' | 'medium'; model: string; status: 'waiting' | 'running' | 'ok' | 'failed' | 'cancelled'; elapsedMs?: number; failure?: string }
export interface ModelProbeState { running: boolean; rows: ProbeRow[]; unavailable?: boolean }
const ROUTES = [{ tier: 'lite', feature: 'labels' }, { tier: 'low', feature: 'progress' }, { tier: 'medium', feature: 'recap' }] as const;
const question = { system: 'This is a connectivity check. Return only OK.', prompt: 'Reply with OK.', priority: 'interactive' as const, maxOutputTokens: 256, timeoutMs: 15_000 };

export function probeFingerprint(settings: HudSettings, env: NodeJS.ProcessEnv = process.env): string {
  return createHash('sha256').update(JSON.stringify([settings.briefing, apiSettings(settings), env.CODEX_HUD_BRIEF_MODEL,
    env.CODEX_HUD_BRIEF_API_KEY, env.OPENAI_API_KEY, settings.modelCallsPerHour])).digest('hex');
}

export function apiSettings(settings: HudSettings) {
  return { base: settings.briefingApiBase, key: settings.briefingApiKey, model: settings.briefingApiModel,
    reasoning: settings.briefingApiReasoning, models: { lite: settings.briefingApiLiteModel, low: settings.briefingApiLowModel, medium: settings.briefingApiMediumModel } };
}

/** Explicit synthetic checks only. Closing/editing the draft cancels work and suppresses late results. */
export class ModelProbe {
  private value: ModelProbeState = { running: false, rows: [] };
  private generation = 0;
  private handle: ModelHandle | undefined;
  private model: SmallModel | undefined;
  private fingerprint: string | undefined;
  constructor(private readonly options: SmallModelOptions, private readonly onChange: () => void = () => {}) {}
  current(): ModelProbeState { return { ...this.value, rows: this.value.rows.map(row => ({ ...row })) }; }
  invalidate(settings: HudSettings): void {
    if (this.fingerprint && this.fingerprint !== probeFingerprint(settings, this.options.env)) {
      this.cancel(); this.value = { running: false, rows: [] }; this.fingerprint = undefined;
    }
  }
  cancel(): void {
    ++this.generation;
    this.handle?.cancel(); this.handle = undefined;
    this.model?.cancelAll(); this.model = undefined;
    this.value = { ...this.value, running: false, rows: this.value.rows.map(row =>
      row.status === 'waiting' || row.status === 'running' ? { ...row, status: 'cancelled' } : row) };
  }
  async run(settings: HudSettings): Promise<void> {
    this.cancel();
    const generation = this.generation;
    this.fingerprint = probeFingerprint(settings, this.options.env);
    if (settings.briefing !== 'api') { this.value = { running: false, rows: [], unavailable: true }; this.onChange(); return; }
    const api = apiSettings(settings);
    const model = this.model = new SmallModel(this.options);
    model.configure({ backend: 'api', api, hourlyCap: settings.modelCallsPerHour });
    this.value = { running: true, rows: ROUTES.map(route => {
      const request = modelHttpRequest(api, { ...question, feature: route.feature }, this.options.env);
      return { tier: route.tier, model: 'error' in request ? '' : JSON.parse(request.body).model, status: 'waiting' };
    }) };
    this.onChange();
    for (let i = 0; i < ROUTES.length; i++) {
      if (generation !== this.generation) return;
      const start = Date.now();
      this.value.rows[i].status = 'running'; this.onChange();
      const handle = this.handle = model.submit({ ...question, feature: ROUTES[i].feature });
      const result: ModelResult = await handle.result;
      if (generation !== this.generation) return;
      this.value.rows[i] = { ...this.value.rows[i], status: result.ok ? 'ok' : result.cancelled ? 'cancelled' : 'failed',
        elapsedMs: Date.now() - start, ...(!result.ok ? { failure: result.classification ?? result.reason ?? 'unknown' } : {}) };
      this.onChange();
    }
    if (generation !== this.generation) return;
    this.handle = undefined; this.model = undefined; this.value.running = false; this.onChange();
  }
}
