/** Finite internal control entry. Hook input is data, never native eligibility proof. */
import { pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';
import { CliPanelHerdr } from './herdr.js';
import { controlPanel, type PanelOperation } from './control.js';
import { absolute, validStamp, validateContext, type PanelContext } from './receipt.js';
export const PANEL_INPUT_MAX = 64 * 1024;
export const PANEL_HOOK_TIMEOUT_MS = 5000;
export const PANEL_OPERATION_MS = 4000;
export async function readPanelInput(input: Readable, ms = 500): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      input.off('data', data);
      input.off('end', end);
      input.off('error', fail);
      input.pause();
      if (error) reject(error);
    };
    const fail = () => finish(new Error('panel_input_unavailable'));
    const data = (chunk: Buffer | string) => {
      const b = Buffer.from(chunk);
      bytes += b.length;
      if (bytes > PANEL_INPUT_MAX) return finish(new Error('panel_input_oversize'));
      chunks.push(b);
    };
    const end = () => {
      finish();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new Error('panel_input_invalid'));
      }
    };
    const timer = setTimeout(() => finish(new Error('panel_input_deadline')), Math.min(ms, 500));
    input.on('data', data);
    input.on('end', end);
    input.on('error', fail);
  });
}
export async function panelControlMain(args = process.argv.slice(2), env = process.env): Promise<number> {
  try {
    if (args.length !== 1 || !['open', 'close', 'toggle', 'status'].includes(args[0]!))
      throw new Error('panel_operation_invalid');
    const payload = (await readPanelInput(process.stdin)) as {
      context?: PanelContext;
      generation?: string;
      endpoint?: { socket?: string; server?: unknown };
    };
    if (
      !payload?.context ||
      !payload.endpoint ||
      !absolute(payload.endpoint.socket) ||
      !validStamp(payload.endpoint.server)
    )
      throw new Error('panel_input_invalid');
    validateContext(payload.context);
    const herdr = new CliPanelHerdr({ socket: payload.endpoint.socket, server: payload.endpoint.server, env });
    const result = await controlPanel(args[0] as PanelOperation, payload.context, {
      env,
      herdr,
      native: null,
      generation: payload.generation,
      budgetMs: args[0] === 'close' ? 900 : PANEL_OPERATION_MS,
    });
    // No task text, source paths or credentials in hook diagnostics.
    process.stdout.write(
      JSON.stringify({
        phase: result.receipt?.phase ?? (result.diagnostic === 'panel_receipt_lost' ? 'uncertain' : 'closed'),
        generation: result.receipt?.generation ?? null,
        diagnostic: result.diagnostic,
        ...(result.message ? { message: result.message } : {}),
      }) + '\n'
    );
    return ['open', 'closed', 'closing', 'opening'].includes(result.diagnostic) ? 0 : 3;
  } catch (e) {
    const reason = e instanceof Error && /^panel_[a-z_]+$/.test(e.message) ? e.message : 'panel_control_unavailable';
    process.stderr.write(reason + '\n');
    return 3;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await panelControlMain();
