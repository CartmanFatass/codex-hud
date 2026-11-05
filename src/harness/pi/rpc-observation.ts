/** Read-only RPC event seam. No launch, request sending, authority or provider access. */
export const PI_RPC_LEGACY = '781152fc24841dc54b22284514604048ebe5e2c9'; // v0.73.1
export const PI_RPC_SETTLED = '9b9cb30ae16e5802ba556b282b38fc41117ee5e1';
export interface PiRpcObservation {
  profile: 'v0.73.1' | 'settled-v1' | 'unknown';
  state: 'waiting' | 'running' | 'run_ended' | 'settled' | 'aborted' | 'no_run';
  endedRuns: number;
  retrying: boolean;
  compacting: boolean;
  quiescence: 'reported' | 'unknown';
  stopped: null | 'deadline' | 'transport' | 'limit';
  unknownEvents: number;
  malformed: number;
  commandFailed: boolean;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** One prompt observer. Call tick even when idle; clock values are supplied by the stream owner. */
export class PiRpcObserver {
  private readonly deadline: number;
  private events = 0;
  private state: PiRpcObservation;
  constructor(
    sourceCommit: string,
    startMs: number,
    timeoutMs = 30_000,
    private readonly promptId = 'prompt-1'
  ) {
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 300_000 ||
      !promptId ||
      promptId.length > 256
    )
      throw new Error('invalid_rpc_observation_options');
    this.deadline = startMs + timeoutMs;
    this.state = {
      profile: sourceCommit === PI_RPC_LEGACY ? 'v0.73.1' : sourceCommit === PI_RPC_SETTLED ? 'settled-v1' : 'unknown',
      state: 'waiting',
      endedRuns: 0,
      retrying: false,
      compacting: false,
      quiescence: 'unknown',
      stopped: null,
      unknownEvents: 0,
      malformed: 0,
      commandFailed: false,
    };
  }
  snapshot(): PiRpcObservation {
    return structuredClone(this.state);
  }
  tick(nowMs: number): PiRpcObservation {
    if (!Number.isFinite(nowMs)) throw new Error('invalid_rpc_clock');
    if (!this.state.stopped && nowMs >= this.deadline) this.state.stopped = 'deadline';
    return this.snapshot();
  }
  close(): PiRpcObservation {
    if (!this.state.stopped) this.state.stopped = 'transport';
    return this.snapshot();
  }
  observe(value: unknown, nowMs: number): PiRpcObservation {
    this.tick(nowMs);
    if (this.state.stopped) return this.snapshot();
    if (++this.events > 2000) {
      this.state.stopped = 'limit';
      return this.snapshot();
    }
    if (!object(value) || typeof value.type !== 'string') {
      this.state.malformed++;
      return this.snapshot();
    }
    const s = this.state;
    // New activity invalidates an earlier quiet observation. Events never confer task success.
    switch (value.type) {
      case 'agent_start':
        s.state = 'running';
        s.quiescence = 'unknown';
        break;
      case 'agent_end':
        if (!Array.isArray(value.messages)) {
          s.malformed++;
          break;
        }
        s.endedRuns++;
        s.state = 'run_ended';
        s.quiescence = 'unknown';
        break;
      case 'agent_settled':
        if (s.profile !== 'settled-v1') {
          s.unknownEvents++;
          break;
        }
        if (typeof value.aborted !== 'boolean' || s.state === 'waiting') {
          s.malformed++;
          break;
        }
        s.state = value.aborted ? 'aborted' : 'settled';
        s.quiescence = 'reported';
        s.retrying = false;
        s.compacting = false;
        break;
      case 'auto_retry_start':
        s.retrying = true;
        s.state = 'running';
        s.quiescence = 'unknown';
        break;
      case 'auto_retry_end':
        if (typeof value.success !== 'boolean') {
          s.malformed++;
          break;
        }
        s.retrying = false; // Neither successful retry nor exhausted retries prove session quiescence.
        break;
      case 'compaction_start':
        s.compacting = true;
        s.quiescence = 'unknown';
        break;
      case 'compaction_end':
        s.compacting = false;
        break;
      case 'response':
        // Correlation is observational, never an authorization proof. Unrelated responses do not settle this prompt.
        if (value.command !== 'prompt' || value.id !== this.promptId) break;
        if (typeof value.success !== 'boolean') {
          s.malformed++;
          break;
        }
        if (!value.success) {
          s.commandFailed = true;
          break;
        }
        if (
          s.profile === 'settled-v1' &&
          object(value.data) &&
          value.data.disposition === 'handled' &&
          s.state === 'waiting'
        ) {
          s.state = 'no_run';
          s.quiescence = 'unknown';
        }
        break;
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'message_update':
      case 'message_end':
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        break;
      default:
        s.unknownEvents++;
        s.quiescence = 'unknown';
    }
    return this.snapshot();
  }
}
