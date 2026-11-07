import { isAbsolute } from 'node:path';
import {
  AdapterDispatchError,
  type AdapterCallbacks,
  type ManagedAdapterFactory,
  type NativeRef,
} from '../../managed/types.js';
import {
  NativePiRpcClient,
  PiRpcError,
  type PiRpcClient,
  type PiRpcOptions,
  type PiRpcRecord,
} from './native-rpc-transport.js';

export type { PiRpcClient, PiRpcOptions } from './native-rpc-transport.js';
export type PiRpcClientFactory = (options: PiRpcOptions) => PiRpcClient | Promise<PiRpcClient>;
export interface PiAdapterOptions extends PiRpcOptions {
  /** Optional trusted host storage. Omit to keep the installed Pi's normal session location. */
  sessionDirectory?: string;
  rpcClientFactory?: PiRpcClientFactory;
}
export const createOfficialPiRpcClient: PiRpcClientFactory = (options) => new NativePiRpcClient(options);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const data = (record: PiRpcRecord): Record<string, unknown> => (object(record.data) ? record.data : {});

/** One installed Pi, one persistent public RPC connection. No HUD turn-status inference. */
export function createPiAdapterFactory(options: PiAdapterOptions = {}): ManagedAdapterFactory {
  if (options.sessionDirectory !== undefined && !isAbsolute(options.sessionDirectory)) {
    throw new AdapterDispatchError('pi_session_directory_required', 'not_sent');
  }
  if (
    options.commandTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.commandTimeoutMs) ||
      options.commandTimeoutMs < 1 ||
      options.commandTimeoutMs > 2_147_483_647)
  ) {
    throw new AdapterDispatchError('pi_invalid_command_timeout', 'not_sent');
  }
  const launchArgs = [...(options.args ?? [])];
  if (options.sessionDirectory) launchArgs.push('--session-dir', options.sessionDirectory);
  return {
    harness: 'pi',
    async create(request, callbacks: AdapterCallbacks) {
      if (!isAbsolute(request.workspace)) throw new AdapterDispatchError('pi_workspace_required', 'not_sent');
      const source = request.origin.kind === 'new' ? undefined : request.origin.source;
      if (
        source &&
        (source.harness !== 'pi' || !source.sessionId || !source.sessionFile || !isAbsolute(source.sessionFile))
      ) {
        throw new AdapterDispatchError('pi_exact_session_file_required', 'not_sent');
      }
      const env = { ...process.env, ...options.env };
      // Remove inherited parent identity only. User HUD settings and native discovery remain intact.
      for (const key of [
        'HUD_CLAIM',
        'HUD_LINK',
        'HUD_RUN',
        'HUD_CONTEXT',
        'HUD_NATIVE_SOURCE',
        'HUD_NATIVE_SOURCE_FILE',
        'HUD_OWNER_ID',
        'HUD_PI_DELEGATION_FD',
        'PI_SESSION_ID',
        'PI_SESSION_FILE',
      ])
        delete env[key];
      const client = await (options.rpcClientFactory ?? createOfficialPiRpcClient)({
        cliPath: options.cliPath,
        cwd: request.workspace,
        args: [...launchArgs],
        provider: options.provider,
        model: options.model,
        env,
        commandTimeoutMs: options.commandTimeoutMs,
      });
      let nativeRef: NativeRef | null = null;
      let state: unknown;
      let closed = false;
      let disconnected = false;
      const requests = new Set<AbortController>();
      const retireRequests = () => {
        for (const controller of requests) controller.abort();
        requests.clear();
      };
      const unsubscribe = client.onEvent((event) => {
        if (event.type === 'disconnected') {
          disconnected = true;
          retireRequests();
          callbacks.event(event);
        } else if (event.type === 'process_exit') {
          callbacks.event(event);
        } else {
          const record = event.record;
          if (
            record.type === 'extension_ui_request' &&
            typeof record.id === 'string' &&
            ['select', 'confirm', 'input', 'editor'].includes(String(record.method))
          ) {
            const controller = new AbortController();
            requests.add(controller);
            // Pi starts this timeout before emitting the request. Expiring our observation
            // after the same duration is an upper bound, not a new timeout policy or a
            // native cancellation. Pi alone chooses its timeout/default result.
            let nativeTimeout: ReturnType<typeof setTimeout> | undefined;
            const clearNativeTimeout = () => clearTimeout(nativeTimeout);
            if (typeof record.timeout === 'number' && Number.isFinite(record.timeout) && record.timeout !== 0) {
              nativeTimeout = setTimeout(() => {
                requests.delete(controller);
                controller.abort(new Error('pi_native_ui_timeout'));
                callbacks.event({
                  type: 'native_event',
                  kind: 'pi.extension_ui_expired',
                  payload: { requestId: record.id, timeout: record.timeout, source: 'native_request_timeout' },
                });
              }, record.timeout);
              nativeTimeout.unref?.();
              controller.signal.addEventListener('abort', clearNativeTimeout, { once: true });
            }
            void callbacks
              .request({
                requestId: record.id,
                kind: 'pi.extension_ui_request',
                payload: record,
                signal: controller.signal,
              })
              .then(async (response) => {
                if (controller.signal.aborted) return;
                if (!object(response.result)) throw new Error('pi_ui_response_object_required');
                // Envelope identity is always taken from Pi, never from the answer payload.
                await client.respond(record.id as string, response.result);
                // This subprotocol has no native ACK. A successful pipe write proves
                // neither that Pi still had the dialog nor that it consumed the answer.
                callbacks.event({
                  type: 'native_event',
                  kind: 'pi.extension_ui_response_sent',
                  payload: { requestId: record.id, wireSent: true, nativeAcknowledged: false },
                });
              })
              .catch((error: unknown) => {
                if (!controller.signal.aborted)
                  callbacks.event({
                    type: 'native_event',
                    kind: 'pi.ui_response_error',
                    payload: { requestId: record.id, error: String(error) },
                  });
              })
              .finally(() => {
                clearNativeTimeout();
                controller.signal.removeEventListener('abort', clearNativeTimeout);
                requests.delete(controller);
              });
            return;
          }
          callbacks.event({
            type: record.type === 'agent_settled' ? 'native_result' : 'native_event',
            kind: `pi.${record.type}`,
            payload: record,
          });
        }
      });
      const readState = async () => {
        const response = await client.request('get_state');
        if (response.success === false) throw new PiRpcError(String(response.error), response);
        state = data(response);
        return data(response);
      };
      try {
        await client.start();
        let current = await readState();
        if (source?.harness === 'pi') {
          const switched = await client.request('switch_session', { sessionPath: source.sessionFile });
          if (switched.success === false) throw new PiRpcError(String(switched.error), switched);
          if (data(switched).cancelled) throw new AdapterDispatchError('pi_session_switch_cancelled', 'not_sent');
          current = await readState();
          if (current.sessionId !== source.sessionId)
            throw new AdapterDispatchError('pi_session_identity_mismatch', 'not_sent');
          if (request.origin.kind === 'fork') {
            const cloned = await client.request('clone');
            if (cloned.success === false) throw new PiRpcError(String(cloned.error), cloned);
            if (data(cloned).cancelled) throw new AdapterDispatchError('pi_session_fork_cancelled', 'not_sent');
            current = await readState();
            if (current.sessionId === source.sessionId)
              throw new AdapterDispatchError('pi_fork_identity_unchanged', 'not_sent');
          }
        }
        if (typeof current.sessionId !== 'string' || !current.sessionId)
          throw new AdapterDispatchError('pi_session_id_missing', 'not_sent');
        nativeRef = {
          harness: 'pi',
          sessionId: current.sessionId,
          ...(typeof current.sessionFile === 'string' ? { sessionFile: current.sessionFile } : {}),
        };
        callbacks.event({ type: 'binding', nativeRef });
        callbacks.event({ type: 'ready', payload: current });
      } catch (error) {
        retireRequests();
        // No input was submitted. Release our startup connection only, not a process group.
        await client.close().catch(() => undefined);
        unsubscribe();
        throw error;
      }
      return {
        snapshot: () => ({ nativeRef, state, disconnected, closed }),
        async send({ text, options: input = {} }) {
          if (closed || disconnected) throw new AdapterDispatchError('pi_connection_unavailable', 'not_sent');
          const method = input.method ?? 'prompt';
          if (!['prompt', 'steer', 'follow_up'].includes(String(method)))
            throw new AdapterDispatchError('pi_invalid_input_method', 'not_sent');
          if (input.streamingBehavior !== undefined && !['steer', 'followUp'].includes(String(input.streamingBehavior)))
            throw new AdapterDispatchError('pi_invalid_streaming_behavior', 'not_sent');
          const fields: Record<string, unknown> = { message: text };
          if (input.images !== undefined) fields.images = input.images;
          if (input.streamingBehavior !== undefined && method === 'prompt')
            fields.streamingBehavior = input.streamingBehavior;
          return { payload: await client.request(String(method), fields) };
        },
        async read(input = {}) {
          const method = input.method ?? 'get_state';
          if (method === 'get_state') {
            const response = await client.request('get_state');
            state = data(response);
            return response;
          }
          if (method === 'get_entries')
            return client.request('get_entries', input.since === undefined ? {} : { since: input.since });
          throw new AdapterDispatchError('pi_invalid_read_method', 'not_sent');
        },
        cancel: async () => client.request('abort'),
        async close() {
          closed = true;
          retireRequests();
          return client.close();
        },
      };
    },
  };
}
