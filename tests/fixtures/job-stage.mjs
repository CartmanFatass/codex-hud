import * as fs from 'node:fs';
import { join } from 'node:path';

const line = (event) => JSON.stringify(event) + '\n';
const pi = (name, args) => line({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name, arguments: args }] } });
const piStdout = (toolName, args) => line({ type: 'tool_execution_start', toolName, args });
const claude = (name, input) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });
const codex = (name, args) => line({ type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args) } });
const agy = (name, parameters) => line({ event: 'step_update', step_update: { tool_info: { name, parameters } } });

// [relative log path, first record (read), appended record (edit), appended record (test)]
export const transcripts = {
  pi: ['sessions/pi.jsonl', pi('read', { path: '图.ts' }), pi('edit', { path: '图.ts' }), pi('bash', { command: 'npm run build' })],
  'pi-headless': ['stdout.jsonl', piStdout('grep', { pattern: 'synthetic' }), piStdout('write', { path: 'b.ts' }), piStdout('bash', { command: 'node --test' })],
  claude: ['sessions/claude.jsonl', claude('Glob', { pattern: '*.ts' }), claude('Edit', { file_path: 'b.ts' }), claude('Bash', { command: 'npm test' })],
  'claude-headless': ['stdout.jsonl', claude('Grep', { pattern: 'synthetic' }), claude('Write', { file_path: 'c.ts' }), claude('Bash', { command: 'npm run check:fixtures' })],
  codex: ['sessions/codex.jsonl', codex('exec_command', { cmd: 'git diff' }), codex('apply_patch', {}), codex('exec_command', { cmd: 'cargo test' })],
  'agy-headless': ['stdout.jsonl', agy('read_file', { Path: 'c.ts' }), agy('write_to_file', { Path: 'c.ts' }), agy('run_command', { CommandLine: 'pnpm test' })],
};

export const scope = { project: null, pane: 'synthetic:p1' };
export function stageJob(home, i, format, ix = 1) {
  const [log, ...records] = transcripts[format] ?? ['sessions/missing.jsonl'];
  const id = `j${String(i).padStart(16, '0')}`, dir = join(home, 'jobs', id), path = join(dir, log);
  const headless = format.endsWith('-headless'), harness = format.startsWith('pi') ? 'pi' : 'cli';
  fs.mkdirSync(join(path, '..'), { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), line({ job: id, role: 'imp', headless, harness, herdr_pane: scope.pane, created_at: new Date().toISOString() }));
  fs.writeFileSync(join(dir, 'STATUS.json'), line({ state: 'working', harness, agent: format.split('-')[0] }));
  if (records[ix - 1]) fs.writeFileSync(path, records[ix - 1]);
  return { id: `thin-job:${id}`, dir, path, records };
}
