import { parentPort, workerData } from 'node:worker_threads';
import { HudDelegationCollector } from '../../collectors/delegation.js';

const port = parentPort;
if (!port) throw new Error('publication_worker_requires_parent');
const startup = workerData as { home: string; ambientHome?: string };
let runtime: HudDelegationCollector | null = null;
let currentScope: string | null | undefined;
let active = false;
let closing = false;
let closed = false;

const initialized = HudDelegationCollector.open({ HUD_HOME: startup.home }, startup.ambientHome, {
  publish: true,
  boundedWorker: true,
});

async function closeWorker(): Promise<void> {
  if (closed || active) return;
  closed = true;
  let clean = false;
  try {
    runtime ??= await initialized;
    clean = runtime?.close() ?? false;
  } catch {
    clean = false;
  }
  port!.postMessage({ type: 'closed', clean });
  port!.close();
}

async function collect(scope: string | null): Promise<void> {
  if (active || closing || closed) return;
  active = true;
  let changed = false;
  let error: string | null = null;
  try {
    runtime ??= await initialized;
    if (!runtime) throw new Error('observation_worker_unavailable');
    if (currentScope !== undefined && currentScope !== scope) {
      // A captured but uncommitted result cannot be discarded on a scope change.
      if (runtime.hasPendingPublication()) throw new Error('observation_scope_pending');
      if (!runtime.close()) throw new Error('observation_release_unconfirmed');
      runtime = await HudDelegationCollector.open({ HUD_HOME: startup.home }, startup.ambientHome, {
        publish: true,
        boundedWorker: true,
      });
      if (!runtime) throw new Error('observation_worker_unavailable');
    }
    currentScope = scope;
    const view = await runtime.tick(scope ?? undefined, undefined, 4 * 1024 * 1024);
    await runtime.afterPaint(() => {});
    const publication = runtime.publicationStats();
    changed = publication.changed;
    error =
      publication.error ??
      runtime.workerBlock() ??
      (view?.tree.ledger.state === 'available' ? null : 'observation_ledger_unavailable');
  } catch (caught) {
    runtime?.abandonCollection();
    error = caught instanceof Error ? caught.message : 'observation_worker_unavailable';
  } finally {
    active = false;
    port!.postMessage({ type: 'settled', scope, changed, error });
    if (closing) await closeWorker();
  }
}

port.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const input = message as { type?: unknown; scope?: unknown };
  if (input.type === 'close') {
    closing = true;
    void closeWorker();
  } else if (input.type === 'collect' && (input.scope === null || typeof input.scope === 'string')) {
    void collect(input.scope);
  }
});
void initialized.then(
  () => port.postMessage({ type: 'ready' }),
  () => port.postMessage({ type: 'failed' })
);
