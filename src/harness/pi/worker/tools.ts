import { callWorkerTool, capturePiTree, listWorkerTools, watchSonicReady } from '../../../worker/tools.js';
import type { WorkerPi } from './host.js';

export async function workerTools(pi: WorkerPi, dir: string, sessionWorker: boolean) {
  const notices = new AbortController();
  const waits = new Set<{ ids?: string[] }>(), pendingReady = new Map<string, () => void>();
  function stopNotices() {
    notices.abort();
    pendingReady.clear();
  }
  function flushReady() {
    for (const [id, send] of pendingReady) {
      if ([...waits].some(({ ids }) => !ids?.length || ids.includes(id))) continue;
      pendingReady.delete(id);
      send();
    }
  }
  if (sessionWorker) {
    pi.on('session_shutdown', stopNotices);
    pi.on('turn_end', ({ toolResults }, ctx) => {
      if (!toolResults.some(result => result.toolName === 'hud_ask' && !result.isError)) return;
      // Pi has persisted all tool results, including when the ask had sibling calls in its batch.
      try { capturePiTree(dir); } finally { ctx.abort(); }
    });
  }
  for (const { name, description, inputSchema } of await listWorkerTools()) {
    pi.registerTool<Record<string, unknown>>({ name, label: name, description, parameters: inputSchema, promptSnippet: description,
      async execute(_id, args, signal) {
        const wait = name === 'hud_sonic' && args.task === undefined ? { ids: Array.isArray(args.wait) ? args.wait : undefined } : null;
        if (wait) waits.add(wait);
        let value;
        try {
          value = await callWorkerTool(name, args, signal);
          if (wait && typeof value === 'object' && 'reports' in value) {
            for (const { id } of value.reports) pendingReady.delete(id);
          }
        } finally {
          if (wait) { waits.delete(wait); flushReady(); }
        }
        if (name === 'hud_ask' || name === 'hud_report') stopNotices();
        if (name === 'hud_ask') return {
          content: [{ type: 'text', text: 'Question recorded. The orchestrator’s answer resumes this session.' }], terminate: true,
        };
        if (name === 'hud_sonic' && !wait && typeof value === 'object' && 'job' in value) {
          const id = value.job;
          watchSonicReady(id, notices.signal, state => {
            const send = () => pi.sendMessage({ customType: 'hud-sonic-ready', display: true,
              content: `Sonic ${id} ${state}. Collect its result with hud_sonic (wait: ["${id}"]).` },
              { triggerTurn: true, deliverAs: 'steer' });
            if (state === 'failed') send();
            else { pendingReady.set(id, send); flushReady(); }
          });
        }
        return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
          details: value, ...(name === 'hud_report' && { terminate: true }) };
      },
    });
  }
}
