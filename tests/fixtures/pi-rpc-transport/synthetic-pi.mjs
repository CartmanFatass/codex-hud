#!/usr/bin/env node
// Synthetic stdio peer, never a provider request.
import readline from 'node:readline';
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--mode', 'rpc', '--no-session'])) process.exit(10);
if (Object.keys(process.env).some((k) => k.startsWith('HUD_') || k === 'PI_SESSION_ID' || k === 'PI_SESSION_FILE'))
  process.exit(11);
const mode = process.env.SYNTHETIC_MODE ?? 'modern';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  if (r.type !== 'prompt' || r.id !== 'prompt-1') process.exit(12);
  if (mode === 'silent') return;
  if (mode === 'mismatch') {
    send({ id: 'other', type: 'response', command: 'prompt', success: true });
    return;
  }
  if (mode === 'ui') {
    send({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Synthetic' });
    return;
  }
  if (mode === 'truncated') {
    process.stdout.write('{"type":');
    process.exitCode = 0;
    process.stdin.destroy();
    return;
  }
  send({
    id: r.id,
    type: 'response',
    command: 'prompt',
    success: mode !== 'rejected',
    ...(mode === 'handled' ? { data: { disposition: 'handled' } } : {}),
  });
  if (mode === 'handled' || mode === 'rejected') return;
  const start = Buffer.from(JSON.stringify({ type: 'agent_start', synthetic: '中文\u2028same record' }) + '\r\n');
  const split = start.indexOf(Buffer.from('中')) + 1;
  process.stdout.write(start.subarray(0, split));
  setTimeout(() => {
    process.stdout.write(start.subarray(split));
    send({ type: 'agent_end', messages: [] });
    if (mode === 'legacy') return;
    send({ type: 'auto_retry_start', attempt: 1 });
    send({ type: 'auto_retry_end', success: true });
    send({ type: 'agent_start' });
    send({ type: 'agent_end', messages: [] });
    send({ type: 'agent_settled', aborted: mode === 'aborted' });
  }, 5);
});
