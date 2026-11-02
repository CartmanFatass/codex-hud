import { object, type HerdrTransport, type ObjectValue } from './transport.js';

export const HERDR_VERSION = '0.9.5';
export const HERDR_PROTOCOL = 22;
export const HERDR_SCHEMA = 1;
export type HerdrDiagnostic =
  'herdr_disabled' | 'herdr_unavailable' | 'herdr_schema_mismatch' | 'herdr_instance_changed';
export class HerdrFailure extends Error {
  constructor(
    readonly code: string,
    readonly fallbackAllowed = false
  ) {
    super(code);
  }
}
export interface Preflight {
  ready: boolean;
  server: string | null;
  diagnostic: HerdrDiagnostic | null;
  /** True only before any dispatch. Selection must still freeze the final profile/digest. */
  fallbackAllowed: boolean;
}

/** Share one client per socket/composition: one single-flight 3s read cache, no timers. */
export class HerdrClient {
  readonly enabled: boolean;
  private cached?: { at: number; result: Preflight };
  private pending?: Promise<Preflight>;
  constructor(
    readonly transport: HerdrTransport,
    env: NodeJS.ProcessEnv = process.env,
    readonly diagnostic: (code: HerdrDiagnostic) => void = () => {},
    private readonly now = Date.now
  ) {
    this.enabled = env.HERDR_ENV === '1' && env.HUD_HERDR !== '0';
  }
  async preflight(): Promise<Preflight> {
    if (!this.enabled) return this.result(false, null, 'herdr_disabled');
    if (this.cached && this.now() - this.cached.at >= 0 && this.now() - this.cached.at < 3000)
      return this.cached.result;
    if (this.pending) return this.pending;
    this.pending = this.inspect().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private result(ready: boolean, server: string | null, diagnostic: HerdrDiagnostic | null): Preflight {
    if (diagnostic) this.diagnostic(diagnostic);
    return { ready, server, diagnostic, fallbackAllowed: !ready };
  }
  private async inspect(): Promise<Preflight> {
    let result: Preflight;
    try {
      const schema = object(await this.transport.command(['api', 'schema', '--json']));
      const methods = object(object(schema.schemas).request).oneOf;
      const names = new Set(
        Array.isArray(methods)
          ? methods.map((entry) => {
              try {
                return object(object(object(entry).properties).method).const;
              } catch {
                return null;
              }
            })
          : []
      );
      if (
        ![
          'ping',
          'session.snapshot',
          'pane.get',
          'pane.process_info',
          'pane.layout',
          'tab.create',
          'pane.split',
          'agent.prompt',
        ].every((name) => names.has(name))
      ) {
        const mismatch = this.result(false, null, 'herdr_schema_mismatch');
        this.cached = { at: this.now(), result: mismatch };
        return mismatch;
      }
      const version = await this.transport.command(['--version']);
      const before = await this.transport.instance();
      const ping = await this.transport.request('ping', {});
      const after = await this.transport.instance();
      if (
        schema.schema_version !== HERDR_SCHEMA ||
        schema.protocol !== HERDR_PROTOCOL ||
        version !== `herdr ${HERDR_VERSION}` ||
        ping.version !== HERDR_VERSION ||
        ping.protocol !== HERDR_PROTOCOL
      )
        result = this.result(false, null, 'herdr_schema_mismatch');
      else if (!before || before !== after) result = this.result(false, null, 'herdr_unavailable');
      else result = this.result(true, before, null);
    } catch {
      result = this.result(false, null, 'herdr_unavailable');
    }
    this.cached = { at: this.now(), result };
    return result;
  }
  async require(server?: string): Promise<string> {
    const preflight = await this.preflight();
    if (!preflight.ready || !preflight.server) throw new HerdrFailure(preflight.diagnostic ?? 'herdr_unavailable');
    const current = await this.transport.instance();
    if (current !== preflight.server || (server !== undefined && current !== server)) {
      this.invalidate('herdr_instance_changed');
      throw new HerdrFailure('herdr_instance_changed');
    }
    return current;
  }
  invalidate(code: HerdrDiagnostic = 'herdr_unavailable'): void {
    this.cached = undefined;
    this.diagnostic(code);
  }
  async read(method: string, params: ObjectValue, server?: string): Promise<ObjectValue> {
    const instance = await this.require(server);
    try {
      const result = await this.transport.request(method, params);
      if ((await this.transport.instance()) !== instance) throw new Error('instance_changed');
      return result;
    } catch {
      this.invalidate();
      throw new HerdrFailure('herdr_observation_unavailable');
    }
  }
}
