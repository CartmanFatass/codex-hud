import { workerHarness } from './b10d-harness.mjs';
const fixture = JSON.parse(process.env.B10D_SYNTHETIC_FIXTURE);
const control = new SharedArrayBuffer(64),
  flags = new Int32Array(control);
let cadence = null;
const harness = workerHarness(fixture, {
  entry: process.argv[2] ?? 'bar',
  legacy: process.env.B10D_SYNTHETIC_LEGACY === '1',
  ...(process.env.B10D_SYNTHETIC_FAULTS === '1'
    ? {
        testModule: new URL('./b10d-test-bootstrap.mjs', import.meta.url).href,
        testData: {
          control,
          probe: process.env.B10D_SYNTHETIC_PROBE === '1',
          pinProbe: process.env.B10D_SYNTHETIC_PIN_PROBE === '1',
        },
      }
    : {}),
  onSample: (sample) => {
    if (sample.operationMs >= 1000) process.send?.({ type: 'overrun', sample });
  },
});
process.on('message', async (message) => {
  const { id, command } = message;
  try {
    let result;
    if (command === 'step') result = await harness.step(message.scope ?? fixture.parent.sessionId);
    else if (command === 'warm') {
      await harness.warm(message.count ?? 3);
      result = { ...harness.client.diagnostics(), warm: harness.warmDiagnostics };
    } else if (command === 'paint') {
      harness.paint();
      result = { paints: harness.paints, sink: harness.sink };
    } else if (command === 'fault') {
      Atomics.store(flags, 0, message.code);
      Atomics.store(flags, 1, 0);
      Atomics.store(flags, 2, 0);
      Atomics.store(flags, 3, message.action ?? 0);
      result = true;
    } else if (command === 'stage') result = Atomics.load(flags, 1);
    else if (command === 'release') {
      Atomics.store(flags, 2, 1);
      Atomics.notify(flags, 2);
      result = true;
    } else if (command === 'exitWorker') {
      harness.client.worker.postMessage({ type: 'test_exit' });
      result = true;
    } else if (command === 'metrics')
      result = {
        ...harness.client.diagnostics(),
        memory: process.memoryUsage(),
        peakRss: process.resourceUsage().maxRSS * 1024,
        cpu: process.cpuUsage(),
        paints: harness.paints,
        sink: harness.sink,
      };
    else if (command === 'samples') result = harness.client.samples();
    else if (command === 'view') result = harness.client.current();
    else if (command === 'cadence') {
      if (cadence) clearInterval(cadence);
      cadence = setInterval(() => {
        const grant = harness.client.beginCollection(fixture.parent.sessionId);
        if (grant) harness.client.submitLegacy(grant, { bytesRead: 0, recordsRead: 0, elapsedMs: 0 });
      }, message.ms ?? 1000);
      result = true;
    } else if (command === 'close') {
      if (cadence) clearInterval(cadence);
      result = await harness.close();
      process.send?.({ id, result }, () => process.exit(0));
      return;
    } else throw new Error('unknown_test_command');
    process.send?.({ id, result });
  } catch (error) {
    process.send?.({ id, error: String(error) });
  }
});
process.on('disconnect', () => {
  if (cadence) clearInterval(cadence);
  void harness.close().finally(() => process.exit(0));
});
process.send?.({ type: 'ready', pid: process.pid });
