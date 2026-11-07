#!/usr/bin/env node
// Synthetic public Pi JSONL peer. No provider, bundled runtime, or historical delegation protocol.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--mode', 'rpc'])) process.exit(10);
const root = process.env.SYNTHETIC_NATIVE_ROOT;
const log = (record) => appendFileSync(join(root, 'pi-wire.jsonl'), JSON.stringify(record) + '\n');
let sessionFile = join(root, 'pi-session.json');
let sessionId = 'synthetic-pi-native-id';
let entries = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')).entries : [];
const save = () => writeFileSync(sessionFile, JSON.stringify({ sessionId, entries }));
save();
const send = (record) => process.stdout.write(JSON.stringify(record) + '\n');
const lines = createInterface({ input: process.stdin });
lines.on('close', () => log({ type: 'stdin_eof' }));
lines.on('line', (line) => {
  const r = JSON.parse(line);
  log(r);
  const reply = (data) => send({ type: 'response', id: r.id, command: r.type, success: true, data });
  switch (r.type) {
    case 'get_state':
      reply({
        sessionId,
        sessionFile,
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        future_native_field: { retained: true },
      });
      break;
    case 'get_entries':
      reply({ entries: r.since ? entries.slice(entries.findIndex((entry) => entry.id === r.since) + 1) : entries });
      break;
    case 'switch_session': {
      sessionFile = r.sessionPath;
      const saved = JSON.parse(readFileSync(sessionFile, 'utf8'));
      sessionId = saved.sessionId;
      entries = saved.entries;
      reply({ cancelled: false });
      break;
    }
    case 'prompt':
      entries.push({
        id: `entry-${entries.length + 1}`,
        type: 'message',
        message: { role: 'user', content: r.message },
      });
      save();
      reply({ nativeReceipt: { accepted: true } });
      send({
        type: 'extension_ui_request',
        id: 'native-ui-1',
        method: 'confirm',
        title: 'Synthetic native question',
        future_native_field: { retained: true },
      });
      break;
    case 'extension_ui_response':
      send({ type: 'agent_end', messages: [] });
      send({ type: 'agent_settled', aborted: false, nativeAnswer: r });
      break;
    case 'abort':
      reply({ interrupted: true });
      break;
    default:
      send({ type: 'response', id: r.id, command: r.type, success: false, error: 'unknown synthetic command' });
  }
});
