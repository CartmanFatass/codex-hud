// Host-clock deadlines for read-only oracle CDP. A hidden renderer may never
// answer; neither a page timer nor the transport's longer default is a bound.
import { JevFailure } from '../ask/error.js';
import type { OracleBrowser } from './chatgpt.js';

export const ORACLE_READ_TIMEOUT_MS = 10_000;

export function browserTimeout(error: unknown): boolean {
  return error instanceof JevFailure && error.code === 'browser_timeout';
}

export async function oracleRead<T>(
  method: string,
  read: () => T | Promise<T>,
  signal?: AbortSignal,
  timeoutMs = ORACLE_READ_TIMEOUT_MS
): Promise<T> {
  signal?.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return read();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JevFailure('browser_timeout', 'browser_timeout', { method })), timeoutMs);
        abort = () => reject(signal?.reason ?? new Error('aborted'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } catch (error) {
    if ((error as Error)?.name === 'CdpTimeoutError')
      throw new JevFailure('browser_timeout', 'browser_timeout', { method });
    if (error instanceof Error) Object.assign(error, { cdpMethod: method });
    throw error;
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/** All oracle reads, including snapshot observation, have an independent bound.
 * Never wrap act(): a read deadline must not create an ambiguous second action. */
export function boundedOracleBrowser(
  browser: OracleBrowser,
  signal: () => AbortSignal | undefined,
  timeoutMs = ORACLE_READ_TIMEOUT_MS
): OracleBrowser {
  return {
    get id() {
      return browser.id;
    },
    get mode() {
      return browser.mode;
    },
    evaluate: (expression, awaitPromise = false, ms = timeoutMs) =>
      oracleRead(
        'Runtime.evaluate',
        () => browser.evaluate(expression, awaitPromise, Math.min(ms, timeoutMs)),
        signal(),
        Math.min(ms, timeoutMs)
      ),
    command: (method, params, ms = timeoutMs) =>
      oracleRead(
        method,
        () => browser.command(method, params, Math.min(ms, timeoutMs)),
        signal(),
        Math.min(ms, timeoutMs)
      ),
    observe: (screenshot) => oracleRead('Runtime.evaluate', () => browser.observe(screenshot), signal(), timeoutMs),
    fresh: (page, action) => oracleRead('Runtime.evaluate', () => browser.fresh(page, action), signal(), timeoutMs),
    act: (action, page, text) => browser.act(action, page, text),
    // Cleanup must also be bounded, even after the job signal has aborted.
    close: () => oracleRead('Target.closeTarget', () => browser.close(), undefined, timeoutMs),
    detach: () => oracleRead('Target.detachFromTarget', () => browser.detach(), undefined, timeoutMs),
  };
}
