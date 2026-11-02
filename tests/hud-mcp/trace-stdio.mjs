// Real-harness acceptance observer: metadata and synthetic tool responses only.
// Do not set this observer on a user session. Paths must be run-owned scratch.
import fs from 'node:fs';
const file = process.env.B1_TRACE;
if (!file) throw new Error('B1_TRACE is required');
const record = (row) =>
  fs.appendFileSync(file, JSON.stringify({ at: Date.now(), pid: process.pid, ppid: process.ppid, ...row }) + '\n', {
    mode: 0o600,
  });
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk.toString();
  let index;
  while ((index = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    try {
      const row = JSON.parse(line);
      record({ direction: 'request', method: row.method, id: row.id, name: row.params?.name, meta: row.params?._meta });
    } catch {
      /* observe only */
    }
  }
});
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, ...args) {
  try {
    const row = JSON.parse(String(chunk));
    record({
      direction: 'response',
      id: row.id,
      tools: row.result?.tools?.map((tool) => tool.name),
      outcome: row.result?.structuredContent,
      error: row.error,
    });
  } catch {
    /* observe only */
  }
  return write(chunk, ...args);
};
await import('../../packages/hud-mcp/bin/hud-mcp.mjs');
