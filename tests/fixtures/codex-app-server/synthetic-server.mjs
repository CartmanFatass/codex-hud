import readline from 'node:readline';
const mode = process.argv[2] ?? 'normal';
if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
const line = readline.createInterface({ input: process.stdin });
let ready = false;
let held = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
line.on('line', (text) => {
  const request = JSON.parse(text);
  if (request.method === 'initialize') {
    // Split a real stdout frame across asynchronous writes.
    const bytes = JSON.stringify({ id: request.id, result: { userAgent: 'synthetic-server' } }) + '\n';
    process.stdout.write(bytes.slice(0, 7));
    setTimeout(() => process.stdout.write(bytes.slice(7)), 5);
    return;
  }
  if (request.method === 'initialized') {
    ready = true;
    return;
  }
  if (!ready) process.exit(3);
  if (mode === 'silent') return;
  if (mode === 'stderr-limit') {
    process.stderr.write('x'.repeat(65537));
    return;
  }
  if (mode === 'approval') {
    send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {} });
    return;
  }
  if (mode === 'malformed') {
    process.stdout.write('{bad}\n');
    return;
  }
  if (mode === 'exit') {
    process.exit(7);
  }
  const response = { id: request.id, result: { thread: { id: request.params.threadId ?? 'synthetic-thread' } } };
  if (mode === 'reorder') {
    held.push(response);
    if (held.length === 2) {
      send(held.pop());
      send(held.pop());
    }
    return;
  }
  send({ method: 'thread/started', params: { thread: { id: 'synthetic-thread' } } });
  send(response);
});
