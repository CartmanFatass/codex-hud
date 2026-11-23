import type { EngineInterface, Timer } from 'claude-code';

// The child owns filesystem watches. The mod only stats the two append-only logs while a
// registered project sleeps. Hand their cursors back on restart: PanelActionLog starts at EOF.
export function watchProcess($: EngineInterface, cwd: string, home: string, project: boolean,
  lastDelivery: () => number, receive: (lines: string[], at: unknown) => Promise<void>) {
  let child: ReturnType<typeof $.process.spawn> | undefined, ready: Promise<void> | undefined;
  let retry: Timer | undefined, sleeper: Timer | undefined, stopped = false, failures = 0;
  // Empty starts a bounded catch-up. Only a clean sleep has a cursor to replay from.
  let cursor = '';
  const delays = [1000, 5000, 15000];

  function start() {
    if (ready || retry || stopped) return ready;
    sleeper?.cancel();
    let signal!: () => void;
    ready = new Promise<void>(resolve => { signal = resolve; });
    void run(signal);
    return ready;
  }

  async function run(signal: () => void) {
    try {
      child = $.process.spawn({ argv: ['hud', 'watch', '--mod'], cwd,
        env: { HUD_MOD_CURSOR: cursor, HUD_MOD_LAST_DELIVERY: String(lastDelivery()) } });
      let buffer = '', sizes: number[] | undefined;
      for await (const chunk of child) {
        if (chunk.stream !== 'stdout') continue;
        buffer += chunk.text;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const record = JSON.parse(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          if (record.type === 'ready') { cursor = ''; signal(); }
          if (record.type === 'wake' && Array.isArray(record.lines) && record.lines.every((s: unknown) => typeof s === 'string')) await receive(record.lines, record.at);
          if (record.type === 'sleep') { cursor = record.cursor; sizes = record.sizes; }
        }
      }
      if ((await child.result).code !== 0) throw new Error('hud watch exited unexpectedly');
      failures = 0;
      if (project && sizes && !stopped) {
        const baseline = sizes;
        sleeper = $.clock.every(5000, async () => {
          const current = await Promise.all(['tries.jsonl', 'panel-actions.jsonl'].map(name =>
            $.fs.stat(`${home}/${name}`).then(st => st.size, () => 0)));
          if (current.some((size, i) => size !== baseline[i])) void start();
        });
      }
    } catch {
      if (!stopped) {
        const delay = delays[failures++];
        if (delay !== undefined) retry = $.clock.after(delay, () => { retry = undefined; void start(); });
        else $.ui.log('HUD watch unavailable; using MCP delivery.', { to: 'debug' });
      }
    } finally {
      signal(); // Missing binary or failed registration must not block a tool call.
      child = undefined;
      ready = undefined;
    }
  }

  return { start, stop() {
    stopped = true;
    retry?.cancel(); sleeper?.cancel();
    void child?.return({ code: null, signal: 'SIGTERM' }).catch(() => {});
  } };
}
