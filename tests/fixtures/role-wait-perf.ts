import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext } from 'node:test';
import { main } from '../../src/cli/hud.js';

const JOB = 'j0123456789abcdef';
function fixture(t: TestContext, dispatch = false) {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-wait-')));
  fs.chmodSync(home, 0o700);
  const directory = join(home, 'jobs', JOB);
  const bin = join(home, 'bin');
  fs.mkdirSync(join(directory, 'qa'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin);
  const receipt = {
    schema: 1,
    job: JOB,
    role: 'imp',
    phase: null,
    state: 'open',
    prompted: true,
    binding: { executor: 'herdr', harness: 'pi' },
    executor: { kind: 'herdr', agent: 'synthetic-agent' },
    ...(dispatch
      ? {
          pi_dispatch: {
            contract_version: 1,
            role: 'implementer',
            executable: '/synthetic/pi-dispatch',
            reaper: '/synthetic/pi-role-reap',
            launch: 'acked',
          },
        }
      : {}),
  };
  fs.writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
  const status = {
    version: 1,
    task_dir: directory,
    slot: 'primary',
    role: 'implementer',
    output_path: join(directory, 'report.md'),
    state: 'working',
    output_written: false,
    session_id: 'synthetic-session',
    model: null,
    thinking: null,
    error: null,
    exit_reason: null,
    settled_at: null,
    idle_deadline_at: null,
    ended_at: null,
    helper_pending: null,
  };
  if (dispatch) fs.writeFileSync(join(directory, 'STATUS.json'), JSON.stringify(status));
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.WAIT_LOG) require('node:fs').appendFileSync(process.env.WAIT_LOG, JSON.stringify(args)+'\\n');
if (args[1] === 'get') { console.log(JSON.stringify({result:{agent:{agent_status:'working'}}})); }
else if (process.env.WAIT_MODE === 'hang') { setInterval(()=>{},1000); }
else if (process.env.WAIT_MODE === 'malformed') { console.error('not JSON: timeout'); process.exitCode=1; }
else if (process.env.WAIT_MODE === 'oversized') { console.error(' '.repeat(5000)+JSON.stringify({error:{code:'timeout'}})+'x'); process.exitCode=1; }
else if (process.env.WAIT_MODE === 'multiline') { console.error(JSON.stringify({error:{code:'timeout'}})+'\\n{}'); process.exitCode=1; }
else if (process.env.WAIT_MODE) { console.error(JSON.stringify({error:{code:process.env.WAIT_MODE,message:'synthetic'},id:'cli:agent:wait'})); process.exitCode=1; }
else { console.log(JSON.stringify({result:{agent:{agent_status:'idle'}}})); }
`;
  fs.writeFileSync(join(bin, 'herdr'), script, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    HUD_HOME: home,
    PATH: bin,
    WAIT_LOG: join(home, 'argv.log'),
    PI_CODING_AGENT_DIR: join(home, 'pi'),
    PI_ROLES_LEDGER: join(home, 'ledger'),
  };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = async (args: string[] = ['--job', JOB, '--timeout-ms', '0']) => {
    let stdout = '',
      stderr = '';
    const code = await main(['wait', ...args], {
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, value: stdout ? JSON.parse(stdout) : null, stderr };
  };
  return { home, directory, bin, env, receipt, status, run };
}
export { JOB, fixture };
