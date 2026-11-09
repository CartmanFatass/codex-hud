import { privateHome, CliError } from './runtime.js';
import type { HudIO } from './link-export.js';
import { planDelegatedDigest, runDelegatedDigest, type DigestOptions } from '../core/materials/delegated-digest.js';
import { DigestFailure } from '../core/materials/source-config.js';

export const DIGEST_HELP = `Usage: hud digest plan --run RUN --report REPORT --json
       hud digest run --run RUN --report REPORT --expected-ledger LEDGER_ID --expected-recipient RECIPIENT_ID --json
       hud digest --help

Explicitly summarize one authenticated completed delegation report's public summary.
Plan reads metadata only. Run requires private per-source model.json scope and an independent outbound.json grant.
No initialization, migration, reportPath reading, background work or process control.
A completed report and a generated digest do not prove run termination or task correctness.
`;
export type DigestArguments =
  | { mode: 'help' }
  | { mode: 'plan'; runId: string; reportId: string }
  | { mode: 'run'; runId: string; reportId: string; expectedLedger: string; expectedRecipient: string };
export function parseDigestArguments(args: readonly string[]): DigestArguments {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  const mode = args[0];
  if (mode !== 'plan' && mode !== 'run') throw new DigestFailure('invalid_arguments', 2);
  const seen = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (
      ![
        '--run',
        '--report',
        '--json',
        ...(mode === 'run' ? ['--expected-ledger', '--expected-recipient'] : []),
      ].includes(flag) ||
      seen.has(flag)
    )
      throw new DigestFailure('invalid_arguments', 2);
    const value = flag === '--json' ? 'true' : args[++i];
    if (value === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new DigestFailure('invalid_arguments', 2);
    if (flag === '--expected-recipient' && !/^[a-f0-9]{64}$/.test(value))
      throw new DigestFailure('invalid_arguments', 2);
    seen.set(flag, value);
  }
  if (
    !seen.has('--run') ||
    !seen.has('--report') ||
    !seen.has('--json') ||
    (mode === 'run' && (!seen.has('--expected-ledger') || !seen.has('--expected-recipient')))
  )
    throw new DigestFailure('invalid_arguments', 2);
  const common = { runId: seen.get('--run')!, reportId: seen.get('--report')! };
  return mode === 'plan'
    ? { mode, ...common }
    : {
        mode,
        ...common,
        expectedLedger: seen.get('--expected-ledger')!,
        expectedRecipient: seen.get('--expected-recipient')!,
      };
}
export async function digestCommand(args: readonly string[], io: HudIO, options: DigestOptions = {}): Promise<number> {
  let abort: (() => void) | undefined;
  let detach: (() => void) | undefined;
  try {
    const parsed = parseDigestArguments(args);
    if (parsed.mode === 'help') {
      await io.stdout(DIGEST_HELP);
      return 0;
    }
    const home = privateHome(io.env);
    const input = { ...parsed, home, env: io.env };
    if (parsed.mode === 'plan') {
      const result = await planDelegatedDigest(input, options);
      await io.stdout(`${JSON.stringify(result)}\n`);
    } else {
      const controller = new AbortController();
      abort = () => controller.abort();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      detach = () => options.signal?.removeEventListener('abort', abort!);
      await runDelegatedDigest(
        { ...input, expectedLedger: parsed.expectedLedger, expectedRecipient: parsed.expectedRecipient },
        { ...options, signal: controller.signal },
        (result) => io.stdout(`${JSON.stringify(result)}\n`)
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof DigestFailure || error instanceof CliError) {
      io.stderr(`${error.reason}\n`);
      return error.exitCode;
    }
    io.stderr('internal_or_output_failure\n');
    return 1;
  } finally {
    if (abort) {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    }
    detach?.();
  }
}
