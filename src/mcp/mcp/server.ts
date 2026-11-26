/** MCP request handling and generation handoff. */
import { ROLE_TOOLS as tools } from '../../roles/tool-definitions.js';
import { paneInfo } from '../../roles/notify.js';
import type { Job } from '../job-contracts.js';
import type { RequestCaller } from '../local-objectives.js';
import * as workerTools from '../../worker/tools.js';
import { statuslineTool, statuslineResource, readCodexStatusline } from '../codex-statusline.js';
import { inlinePending, retireInline } from '../../workflows/inline.js';
import { isWorker, hudHome, publishWorkSummary, scanForCall, writeScan, findJob } from '../store/job-store.js';
import { locks, keyLock } from '../store/key-lock.js';
import { pruneCreatedJobs, pruneLandTasks, pruneTasks } from '../task-bounds.js';
import { MAIN_SESSION_INSTRUCTIONS } from './instructions.js';
import { checkModTakeover, syncPanelDelivery, call, mutationKey, withChanges, ownerDelivery, closeJob } from './operations.js';
import { compactResult } from './result-text.js';
import { resumeTicketEdits } from '../ticket-edit-queue.js';
import { ownStatuslineStrip } from '../../statusline-parity/strip.js';
import { session, callerPane, checkResume, adoptSessionJobs, tries, answers, sessionRows, refreshModWatch } from './session-state.js';
import {
  resumeTaskReceipts, taskRequest, taskContent, isTaskReply, handedOff, landTasks, landActive, flowReceipt, tasks,
  evictTask, activeTasks, loadTaskReceipt, TASK_TTL, saveTaskReceipt, stopBatchDelivery, beginHandoff,
  restoreTaskMaps, clearTaskSweep, clearTaskMaps, batchTasks, batchPending,
} from './tasks.js';

const worker = isWorker ? workerTools : undefined;
let strip: ReturnType<typeof ownStatuslineStrip>;
function startStatuslineStrip() {
  const client = session.callerHarness ?? (process.env.CLAUDE_CODE_SESSION_ID ? 'claude' : undefined);
  if (!strip && !worker && !session.resumeRefusal && (client === 'claude' || client === 'agy')) {
    strip = ownStatuslineStrip(client, { ...process.env, HUD_HOME: hudHome }, () => !session.resumeRefusal);
  }
}
function isLeadWorker(): boolean {
  if (!worker) return false;
  try { return worker.workerJob().job.role === 'lead'; } catch { return false; }
}
const leadWorkerTools = new Set(['hud_report', 'hud_progress']);
const leadBlockedTools = new Set(['hud_land']);

const TASK_EXTENSION = 'io.modelcontextprotocol/tasks';

const privateCache = { ttlMs: 0, cacheScope: 'private' } as const;
const resultText = process.env.HUD_MCP_JSON === '1' ? JSON.stringify : compactResult;

