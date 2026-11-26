import { join } from 'node:path';
import { jobFiles } from '../../../mcp/paths.js';
import {
  notifyQuestion,
  parseAskTimeoutSeconds,
  publishQuestion,
  questionTag,
} from '../../../worker/qa.js';
import {
  callWorkerTool,
  capturePiTree,
  listWorkerTools,
  watchSonicReady,
  workerJob,
} from '../../../worker/tools.js';
import type { WorkerPi } from './host.js';
import type { TabLifecycleController } from './tab-lifecycle.js';

const ASYNC_ASK_GUIDANCE =
  'Use hud_ask with mode="async" when unrelated work can continue. Wait for the native decision before doing dependent work; a pending ticket does not authorize the default. Use mode="sync" when no useful work can proceed without the answer.';
const ASYNC_UNSUPPORTED =
  'Async ask requires the live HUD Pi TUI worker and its job QA directory. Use the synchronous ask instead.';

export async function workerTools(
  pi: WorkerPi,
  dir: string,
  sessionWorker: boolean,
  tab?: TabLifecycleController
) {
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
  if (sessionWorker || tab) {
    pi.on('session_shutdown', stopNotices);
  }
  if (sessionWorker && !tab) {
    pi.on('turn_end', ({ toolResults }, ctx) => {
      if (!toolResults.some(result => result.toolName === 'hud_ask' && !result.isError)) return;
      // Pi has persisted all tool results, including when the ask had sibling calls in its batch.
      try { capturePiTree(dir); } finally { ctx.abort(); }
    });
  }
  const qaDir = join(dir, jobFiles.qa);
  for (const { name, description, inputSchema } of await listWorkerTools()) {
    const isTabAsk = Boolean(tab && name === 'hud_ask');
    const schema = isTabAsk
      ? {
          ...inputSchema,
          properties: {
            ...(inputSchema as { properties: Record<string, unknown> }).properties,
            mode: { type: 'string', enum: ['async', 'sync'] },
          },
        }
      : inputSchema;
    const toolDescription = isTabAsk
      ? `Ask the HUD orchestrator a design question. ${ASYNC_ASK_GUIDANCE} Omitted mode is synchronous. Never wait on terminal input.`
      : description;
    pi.registerTool<Record<string, unknown>>({
      name,
      label: name,
      description: toolDescription,
      parameters: schema,
      promptSnippet: isTabAsk
        ? 'hud_ask: ask the HUD orchestrator asynchronously if unrelated work can continue, or synchronously for a hard dependency'
        : description,
      ...(isTabAsk ? { promptGuidelines: [ASYNC_ASK_GUIDANCE] } : {}),
      async execute(_id, args, signal, _onUpdate, ctx) {
        if (isTabAsk && tab) {
          const mode = args.mode;
          if (mode !== undefined && mode !== 'async' && mode !== 'sync') {
            throw new Error('invalid_arguments: mode');
          }
          if (mode === 'async') {
            signal?.throwIfAborted();
            if (!ctx || !tab.canAskAsync(ctx, qaDir)) throw new Error(ASYNC_UNSUPPORTED);
            const { job } = workerJob(dir);
            if (job.council) throw new Error('list open questions in your council report');
            if (job.role === 'sonic') throw new Error('sonic cannot ask questions');
            if (typeof args.question !== 'string') throw new Error('invalid_arguments: question');
            if (typeof args.default !== 'string') throw new Error('invalid_arguments: default');
            if (args.options !== undefined && (!Array.isArray(args.options) || args.options.some(v => typeof v !== 'string'))) {
              throw new Error('invalid_arguments: options');
            }
            if (args.context !== undefined && typeof args.context !== 'string') throw new Error('invalid_arguments: context');
            const published = publishQuestion(qaDir, {
              tag: questionTag(dir, job),
              question: args.question,
              default: args.default,
              options: args.options as string[] | undefined,
              context: args.context,
            });
            const timeoutMs = parseAskTimeoutSeconds() * 1000;
            const requestId = tab.trackQuestion(ctx, published, Number.isSafeInteger(timeoutMs) ? timeoutMs : 1_200_000);
            void notifyQuestion(dir, job, published, signal, true).catch(error => {
              console.error(`[hud-worker] ${requestId} notify failed: ${error}`);
            });
            return {
              content: [{
                type: 'text',
                text: `Published ${requestId}; decision pending. Continue unrelated work only. Wait for the native HUD decision before doing dependent work or finalizing the report.`,
              }],
              details: {
                requestId,
                pending: true,
                qaDir,
                question: published.qfile,
                answerFile: published.afile,
                answered: false,
              },
            };
          }
          const { mode: _syncMode, ...rest } = args;
          const value = await callWorkerTool(name, rest, signal);
          const text = typeof value === 'string' ? value : JSON.stringify(value);
          return {
            content: [{ type: 'text', text }],
            details: { qaDir, answered: text.startsWith('ANSWER ') },
          };
        }
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
        if (!tab && (name === 'hud_ask' || name === 'hud_report')) stopNotices();
        if (name === 'hud_ask') return {
          content: [{ type: 'text', text: 'Question recorded. The orchestrator’s answer resumes this session.' }], terminate: true,
        };
        if (name === 'hud_sonic' && !wait && typeof value === 'object' && 'job' in value) {
          const id = value.job;
          watchSonicReady(
            id,
            notices.signal,
            state => {
              const send = () => pi.sendMessage({ customType: 'hud-sonic-ready', display: true,
                content: `Sonic ${id} ${state}. Collect its result with hud_sonic (wait: ["${id}"]).` },
                { triggerTurn: true, deliverAs: 'steer' });
              if (state === 'failed') send();
              else { pendingReady.set(id, send); flushReady(); }
            },
            tab ? text => ctx?.ui?.notify?.(`Sonic ${id}: ${text}`, 'info') : undefined
          );
        }
        return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
          details: value, ...(name === 'hud_report' && { terminate: true }) };
      },
    });
  }
}
