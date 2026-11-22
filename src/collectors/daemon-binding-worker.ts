/**
 * Off-event-loop SQLite worker for DaemonBinding.
 * Opens Codex's logs_2.sqlite strictly read-only, runs bounded lookups, and closes it per request
 * so no WAL read transaction is held open across ticks.
 */
import { parentPort } from 'node:worker_threads';
import { queryDaemonBinding, type DaemonQueryRequest, type DaemonQueryResponse } from './daemon-binding.js';

interface WorkerMessage {
  id: number;
  request: DaemonQueryRequest;
}

interface WorkerReply {
  id: number;
  response: DaemonQueryResponse;
}

parentPort?.on('message', (message: WorkerMessage) => {
  const response = queryDaemonBinding(message.request);
  const reply: WorkerReply = { id: message.id, response };
  parentPort?.postMessage(reply);
});