async function toolsListResult() {
  if (session.resumeRefusal) return { ...(session.discovered ? privateCache : {}), tools: [] };
  if (worker) {
    const own = await worker.listWorkerTools(true);
    return {
      ...(session.discovered ? privateCache : {}),
      tools: isLeadWorker()
        ? [...tools.filter((tool) => !leadBlockedTools.has(tool.name)), ...own.filter((tool) => leadWorkerTools.has(tool.name))]
        : own,
    };
  }
  return {
    ...(session.discovered ? privateCache : {}),
    tools: [...tools, statuslineTool].filter((tool) => !session.taskClient || tool.name !== 'hud_wait').map((tool) =>
      session.taskClient && ['hud_create', 'hud_send', 'hud_respond', 'hud_land', 'hud_tickets'].includes(tool.name)
        ? { ...tool, execution: { taskSupport: 'optional' } } : tool),
  };
}
function dispatchIdentity(thread: unknown): Job['dispatcher'] {
  if (session.agyClient) return;
  const { HUD_MCP_PI_SESSION_ID: pi, CLAUDE_CODE_SESSION_ID: claude } = process.env;
  // No pane lookup or Codex root sessionId: a native child reports its own threadId.
  if (typeof thread === 'string' && thread) return { harness: 'codex', id: thread };
  if (pi !== undefined) return pi ? { harness: 'pi', id: pi } : undefined;
  if (claude) return { harness: 'claude', id: claude };
}
async function requestCaller(agy: unknown, codex: unknown): Promise<RequestCaller> {
  let harness = session.callerHarness;
  const env = process.env;
  if (!harness) {
    if (env.CLAUDE_CODE_SESSION_ID) harness = 'claude';
    else if (codex || env.CODEX_THREAD_ID) harness = 'codex';
  }
  const id = harness === 'pi' ? env.HUD_MCP_PI_SESSION_ID : harness === 'agy' ? agy
    : harness === 'claude' ? env.CLAUDE_CODE_SESSION_ID : codex ?? env.CODEX_THREAD_ID;
  if (typeof id === 'string' && id) return { harness, session: id };
  const pane = callerPane ? await paneInfo(callerPane) : null;
  const agent = pane?.agent, reported = pane?.agent_session?.kind === 'id' ? pane.agent_session.value : undefined;
  if (!harness && (agent === 'pi' || agent === 'claude' || agent === 'codex' || agent === 'agy')) harness = agent;
  return { harness, session: harness && agent === harness && typeof reported === 'string' ? reported : undefined };
}

