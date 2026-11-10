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
const header = { type: 'session', version: 3, id: contract.session_id, cwd: contract.cwd };
put(join(dirname(path), 'owner.json'), {
  schema: 1,
  ready: true,
  session_header: { type: 'session', id: contract.session_id, cwd: contract.cwd },
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
process.on('message', async (message) => {
  if (message.type === 'quit') {
    clearInterval(keepAlive);
    process.exit(0);
  }
  if (message.type !== 'prompt') return;
  if (!fs.existsSync(session)) put(session, message.mode === 'header-mismatch' ? { ...header, id: 'wrong' } : header);
  fs.appendFileSync(
    session,
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: message.text }] } }) +
      '\n'
  );
  const orphan = message.mode?.startsWith('orphan-child');
  if (orphan && contract.role === 'sonic') {
    process.send?.({ type: 'submitted' });
    return;
  }
  if ((message.mode === 'nested-sonic' || orphan) && contract.role !== 'sonic') {
    for (let n = 0; n < 100; n++) {
      const j = JSON.parse(fs.readFileSync(join(dirname(path), 'launch.json'), 'utf8'));
      if (j.steps.prompt?.state === 'acked') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const { callHelper } = await import(process.env.OWNED_HELPERS_MODULE);
    const { createHash } = await import('node:crypto');
    const resources = {};
    for (const relative of [
      'integrations/pi/worker.ts',
      'integrations/pi/skills/helper-pane/SKILL.md',
      ...['implementer', 'sonic', 'reviewer', 'architect'].map((r) => `integrations/pi/roles/${r}.md`),
    ])
      resources[relative] = createHash('sha256')
        .update(fs.readFileSync(join(contract.release.root, relative)))
        .digest('hex');
    const context = { jobDirectory: contract.task_dir, cwd: contract.cwd, release: { ...contract.release, resources } };
    const binding = JSON.parse(fs.readFileSync(join(contract.task_dir, '.dispatch/runtime.json'), 'utf8'));
    const request =
      contract.role === 'implementer'
        ? { kind: 'reviewer' }
        : { kind: 'sonic', brief_path: join(contract.task_dir, 'sonic-source.md') };
    const pending = callHelper(
      context,
      { ...binding, env: process.env, callerSlot: contract.slot, budgetMs: 10000, waitingHelper: async () => {} },
      request
    );
    if (orphan && contract.role === 'reviewer') {
      void pending.catch(() => {});
      const childJournal = join(contract.task_dir, '.dispatch/sonic-1/launch.json');
      for (let n = 0; n < 1000; n++) {
        if (
          fs.existsSync(childJournal) &&
          JSON.parse(fs.readFileSync(childJournal, 'utf8')).steps.prompt?.state === 'acked'
        )
          break;
        await new Promise((r) => setTimeout(r, 10));
      }
      if (message.mode === 'orphan-child-unknown')
        await new Promise((resolve) => {
          const ack = (m) => {
            if (m.type === 'orphan_fault_acked') {
              process.off('message', ack);
              resolve();
            }
          };
          process.on('message', ack);
          process.send?.({ type: 'orphan_fault' });
        });
      if (message.mode === 'orphan-child-crash') process.exit(0);
      // The child remains live; simulate a reviewer ending without its shutdown hook.
      message.mode = message.mode === 'orphan-child-failed' ? 'orphan-failed' : 'orphan-closed';
    } else {
      const answer = await pending;
      put(join(dirname(path), 'helper-outcome.json'), answer);
      if (!answer.ok) {
        process.send?.({ type: 'helper_failed', answer });
        return;
      }
    }
  }
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
        model: message.mode === 'wrong-model' ? 'wrong/model' : contract.model,
        thinking: message.mode === 'wrong-effort' ? 'off' : contract.effort,
        output_path: contract.output_path,
        output_written: message.mode !== 'missing-output',
        state: message.mode === 'orphan-failed' ? 'failed' : 'closed',
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
