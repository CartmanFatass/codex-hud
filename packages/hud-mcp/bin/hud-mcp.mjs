#!/usr/bin/env node
// Keep the Node floor check and generation owner independent of any built dist.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  process.stderr.write(
    `hud-mcp requires Node >=24.0.0 (running ${process.versions.node}).\n`
  );
  process.exit(1);
}
import { selectMcpEntry } from './surface.mjs';
import { buildStamp, withDistLock } from '../../../scripts/dist-lock.mjs';
import { createInterface } from 'node:readline';
import { openGeneration } from './generation.mjs';

let entry;
try {
  entry = selectMcpEntry(process.env.HUD_MCP_SURFACE);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'unknown_surface'}\n`);
  process.exit(1);
}
try {
  const url = new URL(entry, import.meta.url);
  let stamp, current;
  await withDistLock(async () => {
    current = await openGeneration(url, undefined, true);
    stamp = buildStamp();
  });
  await current.call('start');
  const calls = new Set();
  let switching;
  async function reload(seen) {
    await Promise.all([...calls]); // Never move a mutation, long wait or its response across the boundary.
    let next, toolsChanged = false;
    try {
      const state = await current.call('snapshot');
      if (state?.scoutedCreatePending) return; // Keep serving calls; retry the reload after the handoff.
      await withDistLock(async () => {
        seen = buildStamp();
        next = await openGeneration(url);
      });
      const started = await next.call('start', state);
      await current.call('stop');
      current.retire();
      current = next;
      toolsChanged = typeof state?.toolsList === 'string' && typeof started?.toolsList === 'string' && state.toolsList !== started.toolsList;
    } catch (error) {
      next?.retire();
      console.error(`hud-mcp: keeping previous build: ${error.message}`);
    }
    stamp = seen;
    if (toolsChanged) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  function dispatch(line) {
    const call = current.call('request', line).catch((error) => {
      // Never replay a failed mutation. Keep unrelated calls and the transport alive.
      console.error(`hud-mcp request failed: ${error.message}`);
      let id;
      try { id = JSON.parse(line)?.id; } catch { id = null; }
      if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } };
    }).then((reply) => {
      if (reply !== undefined) process.stdout.write(JSON.stringify(reply) + '\n');
    });
    calls.add(call);
    void call.finally(() => calls.delete(call));
  }
  input.on('line', (line) => {
    if (!switching) {
      const seen = buildStamp();
      if (seen && seen !== stamp) switching = reload(seen).finally(() => { switching = undefined; });
    }
    if (switching) void switching.then(() => dispatch(line)); else dispatch(line);
  });
  input.on('close', async () => {
    await switching;
    await Promise.all(calls);
    await current.call('stop');
    current.retire();
  });
} catch (error) {
  process.stderr.write(`hud-mcp startup failed: ${error instanceof Error ? error.message : 'unknown_error'}\n`);
  process.exitCode = 1;
}
