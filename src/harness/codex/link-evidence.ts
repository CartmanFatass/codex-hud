import type { ToolResultLinkEvidence } from '../../core/interfaces/session-evidence.js';

export const LINK_EVIDENCE_LIMIT = 100;
/** @deprecated Unresolved pairs have no truncation limit; kept for old importers only. */
export const PENDING_HUD_CALL_LIMIT = 100;
export type NativeLinkEvidence = Omit<ToolResultLinkEvidence, 'ref'>;
export interface LinkScanState {
  pendingHudCalls?: Record<string, string>;
  linkEvidence?: NativeLinkEvidence[];
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function resultObject(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof value === 'string' && value.length <= 1024 * 1024) {
    try {
      return resultObject(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (!record(value) || value.isError === true) return null;
  if (text(value.linkId) && text(value.runId)) return value;
  if (record(value.structuredContent)) return resultObject(value.structuredContent, depth + 1);
  if (Array.isArray(value.content) && value.content.length === 1) {
    const item = value.content[0];
    if (record(item) && item.type === 'text') return resultObject(item.text, depth + 1);
  }
  return null;
}

/** Only exact hud-mcp function call/output pairs. No arguments, shell output, private blocks or claim retention. */
export function observeLinkEvidence(
  entry: { type?: string; timestamp?: string; payload?: unknown },
  into: LinkScanState,
  serverNames: readonly string[] = ['hud', 'hud-mcp'],
  pending?: Map<string, string>
): void {
  if (entry.type !== 'response_item' || !record(entry.payload)) return;
  const p = entry.payload;
  if (p.type === 'function_call' && text(p.call_id) && text(p.name)) {
    const allowed = serverNames.some((server) =>
      ['delegate_spawn', 'delegate_resume', 'delegate_whoami'].some((tool) => p.name === `mcp__${server}__${tool}`)
    );
    if (!allowed) return;
    if (pending) pending.set(p.call_id, p.name);
    else {
      into.pendingHudCalls ??= Object.create(null) as Record<string, string>;
      Object.defineProperty(into.pendingHudCalls, p.call_id, {
        value: p.name,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    return;
  }
  if (p.type !== 'function_call_output' || !text(p.call_id)) return;
  const tool = pending
    ? pending.get(p.call_id)
    : Object.hasOwn(into.pendingHudCalls ?? {}, p.call_id)
      ? into.pendingHudCalls![p.call_id]
      : undefined;
  if (!tool) return;
  if (pending) pending.delete(p.call_id);
  else delete into.pendingHudCalls![p.call_id];
  const value = resultObject(p.output);
  const eventAt = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  if (!value || !Number.isFinite(eventAt)) return;
  into.linkEvidence = [
    ...(into.linkEvidence ?? []),
    {
      kind: 'tool_result',
      tool,
      callId: p.call_id,
      nativeMessageId: text(p.id) ? p.id : null,
      linkId: value.linkId as string,
      runId: value.runId as string,
      eventAt,
      ...(text(value.launchCallId) ? { launchCallId: value.launchCallId } : {}),
      ...(text(value.launchCorrelationId) ? { launchCorrelationId: value.launchCorrelationId } : {}),
    },
  ].slice(-LINK_EVIDENCE_LIMIT) as NativeLinkEvidence[];
}

/** Reject malformed cache fields as a unit; never let older scan data bypass extraction limits. */
export function validLinkScanState(value: LinkScanState): boolean {
  if (
    value.pendingHudCalls !== undefined &&
    (!record(value.pendingHudCalls) ||
      !Object.entries(value.pendingHudCalls).every(([id, tool]) => text(id) && text(tool)))
  )
    return false;
  return (
    value.linkEvidence === undefined ||
    (Array.isArray(value.linkEvidence) &&
      value.linkEvidence.length <= LINK_EVIDENCE_LIMIT &&
      value.linkEvidence.every(
        (e) =>
          record(e) &&
          Object.keys(e).every((key) =>
            [
              'kind',
              'tool',
              'callId',
              'nativeMessageId',
              'linkId',
              'runId',
              'eventAt',
              'launchCallId',
              'launchCorrelationId',
            ].includes(key)
          ) &&
          e.kind === 'tool_result' &&
          text(e.tool) &&
          text(e.callId) &&
          (e.nativeMessageId === null || text(e.nativeMessageId)) &&
          text(e.linkId) &&
          text(e.runId) &&
          typeof e.eventAt === 'number' &&
          Number.isFinite(e.eventAt) &&
          (e.launchCallId === undefined || text(e.launchCallId)) &&
          (e.launchCorrelationId === undefined || text(e.launchCorrelationId))
      ))
  );
}
