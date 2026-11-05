// Only a synthetic executable, never a real Claude client or account.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ClaudePrintTransport } from '../dist/harness/claude/print-transport.js';
const root = mkdtempSync(join(tmpdir(), 'claude-print-demo-'));
const prompt = 'synthetic prompt';
try {
  const result = await new ClaudePrintTransport().run({
    executable: resolve('tests/fixtures/claude-print-transport/synthetic-client.mjs'),
    cwd: root,
    mode: 'bare',
    env: {
      PATH: dirname(process.execPath),
      HOME: root,
      SYNTHETIC_MODE: 'success',
      SYNTHETIC_BARE: '1',
      SYNTHETIC_PROMPT_BYTES: String(Buffer.byteLength(prompt)),
      SYNTHETIC_PROMPT_HASH: createHash('sha256').update(prompt).digest('hex'),
      SYNTHETIC_DISCOVERY_OUTPUT: join(root, 'discovery'),
    },
    prompt,
    timeoutMs: 5000,
  });
  if (result.outcome !== 'observed_complete') throw new Error('synthetic demo failed');
  console.log(
    JSON.stringify({
      provenance: 'SIMULATED',
      mode: 'bare',
      outcome: result.outcome,
      closeObserved: result.closeObserved,
      note: 'No real provider, account, capability, sandbox, or task-success proof.',
    })
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
