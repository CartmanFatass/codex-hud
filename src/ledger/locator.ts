import { canonicalJson } from '../core/canonical.js';
import { isRunTerminal } from '../core/execution.js';
import type { HostLocator } from '../core/types/capabilities.js';
import type { ProcessStamp } from '../core/types/supervision.js';
import type { Ledger } from './ledger.js';
import { LedgerBusyError } from './transaction.js';
import { requireRunWriter } from './run-facts.js';

function validStamp(value: ProcessStamp | null): boolean {
  return (
    value === null ||
    (typeof value === 'object' &&
      value !== null &&
      Object.keys(value).length === 4 &&
      Object.keys(value).every((key) => ['pid', 'proc_start', 'boot_id', 'pid_domain'].includes(key)) &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      ['proc_start', 'boot_id', 'pid_domain'].every(
        (key) =>
          typeof value[key as keyof ProcessStamp] === 'string' &&
          value[key as keyof ProcessStamp] !== '' &&
          !String(value[key as keyof ProcessStamp]).includes('\0')
      ))
  );
}
/** H08 narrow trusted-writer port. Caller verifies the host outside the short transaction.
 * No model-facing locator setter, environment persistence, new event kind or implicit launch.
 */
export async function recordRunLocator(
  ledger: Ledger,
  runId: string,
  producer: ProcessStamp,
  locator: HostLocator
): Promise<void> {
  const copy = JSON.parse(canonicalJson(locator)) as HostLocator;
  const keys =
    copy.kind === 'herdr'
      ? ['kind', 'server', 'workspace', 'tab', 'pane', 'process', 'runId', 'bindingGeneration']
      : ['kind', 'server', 'session', 'pane', 'process', 'runId', 'bindingGeneration'];
  if (
    !['herdr', 'tmux'].includes(copy.kind) ||
    Object.keys(copy).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(copy, key)) ||
    copy.runId !== runId ||
    !Number.isSafeInteger(copy.bindingGeneration) ||
    copy.bindingGeneration < 1 ||
    !validStamp(copy.process) ||
    keys
      .filter((key) => !['process', 'bindingGeneration'].includes(key))
      .some(
        (key) =>
          typeof (copy as unknown as Record<string, unknown>)[key] !== 'string' ||
          !(copy as unknown as Record<string, unknown>)[key] ||
          String((copy as unknown as Record<string, unknown>)[key]).includes('\0')
      )
  )
    throw new Error('locator_invalid');
  const encoded = canonicalJson(copy);
  if (Buffer.byteLength(encoded) > 16 * 1024) throw new Error('locator_invalid');
  const writer = { ...producer };
  // Ledger's acquisition deadline covers connection queueing and <=20ms cumulative locks;
  // no probes/fs/network/await inside this transaction. Committed success is never changed to busy.
  const started = performance.now();
  await ledger.transaction((tx) => {
    if (performance.now() - started >= 30) throw new LedgerBusyError();
    const run = requireRunWriter(tx, runId, writer);
    const latest = tx.get('SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1', run.linkId);
    if (
      run.expectedGeneration !== copy.bindingGeneration ||
      isRunTerminal(run) ||
      latest?.run_id !== runId ||
      !tx.get('SELECT 1 FROM slots WHERE run_id=?', runId)
    )
      throw new Error('stale_run');
    if (run.locator !== null) {
      if (canonicalJson(run.locator) !== encoded) throw new Error('locator_conflict');
      return;
    }
    tx.run('UPDATE runs SET locator=? WHERE run_id=? AND locator IS NULL', encoded, runId);
    if (performance.now() - started >= 30) throw new LedgerBusyError();
  }, 20);
}
