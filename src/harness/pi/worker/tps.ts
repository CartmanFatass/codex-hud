import type { WorkerPi, Counts } from './host.js';

// pi-tps 1.3 turn telemetry. pi supplies the custom-entry envelope (id, parentId, ISO timestamp).
const counts = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const newTurn = (start: number) => ({ start, first: NaN, firstStream: NaN, lastStream: NaN, updates: 0,
  messageStart: NaN, last: start, messageCount: 0, generationMs: 0, inStall: false, stallMs: 0, stallCount: 0,
  tokens: counts(), cost: counts(), model: undefined as { provider: string; modelId: string } | undefined, tool: false });

export function trackTps(pi: WorkerPi, clock = () => performance.now()) {
  let turn: ReturnType<typeof newTurn> | undefined;
  const caps = new Map<string, number>();
  pi.on('turn_start', () => { turn = newTurn(clock()); });
  pi.on('message_start', ({ message }) => {
    if (!turn || message.role !== 'assistant') return;
    turn.messageStart = turn.last = clock(); turn.inStall = false; turn.messageCount++;
  });
  pi.on('message_update', ({ message }) => {
    if (!turn || message.role !== 'assistant') return;
    const now = clock(), gap = now - turn.last;
    turn.last = now;
    if (isNaN(turn.first)) { turn.first = now; return; }
    if (!turn.updates++) turn.firstStream = now;
    turn.lastStream = now;
    if (gap >= 500) { turn.stallMs += gap; if (!turn.inStall) turn.stallCount++; }
    turn.inStall = gap >= 500;
  });
  pi.on('tool_execution_start', () => { if (turn) turn.tool = true; });
  pi.on('message_end', ({ message }) => {
    if (!turn || message.role !== 'assistant' || !message.usage) return;
    const { usage } = message;
    if (!isNaN(turn.messageStart)) turn.generationMs += clock() - turn.messageStart;
    turn.messageStart = NaN;
    if (message.provider && message.model) turn.model ??= { provider: message.provider, modelId: message.model };
    for (const key of Object.keys(turn.tokens) as (keyof Counts)[]) {
      turn.tokens[key] += (key === 'total' ? usage.totalTokens : usage[key]) || 0;
      turn.cost[key] += usage.cost?.[key] || 0;
    }
  });
  pi.on('turn_end', () => {
    const t = turn; turn = undefined;
    if (!t?.model || !t.tokens.output || isNaN(t.first)) return;
    const streamMs = t.updates ? t.lastStream - t.firstStream : null;
    const active = (streamMs ?? 0) - t.stallMs;
    let primary = t.updates >= 5 && streamMs! / (t.updates - 1) >= 1 && active >= 200 && t.stallMs < active;
    let window = primary ? active : 0;
    if (!primary && t.updates >= 2 && t.generationMs >= 200) {
      const effective = t.generationMs - t.stallMs;
      window = effective < 200 || t.stallMs > .85 * t.generationMs ? Math.max(200, t.generationMs - t.stallMs / 2) : effective;
    }
    let tps = window ? Math.round(t.tokens.output * 10000 / window) / 10 : null;
    if (tps !== null && tps > 10000) { tps = null; primary = false; }
    const key = `${t.model.provider}/${t.model.modelId}`;
    if (primary && tps !== null) caps.set(key, Math.max(tps, caps.get(key) ?? 0));
    if (t.tool && tps !== null) tps = caps.has(key) ? Math.min(tps, caps.get(key)!) : null;
    const cost = t.cost.total > 0 ? t.cost : null;
    pi.appendEntry('tps', { model: t.model, tokens: t.tokens, timing: { ttftMs: t.first - t.start, totalMs: clock() - t.start,
      generationMs: t.generationMs, streamMs, stallMs: t.stallMs, stallCount: t.stallCount, messageCount: t.messageCount },
      tps, isPrimaryBranch: primary, cost, rateUsdPerMTokens: cost && t.tokens.total > 0 ? Math.round(cost.total * 1e8 / t.tokens.total) / 100 : null,
      timestamp: Date.now() });
  });
}
