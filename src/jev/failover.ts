// Failover is one transport call, never a browser retry. Invalid/refused payloads stay with their provider.
import type { DecisionProvider, DecisionProviderId, DecisionResult } from './decide.js';
import { JevCredentialsMissing } from './decide.js';
import { DecisionProviderError } from './model.js';
export type FallbackReason = 'credentials_missing' | 'quota' | 'auth' | 'server' | 'timeout';
export interface DecisionCallRecord {
  primary: DecisionProviderId;
  provider: DecisionProviderId;
  model: string;
  operation: 'decide' | 'judge';
  outcome: 'answered' | 'failed';
  fallbackReason?: FallbackReason;
}
export function fallbackReason(error: unknown): FallbackReason | undefined {
  if (!(error instanceof DecisionProviderError)) return undefined;
  if (error.providerCause === 'timeout') return 'timeout';
  if (error.providerCause !== 'http') return undefined;
  if (error.status === 429) return 'quota';
  if (error.status === 401 || error.status === 403) return 'auth';
  if (error.status !== undefined && error.status >= 500 && error.status <= 599) return 'server';
  return undefined;
}
export class FailoverDecisionProvider implements DecisionProvider {
  private answered?: DecisionProvider;
  get id(): DecisionProviderId {
    return this.answered?.id ?? this.primaryId;
  }
  get model(): string {
    return this.answered?.model ?? this.primary?.model ?? this.fallback?.model ?? '';
  }
  constructor(
    private readonly primaryId: DecisionProviderId,
    private readonly primary: DecisionProvider | undefined,
    private readonly fallback: DecisionProvider | undefined,
    private readonly record: (entry: DecisionCallRecord) => void = () => {}
  ) {}
  decide: DecisionProvider['decide'] = (request, options) =>
    this.call('decide', (provider) => provider.decide(request, options), options);
  judge: NonNullable<DecisionProvider['judge']> = (request, options) =>
    this.call('judge', (provider) => provider.judge!(request, options), options);
  private async call(
    operation: 'decide' | 'judge',
    invoke: (provider: DecisionProvider) => Promise<DecisionResult>,
    options: { signal?: AbortSignal; cacheKey: string }
  ): Promise<DecisionResult> {
    options.signal?.throwIfAborted();
    let reason: FallbackReason | undefined;
    let result: DecisionResult;
    let provider = this.primary;
    if (!provider) reason = 'credentials_missing';
    else {
      try {
        result = await invoke(provider);
        return this.finish(operation, provider, result);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        reason = fallbackReason(error);
        if (!reason || !this.fallback || this.fallback.id === this.primaryId) throw error;
      }
    }
    provider = this.fallback;
    if (!provider || provider.id === this.primaryId)
      throw new JevCredentialsMissing(
        this.primaryId,
        this.primaryId === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENAI_API_KEY'
      );
    options.signal?.throwIfAborted();
    try {
      result = await invoke(provider); // exactly one fallback; its failure is final
    } catch (error) {
      this.record({
        primary: this.primaryId,
        provider: provider.id,
        model: provider.model,
        operation,
        outcome: 'failed',
        ...(reason ? { fallbackReason: reason } : {}),
      });
      throw error;
    }
    return this.finish(operation, provider, result, reason);
  }
  private finish(
    operation: 'decide' | 'judge',
    provider: DecisionProvider,
    result: DecisionResult,
    reason?: FallbackReason
  ): DecisionResult {
    this.answered = provider;
    this.record({
      primary: this.primaryId,
      provider: provider.id,
      model: provider.model,
      operation,
      outcome: 'answered',
      ...(reason ? { fallbackReason: reason } : {}),
    });
    return { ...result, provider: provider.id, model: provider.model };
  }
}
