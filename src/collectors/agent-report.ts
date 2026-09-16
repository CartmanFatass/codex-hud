/** Public agent-authored text, not tool activity, reasoning or verified workspace results. */
export interface AgentReport {
  text: string;
  at: Date;
  kind: 'message' | 'update' | 'reply';
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

/** Read completed public message records only. No synthesized task/progress/status. */
export function extractAgentReport(raw: unknown): AgentReport | undefined {
  const entry = record(raw);
  const payload = record(entry?.payload);
  if (!entry || !payload || typeof entry.timestamp !== 'string') return undefined;
  const at = new Date(entry.timestamp);
  if (!Number.isFinite(at.getTime())) return undefined;
  // Never surface analysis/reasoning or an unknown future private channel.
  const channel = payload.channel;
  if (channel !== undefined && channel !== null && channel !== 'final' && channel !== 'commentary') return undefined;
  const phase = payload.phase;
  if (phase !== undefined && phase !== null && phase !== 'commentary' && phase !== 'final_answer') return undefined;
  let text: string | undefined;
  if (entry.type === 'event_msg' && payload.type === 'agent_message') {
    text = typeof payload.message === 'string' ? payload.message : undefined;
  } else if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && Array.isArray(payload.content)) {
    text = payload.content.map(part => {
      const block = record(part);
      return block && (block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string' ? block.text : '';
    }).filter(Boolean).join(' ');
  }
  if (!text?.trim()) return undefined;
  // Bound retained text; escaping happens at the rendering boundary. This is
  // an excerpt, not a generated summary or proof that the claimed work happened.
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  text = chars.slice(0, 600).join('') + (chars.length > 600 ? '…' : '');
  return { text, at, kind: phase === 'final_answer' || channel === 'final' ? 'reply'
    : phase === 'commentary' || channel === 'commentary' ? 'update' : 'message' };
}
