import { privateHome, CliError } from './runtime.js';
import type { HudIO } from './link-export.js';
import { planDelegatedDigest, runDelegatedDigest, showDelegatedDigest, type DigestOptions, type DigestRetention, type SavedDigestDocument } from '../core/materials/delegated-digest.js';
import { DigestFailure } from '../core/materials/source-config.js';

export const DIGEST_HELP = `Usage: hud digest plan --run RUN --report REPORT --json
       hud digest run --run RUN --report REPORT --expected-ledger LEDGER_ID --expected-recipient RECIPIENT_ID [--save] --json
       hud digest show --run RUN --report REPORT --expected-ledger LEDGER_ID --expected-recipient RECIPIENT_ID --json
       hud digest --help

Explicitly summarize one authenticated completed delegation report's public summary.
Plan reads metadata only. Run requires private per-source model.json scope and an independent outbound.json grant.
Run --save explicitly retains a private digest. Show revalidates the exact target and grants without a model call.
Retention failures do not mean generation failed. For uncertain save/output, use exact show, never automatically retry run.
No policy initialization, migration, reportPath reading, background work or process control.
A completed report and a generated digest do not prove run termination or task correctness.
`;
export type DigestArguments = { mode: 'help' } | { mode: 'plan'; runId: string; reportId: string } |
  { mode: 'run'; runId: string; reportId: string; expectedLedger: string; expectedRecipient: string; save?: true } |
  { mode: 'show'; runId: string; reportId: string; expectedLedger: string; expectedRecipient: string };
export function parseDigestArguments(args: readonly string[]): DigestArguments {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  const mode = args[0];
  if (mode !== 'plan' && mode !== 'run' && mode !== 'show') throw new DigestFailure('invalid_arguments', 2);
  const seen = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (!['--run', '--report', '--json', ...(mode !== 'plan' ? ['--expected-ledger', '--expected-recipient'] : []), ...(mode === 'run' ? ['--save'] : [])].includes(flag) || seen.has(flag))
      throw new DigestFailure('invalid_arguments', 2);
    const value = flag === '--json' || flag === '--save' ? 'true' : args[++i];
    if (value === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new DigestFailure('invalid_arguments', 2);
    if (flag === '--expected-recipient' && !/^[a-f0-9]{64}$/.test(value)) throw new DigestFailure('invalid_arguments', 2);
    seen.set(flag, value);
  }
  if (!seen.has('--run') || !seen.has('--report') || !seen.has('--json') ||
      (mode !== 'plan' && (!seen.has('--expected-ledger') || !seen.has('--expected-recipient'))))
    throw new DigestFailure('invalid_arguments', 2);
  const common = { runId: seen.get('--run')!, reportId: seen.get('--report')! };
  return mode === 'plan' ? { mode, ...common } : { mode, ...common,
    expectedLedger: seen.get('--expected-ledger')!, expectedRecipient: seen.get('--expected-recipient')!,
    ...(mode === 'run' && seen.has('--save') ? { save: true as const } : {}) };
}
export async function digestCommand(args: readonly string[], io: HudIO, options: DigestOptions = {}): Promise<number> {
  let abort: (() => void) | undefined;
  let detach: (() => void) | undefined;
  let retention: DigestRetention | undefined;
  let deliveringSaved = false;
  try {
    const parsed = parseDigestArguments(args);
    if (parsed.mode === 'help') { await io.stdout(DIGEST_HELP); return 0; }
    const home = privateHome(io.env);
    const input = { ...parsed, home, env: io.env };
    if (parsed.mode === 'plan') {
      const result = await planDelegatedDigest(input, options);
      await io.stdout(`${JSON.stringify(result)}\n`);
    } else if (parsed.mode === 'show') {
      await showDelegatedDigest({ ...input, expectedLedger: parsed.expectedLedger, expectedRecipient: parsed.expectedRecipient },
        options, (result) => io.stdout(`${JSON.stringify(result)}\n`));
    } else {
      const controller = new AbortController();
      abort = () => controller.abort();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      detach = () => options.signal?.removeEventListener('abort', abort!);
      await runDelegatedDigest({ ...input, expectedLedger: parsed.expectedLedger, expectedRecipient: parsed.expectedRecipient },
        { ...options, save: parsed.save === true, signal: controller.signal, onRetention: (receipt) => { retention = receipt; } },
        (result) => {
          if (!parsed.save) return io.stdout(`${JSON.stringify(result)}\n`);
          if (!retention) throw new Error('missing_retention');
          const saved: SavedDigestDocument = { format: 'hud-delegated-digest-save', schemaVersion: 1, document: result, retention };
          deliveringSaved = retention.state === 'saved' || (retention.state === 'not_saved' && retention.reason === 'digest_note_publish_uncertain');
          return io.stdout(`${JSON.stringify(saved)}\n`);
        });
    }
    return 0;
  } catch (error) {
    if (error instanceof DigestFailure || error instanceof CliError) {
      io.stderr(`${error.reason}\n`);
      return error.exitCode;
    }
    if (deliveringSaved) { io.stderr('digest_note_delivery_uncertain_use_show\n'); return 1; }
    io.stderr('internal_or_output_failure\n');
    return 1;
  } finally {
    if (abort) { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
    detach?.();
  }
}
