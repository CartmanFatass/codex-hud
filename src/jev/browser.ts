// Ported from Jev Ultrafast browser.py (github.com/browser-use/jev-ultrafast @ 1231850a), MIT License, Copyright (c) 2026 Browser Use. Deviations: direct CDP instead of browser-harness; async calls; per-call timeout; open accepts a completed navigation away from about:blank. Page JavaScript below is copied verbatim.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpConnection } from './cdp.js';
import { pythonJson, type ObservedAction, type PageState } from './model.js';

export class StalePage extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StalePage';
  }
}

export const DEFAULT_CDP_TIMEOUT_MS = 60_000;

export interface BrowserRequest {
  operation: 'observe' | 'act';
  session: string;
  screenshot?: boolean;
  action?: ObservedAction;
  text?: string | null;
}

export type CdpInvoker = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

/** Adjacent compiled asset first, then the source tree, same walk as the Python bridge. */
export function locateJevSnapshot(moduleDirectory: string): string {
  const adjacent = join(moduleDirectory, 'snapshot.js');
  if (existsSync(adjacent)) return adjacent;
  let directory = moduleDirectory;
  for (;;) {
    const candidate = join(directory, 'src', 'jev', 'snapshot.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('jev_snapshot_asset_missing');
}

let snapshotSource: string | undefined;

export function readSnapshotSource(moduleDirectory = dirname(fileURLToPath(import.meta.url))): string {
  snapshotSource ??= readFileSync(locateJevSnapshot(moduleDirectory), 'utf8');
  return snapshotSource;
}

export function fingerprint(state: Pick<PageState, 'url' | 'text' | 'actions' | 'scroll'>): string {
  const content = { url: state.url, text: state.text, actions: state.actions, scroll: state.scroll };
  return createHash('sha256').update(pythonJson(content)).digest('hex');
}

function same(left: unknown, right: unknown): boolean {
  return pythonJson(left) === pythonJson(right);
}

const AFTER_INPUT = `(action => new Promise(resolve => {
  // Hidden pages suspend animation frames and throttle timers. The host's next
  // bounded DOM observation, not a renderer-side wait, establishes readiness.
  if (document.hidden) { resolve(); return; }
  const field=window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
      .split(/\\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))`;

const ACT_TARGET = `(action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  if (!e.contains(document.elementFromPoint(x,y))) return null;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
})`;

interface EvaluateResult {
  exceptionDetails?: unknown;
  result?: { value?: unknown };
}

/** One atomic browser read or one action. The injected invoker is the only CDP entry. */
export async function browserOperation(
  request: BrowserRequest,
  cdp: CdpInvoker
): Promise<PageState | { executed: string }> {
  const session = request.session;
  const call = (method: string, params: Record<string, unknown>) => cdp(method, { ...params, sessionId: session });
  const evaluate = async (expression: string, awaitPromise = false): Promise<unknown> => {
    const result = (await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    })) as EvaluateResult;
    if (result?.exceptionDetails) {
      if (request.operation === 'act' && request.action?.kind === 'select') {
        throw new Error('Dropdown execution was interrupted; inspect before retrying.');
      }
      throw new StalePage('Document changed during evaluation');
    }
    return result?.result?.value;
  };

  if (request.operation === 'act') {
    const action = request.action;
    if (!action) throw new Error('Missing action');
    const kind = action.kind;
    if (kind === 'scroll') {
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 550, y: 650, deltaX: 0, deltaY: action.delta });
    } else if (kind !== 'wait') {
      if (typeof action.node !== 'number') throw new Error('Invalid observed node');
      const target = (await evaluate(`${ACT_TARGET}(${pythonJson(action)})`)) as { x: number; y: number } | null;
      if (target == null) {
        if (kind === 'select') throw new Error('Dropdown execution was not confirmed; inspect before retrying.');
        throw new StalePage('Target changed or is covered. Observe again.');
      }
      if (kind !== 'select') {
        for (const type of ['mousePressed', 'mouseReleased'] as const) {
          await call('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 });
        }
        if (kind === 'fill') {
          const modifiers = process.platform === 'darwin' ? 4 : 2;
          await call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'a',
            code: 'KeyA',
            modifiers,
            commands: ['selectAll'],
          });
          await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers });
          await call('Input.insertText', { text: request.text ?? '' });
        }
      }
    }
    return { executed: action.id };
  }

  const source = readSnapshotSource();
  const info = (await evaluate(source)) as PageState | null;
  if (info == null) throw new StalePage('Document is navigating');
  info.fingerprint = fingerprint(info);
  if (request.screenshot !== false) {
    const shot = (await call('Page.captureScreenshot', { format: 'jpeg', quality: 72 })) as { data?: string };
    info.screenshot = shot.data;
  }
  return info;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Owned background tab on an already-running Chrome. close() closes only this target. */
export class Browser {
  /** Actual shared-Chrome startup/reuse mode, supplied by the runtime opener. */
  mode?: 'headless' | 'headed';
  private afterInput: ObservedAction | null = null;
  operate = browserOperation;

  private constructor(
    private readonly connection: CdpConnection,
    private targetId: string | null,
    private readonly sessionId: string,
    private readonly timeoutMs: number
  ) {}

  /** No Chrome attached. Offline tests replace fresh and operate before any CDP call. */
  static bare(): Browser {
    // SAFETY: offline tests replace all CDP-using methods; a bare browser owns no target.
    return new Browser(undefined as unknown as CdpConnection, null, '', DEFAULT_CDP_TIMEOUT_MS);
  }

