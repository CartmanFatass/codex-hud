/** Synthetic Claude records only; no fixture reads or copies user data. */
import * as fs from 'node:fs';

export const SESSION = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
export const TIME = Date.parse('2026-03-01T12:00:00Z');
export const CWD = '/synthetic/claude/project';
export const PRIVATE = 'SYNTHETIC_PRIVATE_DO_NOT_RETAIN';
export const CLAIM = 'synthetic-launch-secret';
export const MiB = 1024 * 1024;

/** Put type after other keys, so the reader must parse JSON rather than sniff a prefix. */
export function row(type: string, fields: Record<string, unknown> = {}, offset = 0): string {
  return JSON.stringify({
    uuid: `synthetic-record-${offset}`,
    sessionId: SESSION,
    timestamp: new Date(TIME + offset).toISOString(),
    cwd: CWD,
    version: '0.synthetic',
    ...fields,
    type,
  });
}

export function user(text = 'Review the synthetic project.', offset = 0): string {
  return row('user', { message: { role: 'user', content: [{ type: 'text', text }] } }, offset);
}

export function assistant(
  id = 'synthetic-message-1',
  usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 },
  offset = 1000,
  content: object[] = [{ type: 'text', text: 'Synthetic public response 中文' }]
): string {
  return row('assistant', { message: { id, role: 'assistant', model: 'claude-synthetic', usage, content } }, offset);
}

export function compact(offset = 3000): string {
  return row('system', { subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 150 } }, offset);
}

export function launch(linkId = 'link-synthetic', claim = CLAIM, offset = 0): string {
  return user('[hud-launch] ' + JSON.stringify({ linkId, claim }), offset);
}

export function toolUse(id = 'synthetic-call', name = 'mcp__hud__delegate_spawn', offset = 1000): string {
  return assistant('synthetic-tool-message-' + id, undefined, offset, [
    { type: 'tool_use', id, name, input: { brief: 'Synthetic fixture task.' } },
  ]);
}

export function toolResult(id = 'synthetic-call', runId = 'run-synthetic', offset = 2000): string {
  return row(
    'user',
    {
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: JSON.stringify({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ linkId: 'link-synthetic', runId, claim: PRIVATE }),
                },
              ],
            }),
          },
        ],
      },
    },
    offset
  );
}

export const initial = [
  user(),
  assistant(),
  assistant('synthetic-message-1', undefined, 1100, [{ type: 'thinking', thinking: PRIVATE }]),
  row('api-request-blob', { data: PRIVATE }, 1200),
  row('ai-title', { aiTitle: 'Synthetic title' }, 1300),
  row('last-prompt', { lastPrompt: 'Synthetic prompt summary' }, 1400),
];

/** Append exactly targetBytes with bounded generation memory; returns generated record count. */
export function appendSyntheticTranscript(file: string, targetBytes: number, seed = 0): number {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 512) throw new Error('targetBytes must be >= 512');
  const fd = fs.openSync(file, 'a');
  let remaining = targetBytes;
  let records = 0;
  let batch = '';
  let batchBytes = 0;
  try {
    while (remaining > 0) {
      const n = seed + records;
      let line =
        records % 8 === 0
          ? assistant(`synthetic-bulk-${n}`, undefined, n)
          : row('api-request-blob', { data: 'x'.repeat(7900) }, n);
      const size = Buffer.byteLength(line) + 1;
      // Leave enough bytes for a valid final padding record with its own newline.
      if (size > remaining || remaining - size < 512) {
        const empty = row('api-request-blob', { data: '' }, n);
        const padding = remaining - Buffer.byteLength(empty) - 1;
        if (padding < 0) throw new Error('insufficient final record space');
        line = row('api-request-blob', { data: 'x'.repeat(padding) }, n);
      }
      batch += line + '\n';
      const lineBytes = Buffer.byteLength(line) + 1;
      batchBytes += lineBytes;
      remaining -= lineBytes;
      records++;
      if (batchBytes >= MiB || remaining === 0) {
        fs.writeSync(fd, batch);
        batch = '';
        batchBytes = 0;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return records;
}
