// A separate recovery process must not obtain the dead/original writer's role.
import { createRunFactPort } from '../../dist-test/src/core/run/ledger-port.js';
const port = await createRunFactPort(process.env.HUD_HOME),
  id = process.argv[2];
const s = await port.read(id),
  results = [];
try {
  for (const [operation, invoke] of [
    ['raw', () => port.raw(id, s.run.supervisor, 'clock.anomaly', { wallDeltaMs: -1, monoDeltaMs: 1 })],
    ['startup', () => port.startup(id, s.run.supervisor, {})],
    ['receipt', () => port.receipt(id, s.run.supervisor, {})],
  ]) {
    try {
      await invoke();
      results.push({ operation, accepted: true });
    } catch (error) {
      results.push({ operation, accepted: false, reason: error.message });
    }
  }
  process.stdout.write(JSON.stringify(results));
} finally {
  await port.close();
}
