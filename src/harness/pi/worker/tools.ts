import { callWorkerTool, listWorkerTools, workerJob } from '../../../worker/tools.js';
import type { WorkerPi } from './host.js';

export async function workerTools(pi: WorkerPi) {
  const { job } = workerJob();
  if (job.role !== 'sonic' || !job.headless) throw Error('Expected a headless Sonic job');
  for (const { name, description, inputSchema } of await listWorkerTools()) {
    pi.registerTool<Record<string, unknown>>({ name, label: name, description, parameters: inputSchema, promptSnippet: description,
      async execute(_id, args, signal) {
        const value = await callWorkerTool(name, args, signal);
        return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
          details: value, ...(name === 'hud_report' && { terminate: true }) };
      },
    });
  }
}
