import type { ReaderResult } from '../interfaces/harness-adapter.js';
import type { ReaderCheckpoint } from '../types/observation.js';
import type { CodexCheckpoint } from '../../harness/codex/index.js';

/** Only use with a checkpoint already validated and pinned by the observation store. */
export function checkpointRate(checkpoint: ReaderCheckpoint, now: number): ReaderResult['outputRate'] {
  if (checkpoint.ref.harness !== 'codex' || !Number.isFinite(now)) return undefined;
  const rollout = (checkpoint as CodexCheckpoint).codex?.rollout;
  const saved = rollout?.version === 3 ? rollout.state.cachedResult : null;
  const rate = saved?.outputRate;
  const start = saved?.activity?.turnStartedAt;
  if (
    !rate ||
    !Number.isFinite(rate.tokensPerSecond) ||
    rate.tokensPerSecond < 0 ||
    !Number.isFinite(rate.sampleMs) ||
    rate.sampleMs <= 0 ||
    !Number.isFinite(rate.sampledAt) ||
    rate.sampledAt < 0 ||
    rate.sampledAt > now ||
    (start !== undefined && rate.sampledAt <= start)
  )
    return undefined;
  return {
    source: 'codex.turn_wallclock_proxy',
    tokensPerSecond: rate.tokensPerSecond,
    sampleMs: rate.sampleMs,
    sampledAt: rate.sampledAt,
  };
}
