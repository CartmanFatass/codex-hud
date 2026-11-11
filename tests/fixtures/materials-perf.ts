import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildMaterials,
  fileAuthority,
  fingerprint,
  type MaterialAuthority,
  type MaterialSubject,
  type OutboundPurpose,
} from '../../src/core/materials/index.js';
import { resolveRecipient } from '../../src/core/materials/recipient.js';
import { writePrivateFile } from '../../src/collectors/small-model.js';

const a = fingerprint('synthetic-codex');
const b = fingerprint('synthetic-claude');
const api = { base: 'https://synthetic.invalid/v1', model: 'synthetic-model', sourceCredential: null };
const route = { backend: 'api' as const, endpoint: `${api.base}/chat/completions`, model: api.model };
const target = resolveRecipient(route, 'synthetic-account')!;
const ref = (sourceId = a, sessionId = 'synthetic-session') => ({
  harness: sourceId === b ? ('claude' as const) : ('codex' as const),
  sourceId,
  sessionId,
  threadId: null,
});
const field: Record<OutboundPurpose, string> = {
  brief: 'report',
  recap: 'message',
  progress: 'report',
  digest: 'result',
  label: 'task',
  title: 'message',
  cause: 'error',
  changes: 'diff',
  approval: 'command',
  probe: 'probe',
  routing: 'signal',
  jev_task: 'message',
};
function subject(
  sourceId = a,
  text = 'Authorized public observation',
  purpose: OutboundPurpose = 'brief'
): MaterialSubject {
  return {
    ref: ref(sourceId),
    origin: 'native',
    field: field[purpose],
    kind: 'public_text',
    read: () => text,
    recordFingerprint: fingerprint(['synthetic-record', sourceId, purpose]),
  };
}
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'b17-materials-'));
  let allowedOrigins = new Set(['native']);
  const scopes = new Map([
    [a, 1],
    [b, 1],
  ]);
  const authority = fileAuthority(home, (sourceId) =>
    scopes.has(sourceId)
      ? {
          revision: scopes.get(sourceId)!,
          local: true,
          allows: (p) => p.ref.sourceId === sourceId && allowedOrigins.has(p.origin),
        }
      : null
  );
  const grant = (
    sourceId = a,
    purpose: OutboundPurpose = 'brief',
    decision = 'allow',
    revision = 1,
    recipientId = target.recipientId
  ) => {
    writePrivateFile(
      path.join(home, 'sources', sourceId, 'outbound.json'),
      JSON.stringify({
        schemaVersion: 1,
        sourceId,
        revision,
        grants: [{ purpose, recipientId, decision, grantedAt: 0 }],
      })
    );
  };
  return {
    home,
    authority,
    grant,
    scopes,
    origins: (origins: string[]) => {
      allowedOrigins = new Set(origins);
    },
    close: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}
function build(
  authority: MaterialAuthority,
  subjects: MaterialSubject[],
  purpose: OutboundPurpose = 'brief',
  allowPartial = false
) {
  return buildMaterials({
    subjects,
    purpose,
    authority,
    resolvedRecipient: target,
    limits: { maxBytes: 65536 },
    allowPartial,
  });
}
export { a, b, api, route, target, ref, field, subject, setup, build };
