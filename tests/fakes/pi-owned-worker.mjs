/** Independent synthetic worker: startup/settlement producer, never part of the fake transport. */
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
const [file, rawAgent] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
const agent = JSON.parse(rawAgent);
const j = JSON.parse(fs.readFileSync(join(dirname(file), 'launch.json'), 'utf8'));
const { readProcess } = await import(process.env.HERDR_FAKE_PROCESS_MODULE);
fs.appendFileSync(process.env.HERDR_FAKE_WORKER_LOG, JSON.stringify(readProcess(process.pid).stamp) + '\n', {
  mode: 0o600,
});
function put(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
put(agent.agent_session.value, JSON.stringify({ type: 'session', id: c.session_id }) + '\n');
put(join(dirname(file), 'owner.json'), {
  schema: 1,
  ready: true,
  job: c.job,
  slot: c.slot,
  role: c.role,
  session_id: c.session_id,
  session_file: agent.agent_session.value,
  model: c.model,
  effort: c.effort,
  herdr_instance: j.instance,
  agent: j.agent,
  tab: j.tab,
  pane: j.pane,
  process: readProcess(process.pid).stamp,
});
function finish() {
  clearInterval(timer);
  process.exit(0);
}
function snapshot(state, output) {
  const now = new Date().toISOString();
  return {
    version: 1,
    task_dir: c.task_dir,
    slot: c.slot,
    role: c.role,
    session_id: c.session_id,
    model: c.model,
    thinking: c.effort,
    output_path: c.output_path,
    output_written: output,
    state,
    helper_pending: null,
    settled_at: state === 'closed' ? now : null,
    idle_deadline_at: null,
    ended_at: state === 'closed' ? now : null,
    exit_reason: state === 'closed' ? 'success' : null,
    error: null,
  };
}
put(
  c.slot === 'primary' ? join(c.task_dir, 'STATUS.json') : join(dirname(file), 'STATUS.json'),
  snapshot('working', false)
);
let ticks = 0;
const timer = setInterval(() => {
  try {
    const state = JSON.parse(fs.readFileSync(process.env.HERDR_FAKE_STATE, 'utf8'));
    const own = state.agents.find((a) => a.name === agent.name);
    // A just-spawned worker may run before start's state commit.
    if (
      !own &&
      ticks++ > 10 &&
      process.env.HERDR_FAKE_KEEP_PRIMARY !== '1' &&
      (c.slot !== 'primary' ||
        !process.env.HERDR_FAKE_SHUTDOWN_WAIT ||
        fs.existsSync(process.env.HERDR_FAKE_SHUTDOWN_WAIT))
    )
      finish();
    if (own && c.slot !== 'primary' && own.agent_status === 'working' && process.env.HERDR_FAKE_HELPER !== 'blocked') {
      const mode = process.env.HERDR_FAKE_HELPER;
      if (mode !== 'missing-output')
        put(
          c.output_path,
          mode === 'bad-verdict'
            ? 'Looks good\n'
            : c.role === 'reviewer'
              ? 'Verdict: accept\nSynthetic review.\n'
              : 'Synthetic helper output.\n'
        );
      if (mode !== 'no-settlement') {
        put(join(dirname(file), 'STATUS.json'), snapshot('closed', true));
        state.agents = state.agents.filter((a) => a.name !== agent.name);
        put(process.env.HERDR_FAKE_STATE, state);
        finish();
      }
    }
  } catch {
    if (!fs.existsSync(file)) finish();
    /* Tests can atomically replace the synthetic inventory. */
  }
}, 10);
process.on('SIGTERM', finish);
