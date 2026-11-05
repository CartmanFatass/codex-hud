#!/usr/bin/env node
// Synthetic subprocess only: no provider, auth, network, hook execution, or real MCP.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
if (process.env.SYNTHETIC_COUNTER_FILE) appendFileSync(process.env.SYNTHETIC_COUNTER_FILE, 'spawn\n');
const mode = process.env.SYNTHETIC_MODE ?? 'success';
const expectedBare = process.env.SYNTHETIC_BARE === '1';
const resume = process.env.SYNTHETIC_RESUME;
const expected = [
  ...(expectedBare ? ['--bare'] : []),
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  ...(resume ? ['--resume', resume] : []),
];
if (
  JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected) ||
  Object.keys(process.env).some((k) => k.startsWith('HUD_'))
)
  process.exit(12);
if (mode === 'success-no-input') {
  process.stdin.destroy();
  process.stdout.end(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      result: 'synthetic',
    }) + '\n'
  );
} else if (mode === 'early-close') {
  process.stdin.destroy();
  process.exit(7);
} else if (mode === 'hang') {
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else if (mode === 'stderr') {
  process.stderr.write('x'.repeat(1024 * 1024 + 1024));
  setTimeout(() => {}, 5000);
} else if (mode === 'stdout') {
  process.stdout.write('x'.repeat(65537));
  setTimeout(() => {}, 5000);
} else {
  let size = 0;
  const hash = createHash('sha256');
  process.stdin.on('data', (chunk) => {
    size += chunk.length;
    hash.update(chunk);
  });
  process.stdin.on('end', async () => {
    if (size !== Number(process.env.SYNTHETIC_PROMPT_BYTES) || hash.digest('hex') !== process.env.SYNTHETIC_PROMPT_HASH)
      process.exit(14);
    if (mode === 'nonzero') {
      process.stderr.write('SYNTHETIC_PRIVATE_DIAGNOSTIC');
      process.exit(7);
    }
    if (mode === 'existing') {
      await import('../claude-contract-2026-11-05/simulator.mjs');
      return;
    }
    writeFileSync(
      process.env.SYNTHETIC_DISCOVERY_OUTPUT,
      JSON.stringify({ projectHooks: !expectedBare, projectMcp: !expectedBare })
    );
    const session =
      mode === 'mismatch' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : (resume ?? 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
    const records = [
      { type: 'system', subtype: 'init', session_id: session, cwd: '/synthetic/private' },
      { type: 'assistant', session_id: session, message: { content: 'SYNTHETIC_PRIVATE_BODY 中文' } },
      {
        type: 'stream_event',
        session_id: session,
        event: { delta: { type: 'text_delta', text: 'SYNTHETIC_PRIVATE_BODY 中文' } },
      },
      ...(mode === 'missing'
        ? []
        : [
            {
              type: 'result',
              subtype: mode === 'error' ? 'error_during_execution' : 'success',
              is_error: mode === 'error',
              session_id: session,
              result: 'SYNTHETIC_PRIVATE_BODY',
              total_cost_usd: 0,
            },
          ]),
    ];
    const bytes = Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n'),
      split = bytes.indexOf(Buffer.from('中')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setImmediate(() => process.stdout.end(bytes.subarray(split)));
  });
}
