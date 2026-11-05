// Synthetic child only: no provider, account or network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexExecTransport } from '../dist/harness/codex/exec-transport.js';
const root = mkdtempSync(join(tmpdir(), 'codex-exec-demo-'));
const prompt = 'synthetic prompt';
try {
  const result = await new CodexExecTransport().run({
    executable: resolve('tests/fixtures/codex-exec-transport/synthetic-client.mjs'),
    cwd: root,
    env: {
      PATH: dirname(process.execPath),
      HOME: root,
      SYNTHETIC_MODE: 'complete',
      SYNTHETIC_PROMPT_BYTES: String(Buffer.byteLength(prompt)),
      SYNTHETIC_PROMPT_HASH: createHash('sha256').update(prompt).digest('hex'),
    },
    prompt,
    timeoutMs: 5000,
  });
  if (result.outcome !== 'observed_complete' || result.observation.threadId !== 'synthetic-thread')
    throw new Error('synthetic demo failed');
  console.log(
    JSON.stringify({
      provenance: 'SIMULATED',
      outcome: result.outcome,
      threadId: result.observation.threadId,
      closeObserved: result.closeObserved,
      note: 'No real provider, account, managed authority, or task-success proof.',
    })
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
