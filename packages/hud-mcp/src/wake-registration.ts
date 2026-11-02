import { join } from 'node:path';
import type { WakeRegistration } from '../../../src/ledger/notify-events.js';
import type { ProcessStamp } from '../../../src/core/types/supervision.js';
import type { CallerContext } from '../../../src/core/types/identity.js';
import { sessionOwnerKey } from '../../../src/core/identity.js';
import type { Registration } from './registry.js';

/** Facts are supplied by the identity composition, never by tool arguments or a hint. */
export function parentWakeRegistration(
  context: CallerContext,
  physical: Registration,
  home: string,
  stamp: ProcessStamp | null,
  codexExecutable?: string
): WakeRegistration {
  if (!context.sessionRef) throw new Error('identity_unverified');
  const common = {
    adapterVersion: 1 as const,
    ownerKey: sessionOwnerKey(context.sessionRef),
    contextGeneration: context.generation,
    parentRef: context.sessionRef,
    parentStamp: stamp,
  };
  if (context.harness === 'claude') return { ...common, adapter: 'claude_background_wait_v1', target: {} };
  if (context.harness === 'codex' && physical.source?.sourceId === context.sourceId && codexExecutable && stamp)
    return {
      ...common,
      adapter: 'codex_queue_v1',
      target: {
        codexHome: physical.source.rootPath,
        threadId: context.sessionRef.threadId ?? context.sessionRef.sessionId,
      },
    };
  if (context.harness === 'pi' && physical.source?.sourceId === context.sourceId && stamp)
    return {
      ...common,
      adapter: 'pi_extension_v1',
      target: { socketPath: join(home, 'wake', `pi-${stamp.pid}-${stamp.proc_start}.sock`) },
    };
  return { ...common, adapter: 'none', target: {}, reason: 'verified_endpoint_unavailable' };
}
