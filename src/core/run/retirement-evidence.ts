import { openObservationStore, type ObservationStore } from '../observation-store.js';
import { projectFreshness, selectCurrentObservation } from '../observation.js';
import type { RunSnapshot } from './port.js';
import type { Quiescence } from './retirement.js';

/** Read-only B16 consumer. The current projection has no typed positive native
 * quiescence witness. Oracle B22/oracle-1 + owner disposition: never promote a
 * display idle/default pending=none to observed quiescence. A bounded facade
 * tail reader and a typed B16 witness are explicitly deferred by the owner.
 */
export class RetirementEvidenceReader {
  private closed = false;
  private stores = new Map<string, ObservationStore>();
  constructor(private readonly home: string) {}
  async read(snapshot: RunSnapshot): Promise<Quiescence | null> {
    if (this.closed) return null;
    const ref = snapshot.run.targetSessionRef ?? snapshot.status.link.childRef;
    if (!ref) return null;
    try {
      let store = this.stores.get(ref.sourceId);
      if (!store) {
        store = await openObservationStore({ hudHome: this.home, sourceId: ref.sourceId, readOnly: true });
        if (this.closed) {
          store.close();
          return null;
        }
        this.stores.set(ref.sourceId, store);
      }
      const candidate = store.readProjection(ref);
      const selected = selectCurrentObservation(
        {
          ref,
          runId: snapshot.run.runId,
          bindingGeneration: snapshot.run.expectedGeneration,
          sourceGeneration: candidate?.sourceGeneration ?? 0,
          asOfSeq: snapshot.status.asOfSeq,
        },
        candidate ? { stamp: candidate.observationStamp, value: candidate } : null
      ).observation;
      if (!selected) return null;
      const projection = selected.summary.statusProjection;
      const now = Date.now();
      if (
        projectFreshness(projection.freshness.sources, projection.freshness.requiredSourceIds, now).state !== 'fresh' ||
        !['approval', 'question'].includes(projection.pendingReason)
      )
        return null;
      const since =
        projection.stateKey === `pending:${projection.pendingReason}` &&
        selected.continuity.stateKey === projection.stateKey &&
        selected.continuity.stateSince === projection.stateSince &&
        selected.continuity.stateSinceBasis === projection.stateSinceBasis &&
        projection.stateSince !== null &&
        projection.stateSinceBasis !== 'unknown' &&
        projection.stateSince <= now
          ? projection.stateSince
          : null;
      return {
        quiescent: false,
        since: null,
        pendingInput: projection.pendingReason,
        pendingSince: since,
        source: 'b16:readProjection',
        asOf: now,
      };
    } catch {
      return null;
    }
  }
  close(): void {
    this.closed = true;
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}
