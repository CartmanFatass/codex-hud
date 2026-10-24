// External benchmark preload. Runtime instrumentation is kept out of the app.
import fs from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
const start = performance.now(),
  cpu = process.cpuUsage();
process.on('exit', () => {
  const usage = process.cpuUsage(cpu),
    wall = performance.now() - start;
  fs.writeFileSync(
    process.env.HUD_PERF_RESULT,
    JSON.stringify({
      wallMs: wall,
      cpuMs: (usage.user + usage.system) / 1000,
      cpuPercent: ((usage.user + usage.system) / 1000 / wall) * 100,
      eventLoopMs: { p95: loop.percentile(95) / 1e6, max: loop.max / 1e6 },
    })
  );
});
