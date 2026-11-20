import { spawn } from 'node:child_process';
import { delimiter, isAbsolute } from 'node:path';
import { proxyObject, proxyTime, proxyWindows, type ExpProxyError, type ExpProxyWindows } from '../exp-proxy.js';

export type ProxyRpcResult = { windows: ExpProxyWindows } | { error: ExpProxyError; retryAtMs?: number };

function retryAt(value: unknown, now: number): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const text = String(value).trim();
  const at = /^\d+$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  if (proxyTime(at) && at >= now) return at;
}

function rpcError(value: unknown, now: number): ProxyRpcResult {
  const error = proxyObject(value);
  const data = proxyObject(error?.data);
  const headers = proxyObject(data?.headers);
  const header = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  const message = typeof error?.message === 'string' ? error.message : '';
  const status = data?.status ?? data?.statusCode ?? error?.code;
  if (
    status === 401 ||
    /^(?:codex account|chatgpt) authentication required to read rate limits$|\bfailed: 401\b/i.test(message)
  )
    return { error: 'not_logged_in' };
  const retryAtMs = retryAt(header ?? data?.retryAfter ?? data?.['retry-after'], now);
  return {
    error: status === 429 || /\bfailed: 429\b/.test(message) ? 'rate_limited' : 'request_failed',
    retryAtMs,
  };
}

/** Official app-server stdio only. Never sends a thread, a login request or a prompt. */
export function readCodexProxy(
  profile: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  now: () => number
): Promise<ProxyRpcResult> {
  if (signal.aborted) return Promise.resolve({ error: 'timeout' });
  const childEnv: NodeJS.ProcessEnv = { ...env, CODEX_HOME: profile };
  // The selected profile owns authentication; do not prefer ambient credential overrides.
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete childEnv[key];
  childEnv.PATH = (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter).filter(isAbsolute).join(delimiter);
  if (!childEnv.PATH) return Promise.resolve({ error: 'unavailable' });
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: '/',
      env: childEnv,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let result: ProxyRpcResult | undefined;
    let buffered = '';
    let initialized = false;
    const finish = (answer: ProxyRpcResult) => {
      if (result) return;
      result = answer;
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill('SIGKILL');
    };
    const timeout = () => finish({ error: 'timeout' });
    signal.addEventListener('abort', timeout, { once: true });
    child.once('error', () => finish({ error: 'unavailable' }));
    child.stdin.on('error', () => finish({ error: 'unavailable' }));
    child.stdout.on('error', () => finish({ error: 'unavailable' }));
    child.once('close', () => {
      signal.removeEventListener('abort', timeout);
      resolve(result ?? { error: 'unavailable' });
    });
    const send = (...messages: object[]) =>
      child.stdin.write(messages.map((msg) => JSON.stringify(msg) + '\n').join(''));
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.length > 256 * 1024) return finish({ error: 'invalid_response' });
      let newline: number;
      while (!result && (newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown> | undefined;
        try {
          msg = proxyObject(JSON.parse(line));
        } catch {
          return finish({ error: 'invalid_response' });
        }
        // Initial workspace routing has a distinct reason; an explicit account change invalidates this read.
        if (msg?.method === 'account/updated' && proxyObject(msg.params)?.reason === null)
          return finish({ error: 'binding_changed' });
        if (!initialized && msg?.id === 1) {
          if (!proxyObject(msg.result)) return finish(rpcError(msg.error, now()));
          initialized = true;
          send(
            { method: 'initialized' },
            { id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } }
          );
        } else if (initialized && msg?.id === 2) {
          if (msg.error) return finish(rpcError(msg.error, now()));
          const response = proxyObject(msg.result);
          const fallback = proxyObject(response?.rateLimits);
          const bucket =
            proxyObject(response?.rateLimitsByLimitId)?.codex ??
            (fallback?.limitId == null || fallback.limitId === 'codex' ? fallback : undefined);
          const windows = proxyWindows(bucket);
          return finish(windows.primary || windows.secondary ? { windows } : { error: 'invalid_response' });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'myhud-exp', version: '1' } } });
  });
}
