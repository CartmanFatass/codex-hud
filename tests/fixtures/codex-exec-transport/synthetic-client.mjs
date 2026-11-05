#!/usr/bin/env node
// Fake client, never connects to an account or provider.
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
if (process.env.SYNTHETIC_COUNTER_FILE) appendFileSync(process.env.SYNTHETIC_COUNTER_FILE, 'spawn\n');
const [first, json, ...rest] = process.argv.slice(2);
if (first !== 'exec' || json !== '--json' || Object.keys(process.env).some((k) => k.startsWith('HUD_')))
  process.exit(12);
const mode = process.env.SYNTHETIC_MODE ?? 'complete';
const expectedResume = process.env.SYNTHETIC_EXPECT_RESUME;
if (expectedResume ? rest.length !== 2 || rest[0] !== 'resume' || rest[1] !== expectedResume : rest.length !== 0)
  process.exit(13);
if (mode === 'early-success') {
  process.stdin.destroy();
  const events = [
    { type: 'thread.started', thread_id: 'synthetic-thread' },
    { type: 'turn.started' },
    { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
  ];
  process.stdout.write(events.map((event) => JSON.stringify(event)).join('\n') + '\n', () => process.exit(0));
} else if (mode === 'early-close') {
  process.stdin.destroy();
  process.exit(7);
} else if (mode === 'hang') {
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else if (mode === 'stderr') {
  process.stderr.write('x'.repeat(1024 * 1024 + 1000));
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
  process.stdin.on('end', () => {
    if (size !== Number(process.env.SYNTHETIC_PROMPT_BYTES) || hash.digest('hex') !== process.env.SYNTHETIC_PROMPT_HASH)
      process.exit(14);
    if (mode === 'nonzero') {
      process.stderr.write('SYNTHETIC_PRIVATE_DIAGNOSTIC');
      process.exit(7);
    }
    const id = mode === 'mismatch' ? 'synthetic-other' : (expectedResume ?? 'synthetic-thread');
    const lines =
      [
        { type: 'thread.started', thread_id: id },
        { type: 'turn.started' },
        {
          type: 'item.completed',
          item: { id: 'item-synthetic', type: 'agent_message', text: 'SYNTHETIC_PRIVATE_BODY 中文' },
        },
        { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 3 } },
      ]
        .map((v) => JSON.stringify(v))
        .join('\n') + '\n';
    const bytes = Buffer.from(lines),
      split = bytes.indexOf(Buffer.from('中')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setImmediate(() => process.stdout.end(bytes.subarray(split)));
  });
}