async function receive(line: string, write: (value: unknown) => void): Promise<void> {
  const rpcError = (id: unknown, code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } });
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    rpcError(null, -32700, 'Parse error');
    return;
  }
  if (
    !request ||
    request.jsonrpc !== '2.0' ||
    typeof request.method !== 'string' ||
    (request.id !== undefined && request.id !== null && !['string', 'number'].includes(typeof request.id))
  ) {
    rpcError(null, -32600, 'Invalid Request');
    return;
  }
  if (request.id === undefined) return; // Includes notifications/initialized.
  let result: unknown;
  switch (request.method) {
    case 'server/discover': {
      const meta = request.params?._meta;
      session.discovered = true;
      session.taskCapable = !worker && !session.resumeRefusal && meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28' &&
        Object.hasOwn(meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions ?? {}, TASK_EXTENSION);
      const modLive = refreshModWatch();
      session.taskClient = session.taskCapable && process.env.HUD_CLAUDE_MOD !== '1' && !modLive;
      if (session.taskClient) resumeTaskReceipts();
      await syncPanelDelivery();
      result = { supportedVersions: ['2026-07-28'], ...privateCache,
        capabilities: { tools: { listChanged: true }, ...(!worker && !session.resumeRefusal ? { extensions: { [TASK_EXTENSION]: {} } } : {}) } };
      break;
    }
    case 'initialize':
      session.discovered = session.taskCapable = session.taskClient = false;
      await syncPanelDelivery();
      const clientName = request.params?.clientInfo?.name;
      session.agyClient = clientName === 'antigravity-client';
      if (session.agyClient) session.callerHarness = 'agy';
      if (clientName === 'hud-pi') session.callerHarness = 'pi';
      if (clientName === 'claude-code' || clientName === 'claude') session.callerHarness = 'claude';
      result = {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: true }, resources: {} },
        serverInfo: { name: 'hud-mcp-thin', version: '0.2.0' },
        instructions: session.resumeRefusal ?? (worker ? 'Use the worker tools for your own HUD job. Finish with hud_report.' :
          MAIN_SESSION_INSTRUCTIONS),
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      await checkModTakeover();
      result = await toolsListResult();
      break;
    case 'tasks/get':
    case 'tasks/cancel':
      if (!session.taskCapable || session.resumeRefusal) { rpcError(request.id, -32601, 'Method not found'); return; }
      if (typeof request.params?.taskId !== 'string') { rpcError(request.id, -32602, 'Invalid task id'); return; }
      try {
        result = await taskRequest(request.params.taskId, request.method === 'tasks/cancel', closeJob);
      } catch (error) {
        rpcError(request.id, -32603, String(error));
        return;
      }
      break;
    case 'resources/list':
      result = { resources: worker || session.resumeRefusal ? [] : [statuslineResource] };
      break;
    case 'resources/templates/list':
      result = { resourceTemplates: [] };
      break;
    case 'resources/read':
      if (typeof request.params?.uri !== 'string') {
        rpcError(request.id, -32602, 'Invalid resource URI');
        return;
      }
      if (worker || session.resumeRefusal || request.params.uri !== statuslineResource.uri) {
        rpcError(request.id, -32002, 'Resource not found');
        return;
      }
      result = readCodexStatusline(request.params._meta, hudHome);
      break;
    case 'tools/call': {
      // Antigravity and Codex can expose session identity in tools/call metadata.
      const meta = request.params?._meta, turn = meta?.['x-codex-turn-metadata'];
      const agy = meta?.['antigravity.google/conversation_id'];
      const thread = meta?.threadId ?? turn?.thread_id;
      const codex = thread ?? meta?.sessionId ?? turn?.session_id;
      if (session.agyClient) checkResume('agy', agy);
      else checkResume('codex', codex);
      if (session.resumeRefusal) {
        await syncPanelDelivery();
        result = { ...taskContent(JSON.stringify({ ok: false, code: 'resume_refused', error: session.resumeRefusal })), isError: true };
        break;
      }
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
        rpcError(request.id, -32602, 'Invalid params');
        return;
      }
      if (worker) {
        const isLead = isLeadWorker();
        if (isLead && !leadWorkerTools.has(name) && !leadBlockedTools.has(name) && tools.some((tool) => tool.name === name)) {
          const scan = scanForCall();
          try {
            const invoke = () => writeScan.run(scan, () => call(name, args, scan, undefined, dispatchIdentity(thread)));
            const key = mutationKey(name, args);
            if (key !== null && locks.has(key)) scan.invalidateSummary();
            const value = key === null ? await invoke() : await keyLock(key, invoke);
            result = { content: [{ type: 'text', text: typeof value === 'string' ? value : resultText(value) }] };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result = { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'tool_error', error: message }) }], isError: true };
          } finally {
            scan.clear();
          }
          break;
        }
        const allowed = isLead ? leadWorkerTools.has(name) : (await worker.workerTools(true)).some((tool: { name: string }) => tool.name === name);
        if (!allowed) {
          result = { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'worker_cannot_dispatch' }) }], isError: true };
        } else {
          try {
            const value = await worker.callWorkerTool(name, args);
            if (name === 'hud_ask' || name === 'hud_report' || name === 'hud_sonic') publishWorkSummary();
            result = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
          } catch (error) {
            const code = error instanceof Error && 'code' in error && error.code === 'invalid_arguments'
              ? error.code : 'tool_error';
            result = { content: [{ type: 'text', text: JSON.stringify({ ok: false, code, error: String(error) }) }], isError: true };
          }
        }
        break;
      }
      if (name === statuslineTool.name) {
        result = { content: [{ type: 'text', text: `Codex statusline resource: ${statuslineResource.uri}` }] };
        break;
      }
      await checkModTakeover();
      const scan = scanForCall();
      const invoke = async () => {
        const by = name === 'hud_objective' && (args.op === 'request' || args.op === 'resolve') ? await requestCaller(agy, codex) : undefined;
        return writeScan.run(scan, () => call(name, args, scan, by, dispatchIdentity(thread)));
      };
      try {
        if (session.taskClient && name === 'hud_wait') throw new Error('unknown_tool');
        if (name !== 'hud_wait') await adoptSessionJobs(scan);
        const key = mutationKey(name, args);
        if (key !== null && locks.has(key)) scan.invalidateSummary();
        const value = key === null ? await invoke() : await keyLock(key, invoke);
        const markExhaustion = name !== 'hud_peek';
        if (isTaskReply(value)) {
          result = value;
        } else if (typeof value === 'string') {
          const content = [{ type: 'text', text: value }];
          const delta = await withChanges({}, markExhaustion, scan) as { changes?: unknown[] };
          if (delta.changes) content.push({ type: 'text', text: resultText(delta) });
          result = { content };
        } else {
          result = taskContent(resultText(await withChanges(value, markExhaustion, scan)));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                code: (name === 'hud_objective' || name === 'hud_schedule') && message.startsWith('invalid_arguments:')
                  ? 'invalid_arguments' : 'tool_error',
                error: message,
              }),
            },
          ],
          isError: true,
        };
      } finally {
        scan.clear();
      }
      break;
    }
    default:
      rpcError(request.id, -32601, 'Method not found');
      return;
  }
  // On hot reload, this first request arrives after the old generation released the row.
  startStatuslineStrip();
  write({ jsonrpc: '2.0', id: request.id, result: session.discovered ? { resultType: 'complete', ...result as object } : result });
}
// Private live-connection handoff preserves state that disk recovery cannot, including cancellation authority.
async function snapshot() {
  const toolsList = JSON.stringify(await toolsListResult());
  beginHandoff();
  pruneCreatedJobs(session.createdJobs, (id) => !!findJob(id));
  pruneLandTasks(landTasks, landActive);
  pruneTasks(tasks, Date.now(), evictTask);
  return { version: 1, scoutedCreatePending: inlinePending(), toolsList, tasks, activeTasks, batchTasks, batchPending, landTasks, discovered: session.discovered, taskClient: session.taskClient, taskCapable: session.taskCapable, agyClient: session.agyClient, resumeChecked: session.resumeChecked, resumeRefusal: session.resumeRefusal,
    callerHarness: session.callerHarness, sentConventionVersion: session.sentConventionVersion, sentCreateHint: session.sentCreateHint, createdJobs: session.createdJobs, cursor: session.cursor, modLive: session.modLive, triesAt: tries.delivered, answersAt: answers.offset };
}
export function openRuntime() {
  return {
    snapshot,
    async start(state?: Awaited<ReturnType<typeof snapshot>>) {
      if (!state) {
        checkResume('claude', process.env.CLAUDE_CODE_SESSION_ID);
        if (!worker && !session.resumeRefusal) {
          session.cursor = new Map(sessionRows(false).map((row) => [row.job, row]));
          resumeTicketEdits(hudHome);
        }
        return;
      }
      if (state.version !== 1) throw new Error('incompatible MCP session handoff');
      ({ discovered: session.discovered, taskClient: session.taskClient, agyClient: session.agyClient,
        resumeChecked: session.resumeChecked, resumeRefusal: session.resumeRefusal, callerHarness: session.callerHarness,
        sentConventionVersion: session.sentConventionVersion, sentCreateHint: session.sentCreateHint,
        createdJobs: session.createdJobs, cursor: session.cursor } = state);
      session.taskCapable = state.taskCapable ?? state.taskClient;
      session.modLive = state.modLive ?? false;
      tries.delivered = state.triesAt;
      answers.offset = state.answersAt;
      restoreTaskMaps(state);
      await checkModTakeover();
      if (session.taskClient) {
        for (const id of landTasks) {
          if (loadTaskReceipt(id)) continue;
          try {
            const flow = flowReceipt(id), expiresAt = flow ? Date.parse(flow.created_at) + TASK_TTL : 0;
            if (expiresAt > Date.now()) saveTaskReceipt({ id, expiresAt });
          } catch { /* A broken flow receipt must not prevent reload. */ }
        }
        resumeTaskReceipts();
      }
      await syncPanelDelivery();
      return { toolsList: JSON.stringify(await toolsListResult()) };
    },
    async stop() {
      const stripClosed = strip?.stop();
      strip = undefined;
      clearTaskSweep();
      await ownerDelivery?.stop();
      await stripClosed;
      await stopBatchDelivery(!handedOff);
      await retireInline();
      clearTaskMaps();
      session.createdJobs.clear(); session.cursor?.clear();
    },
    async request(line: string) {
      let reply: unknown;
      await receive(line, (value) => { reply = value; });
      return reply;
    },
  };
}
