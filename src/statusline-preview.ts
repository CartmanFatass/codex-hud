import type { Readable } from 'node:stream';
import { renderStatuslineSession } from './render/statusline-session.js';

export const STATUSLINE_PREVIEW_HELP = `Usage: node bin/hud-statusline-preview [--width COLUMNS]

Read one Claude Code statusline JSON object from stdin and print a plain first line.
Displays supplied model, context used_percentage and total_cost_usd only.
No transcript, settings, ledger, network or subprocess access; nothing is installed.
Width: explicit --width, valid COLUMNS, TTY columns, then 80 (range 1..500).
Input is limited to 64 KiB and a 1-second input wait; this is not a latency guarantee.
This preview does not include delegation summaries, fallback readers or live integration.
Exit 0: rendered/help; 2: arguments; 3: input unavailable/invalid; 1: output failure.
`;

function columns(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 500 ? n : null;
}
export function statuslineWidth(args: readonly string[], envColumns?: string, ttyColumns?: number): number {
  if (args.length && (args.length !== 2 || args[0] !== '--width' || columns(args[1]) === null))
    throw new Error('invalid_arguments');
  return (
    (args.length ? columns(args[1]) : null) ??
    columns(envColumns) ??
    (Number.isSafeInteger(ttyColumns) && ttyColumns! >= 1 && ttyColumns! <= 500 ? ttyColumns! : 80)
  );
}

/** Stop reading on failure; do not wait for a producer that leaves stdin open. */
export function readStatuslineInput(input: Readable, timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: string, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.pause();
      input.off('data', data);
      input.off('end', end);
      input.off('error', fail);
      input.off('close', close);
      if (error) reject(new Error(error));
      else resolve(value);
    };
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 64 * 1024) return finish('statusline_input_too_large');
      chunks.push(buffer);
    };
    const end = () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const value: unknown = JSON.parse(text);
        if (value === null || typeof value !== 'object' || Array.isArray(value))
          return finish('invalid_statusline_input');
        finish(undefined, value);
      } catch {
        finish('invalid_statusline_input');
      }
    };
    const fail = () => finish('statusline_input_unavailable');
    const close = () => finish('statusline_input_unavailable');
    const timer = setTimeout(() => finish('statusline_input_timeout'), timeoutMs);
    input.on('data', data).once('end', end).once('error', fail).once('close', close);
    if (input.readableEnded || input.destroyed) finish('statusline_input_unavailable');
  });
}

export async function statuslinePreview(
  args: readonly string[],
  input: Readable,
  io: {
    columns?: string;
    ttyColumns?: number;
    stdout: (text: string) => void | Promise<void>;
    stderr: (text: string) => void;
  }
): Promise<number> {
  let output: string;
  if (args.length === 1 && args[0] === '--help') output = STATUSLINE_PREVIEW_HELP;
  else {
    let width: number;
    try {
      width = statuslineWidth(args, io.columns, io.ttyColumns);
    } catch {
      io.stderr('invalid_arguments\n');
      return 2;
    }
    try {
      output = renderStatuslineSession(await readStatuslineInput(input), width) + '\n';
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      io.stderr(
        ['invalid_statusline_input', 'statusline_input_too_large', 'statusline_input_timeout'].includes(reason)
          ? `${reason}\n`
          : 'statusline_input_unavailable\n'
      );
      return 3;
    }
  }
  try {
    await io.stdout(output);
    return 0;
  } catch {
    io.stderr('statusline_output_failure\n');
    return 1;
  }
}
