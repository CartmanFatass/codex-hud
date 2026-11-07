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

/** New path: direct native endpoint selection; no ledger record or delivery state. */
export function nativeParentWakeTarget(
  owner: import('../../../src/managed/relations.js').NativeOwner,
  physical: Registration,
  home: string,
  stamp: ProcessStamp | null,
  codexExecutable?: string
): import('../../../src/managed/host-wake.js').NativeWakeTarget {
  if (owner.harness === 'claude') return { adapter: 'claude_background_wait' };
  if (physical.source?.sourceId !== owner.sourceId) return { adapter: 'none', reason: 'native_source_mismatch' };
  if (owner.harness === 'codex' && codexExecutable)
    return {
      adapter: 'codex_queue',
      codexHome: physical.source.rootPath,
      threadId: owner.threadId ?? owner.sessionId,
      executable: codexExecutable,
    };
  if (owner.harness === 'pi' && stamp)
    return { adapter: 'pi_extension', socketPath: join(home, 'wake', `pi-${stamp.pid}-${stamp.proc_start}.sock`) };
  return { adapter: 'none', reason: 'verified_endpoint_unavailable' };
}
