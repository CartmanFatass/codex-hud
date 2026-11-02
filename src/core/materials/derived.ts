/** Source-aware notes for B10; generic output must never enter provenance-free legacy stores. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePrivateFile } from '../../collectors/small-model.js';
import {
  buildMaterials,
  fingerprint,
  isEnvelope,
  isLegacyEnvelope,
  revalidateMaterials,
  type MaterialAuthority,
  type MaterialEnvelope,
  type MaterialSubject,
  type OutboundPurpose,
  type ResolvedRecipient,
} from './index.js';

export class DerivedMaterialStore {
  constructor(private readonly dir: string) {}
  save(
    text: string,
    envelope: MaterialEnvelope,
    authority: MaterialAuthority,
    recipient: ResolvedRecipient
  ): string | null {
    if (
      !text ||
      Buffer.byteLength(text) > 65536 ||
      isLegacyEnvelope(envelope) ||
      !revalidateMaterials(envelope, authority, recipient)
    )
      return null;
    const id = randomUUID();
    writePrivateFile(
      path.join(this.dir, `${id}.json`),
      JSON.stringify({ schemaVersion: 1, id, text, outputFingerprint: fingerprint(text), envelope })
    );
    return id;
  }
  /** Restores the original union under the NEW consumer's scope/purpose/recipient before reading its text. */
  load(
    id: string,
    authority: MaterialAuthority,
    purpose: OutboundPurpose,
    recipient: ResolvedRecipient
  ): MaterialEnvelope | null {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    try {
      const file = path.join(this.dir, `${id}.json`);
      if (fs.statSync(file).size > 1024 * 1024) return null;
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        schemaVersion: number;
        id: string;
        text: string;
        outputFingerprint: string;
        envelope: MaterialEnvelope;
      };
      if (stored.schemaVersion !== 1 || stored.id !== id || !Array.isArray(stored.envelope?.fragments)) return null;
      const origins = stored.envelope.fragments.flatMap((f) => f.provenance);
      if (!origins.length || origins.some((p) => p.sourceId !== p.ref?.sourceId)) return null;
      const parent = buildMaterials({
        purpose,
        resolvedRecipient: recipient,
        authority,
        subjects: origins.map((p) => ({
          ref: p.ref,
          origin: p.origin,
          field: p.field,
          kind: 'public_text',
          recordFingerprint: p.recordFingerprint,
          coverage: stored.envelope.coverage,
          read: () => 'bound derived provenance',
        })),
        limits: { maxBytes: 65536 },
      });
      if (!isEnvelope(parent)) return null;
      if (typeof stored.text !== 'string' || fingerprint(stored.text) !== stored.outputFingerprint) return null;
      // Use a currently admissible field while retaining every original field/ref in provenance.
      const subject: MaterialSubject = {
        ref: origins[0].ref,
        origin: origins[0].origin,
        field:
          ({ jev_task: 'result', routing: 'brief', probe: 'probe' } as Partial<Record<OutboundPurpose, string>>)[
            purpose
          ] ?? purpose,
        kind: 'derived',
        derived: parent,
        recordFingerprint: stored.outputFingerprint,
        read: () => stored.text,
      };
      const restored = buildMaterials({
        purpose,
        resolvedRecipient: recipient,
        authority,
        subjects: [subject],
        limits: { maxBytes: 65536 },
      });
      return isEnvelope(restored) ? restored : null;
    } catch {
      return null;
    }
  }
}
