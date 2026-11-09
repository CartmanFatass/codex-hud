/** Synthetic OS worker, not a dispatcher: owns only its session/owner/STATUS/artifact. */
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
const option = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const path = option('--hud-role-contract');
const contract = JSON.parse(fs.readFileSync(path, 'utf8'));
const journal = JSON.parse(fs.readFileSync(join(dirname(path), 'launch.json'), 'utf8'));
const { readProcess } = await import(process.env.OWNED_PROCESS_MODULE);
const put = (file, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) + '\n';
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const session = join(contract.session_dir, `2000-01-01T00-00-00-000Z_${contract.session_id}.jsonl`);
put(session, { type: 'session', version: 3, id: contract.session_id, cwd: contract.cwd });
put(join(dirname(path), 'owner.json'), {
  schema: 1,
  ready: true,
  job: contract.job,
  slot: contract.slot,
  session_id: contract.session_id,
  session_file: session,
  instance: journal.instance,
  tab_id: journal.tab,
  pane_id: journal.pane,
  agent_name: journal.name,
  process: readProcess(process.pid).stamp,
  model: contract.model,
  effort: contract.effort,
});
const keepAlive = setInterval(() => {}, 60_000);
process.on('message', (message) => {
  if (message.type === 'quit') {
    clearInterval(keepAlive);
    process.exit(0);
  }
  if (message.type !== 'prompt') return;
  fs.appendFileSync(
    session,
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: message.text }] } }) +
      '\n'
  );
  if (message.finish) {
    const output =
      message.mode === 'invalid-verdict'
        ? 'Not a verdict\n'
        : contract.role === 'reviewer'
          ? 'Verdict: accept\nSynthetic independent review.\n'
          : `Synthetic result for ${contract.slot}.\n`;
    if (!['missing-output', 'unchanged-output'].includes(message.mode)) put(contract.output_path, output);
    if (message.mode !== 'unsettled')
      put(contract.slot === 'primary' ? join(contract.task_dir, 'STATUS.json') : join(dirname(path), 'STATUS.json'), {
        version: 1,
        task_dir: contract.task_dir,
        slot: contract.slot,
        role: contract.role,
        session_id: contract.session_id,
        model: contract.model,
        thinking: contract.effort,
        output_path: contract.output_path,
        output_written: message.mode !== 'missing-output',
        state: 'closed',
        helper_pending: null,
        settled_at: new Date().toISOString(),
        idle_deadline_at: null,
        ended_at: new Date().toISOString(),
        exit_reason: 'complete',
        error: null,
      });
    if (message.mode === 'stay-alive') process.send?.({ type: 'idle' });
    if (message.mode !== 'unsettled' && message.mode !== 'stay-alive') setTimeout(() => process.exit(0), 30);
  }
  process.send?.({ type: 'submitted' });
});
process.send?.({ type: 'ready', session });