  static async open(url: string, options: { cdpUrl?: string; timeoutMs?: number } = {}): Promise<Browser> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    const connection = await CdpConnection.connect(options.cdpUrl ?? 'http://127.0.0.1:9222', timeoutMs);
    let targetId: string | undefined;
    try {
      const created = (await connection.call('Target.createTarget', { url: 'about:blank', background: true })) as {
        targetId: string;
      };
      targetId = created.targetId;
      const attached = (await connection.call('Target.attachToTarget', { targetId, flatten: true })) as {
        sessionId: string;
      };
      const browser = new Browser(connection, targetId, attached.sessionId, timeoutMs);
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 1120,
        height: 780,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.call('Emulation.setFocusEmulationEnabled', { enabled: true });
      const navigated = (await browser.call('Page.navigate', { url })) as { errorText?: string };
      if (typeof navigated?.errorText === 'string' && navigated.errorText) throw new Error('cdp_navigate_failed');
      // about:blank is already complete. A normalised or redirected URL is ready once it has left about:blank.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const ready = await browser.evaluate(
            "document.readyState === 'complete' && location.href !== 'about:blank'",
            false,
            2_000
          );
          if (ready === true) break;
        } catch {
          // The document can be mid-navigation on the first polls.
        }
        await sleep(20);
      }
      return browser;
    } catch (error) {
      if (targetId) await connection.call('Target.closeTarget', { targetId }).catch(() => undefined);
      connection.close();
      throw error;
    }
  }

  /** Read-only recovery attaches to the existing send tab, without navigating it. */
  static async attach(targetId: string, options: { cdpUrl?: string; timeoutMs?: number } = {}): Promise<Browser> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    const connection = await CdpConnection.connect(options.cdpUrl ?? 'http://127.0.0.1:9222', timeoutMs);
    try {
      const attached = (await connection.call('Target.attachToTarget', { targetId, flatten: true })) as {
        sessionId: string;
      };
      return new Browser(connection, targetId, attached.sessionId, timeoutMs);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  static async targets(
    options: { cdpUrl?: string; timeoutMs?: number } = {}
  ): Promise<Array<{ targetId: string; url: string }>> {
    const connection = await CdpConnection.connect(
      options.cdpUrl ?? 'http://127.0.0.1:9222',
      options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS
    );
    try {
      const result = (await connection.call('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; url: string; type: string }>;
      };
      return result.targetInfos.filter((target) => target.type === 'page');
    } finally {
      connection.close();
    }
  }

  get id(): string | null {
    return this.targetId;
  }

  /** End this CDP observation only. An attempted send tab must survive an abort. */
  async detach(): Promise<void> {
    this.targetId = null;
    this.connection.close();
  }

  /** Code-owned keyboard/upload operations outside Jev's action space. */
  command(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<unknown> {
    return this.call(method, params, timeoutMs);
  }

  private call(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<unknown> {
    return this.connection.call(method, params, { sessionId: this.sessionId, timeoutMs });
  }

  private invoker(): CdpInvoker {
    return (method, params) => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : this.sessionId;
      const rest = { ...params };
      delete rest.sessionId;
      return this.connection.call(method, rest, { sessionId, timeoutMs: this.timeoutMs });
    };
  }

  async evaluate(expression: string, awaitPromise = false, timeoutMs = this.timeoutMs): Promise<unknown> {
    const result = (await this.call(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise,
      },
      timeoutMs
    )) as EvaluateResult;
    if (result?.exceptionDetails) throw new StalePage('Document changed during evaluation');
    return result?.result?.value;
  }

  async observe(screenshot = true): Promise<PageState> {
    if (this.afterInput) {
      const action = this.afterInput;
      this.afterInput = null;
      try {
        await this.call('Runtime.evaluate', {
          expression: `${AFTER_INPUT}(${pythonJson(action)})`,
          awaitPromise: true,
          returnByValue: true,
        });
      } catch {
        // Read-only, and execution was already logged. Navigation may interrupt the wait.
      }
    }
    let last: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return (await this.operate(
          { operation: 'observe', session: this.sessionId, screenshot },
          this.invoker()
        )) as PageState;
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
        last = error;
        if (attempt === 9) throw error;
        await sleep(20);
      }
    }
    throw last instanceof Error ? last : new StalePage('Page did not settle');
  }

  async fresh(page: PageState, action?: ObservedAction | null): Promise<boolean> {
    if (action != null && (action.kind === 'click' || action.kind === 'select')) {
      if (typeof action.node !== 'number') return false;
      const current = await this.evaluate(
        `(() => { const c=window.__jevFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${action.node}))] : null; })()`
      );
      return same(current, [page.page_key, page.guards?.[String(action.node)]]);
    }
    const source = readSnapshotSource();
    const marker = await this.evaluate(`(() => { const state=${source}; return state?.marker ?? null; })()`);
    return same(marker, page.marker);
  }

  async act(action: ObservedAction, page: PageState, text?: string | null): Promise<{ executed: string }> {
    if (!(await this.fresh(page, action))) throw new StalePage('Page changed since this decision. Observe again.');
    if (action.kind === 'wait') await sleep(100);
    const result = (await this.operate(
      { operation: 'act', session: this.sessionId, action, text },
      this.invoker()
    )) as { executed: string };
    this.afterInput = action.kind === 'wait' ? null : action;
    return result;
  }

  async close(): Promise<void> {
    if (!this.targetId) return;
    const targetId = this.targetId;
    this.targetId = null;
    try {
      await this.connection.call('Target.closeTarget', { targetId }, { timeoutMs: this.timeoutMs });
    } finally {
      this.connection.close();
    }
  }
}
