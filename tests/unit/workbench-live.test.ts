import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { fileURLToPath } from 'node:url';
import { buildSubagentTree } from '../../src/collectors/subagent-tree.js';
import { PanelJobPipeline } from '../../src/tree-page.js';
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';
import { settingsPath } from '../../src/settings.js';

const hasPython = process.platform !== 'win32' && spawnSync('python3', ['--version']).status === 0;
test('live PTY: navigation, diff, zoom, resize, wheel and terminal cleanup', { skip: !hasPython }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-workbench-pty-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => exec('git', args, { cwd: repo });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'HUD test');
  await git('config', 'user.email', 'hud@example.invalid');
  fs.writeFileSync(path.join(repo, 'sample.ts'), 'before\n');
  await git('add', 'sample.ts');
  await git('commit', '-m', 'initial');
  // A second worktree: the changes list then heads its files with the two.
  await git('worktree', 'add', '-b', 'docs', path.join(dir, 'docs'));
  fs.writeFileSync(path.join(repo, 'sample.ts'), 'after\n');
  const now = new Date();
  const sessions = path.join(dir, 'sessions');
  const day = path.join(
    sessions,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(day, { recursive: true });
  const line = (type: string, payload: object, offset = 0) =>
    JSON.stringify({ timestamp: new Date(now.getTime() + offset).toISOString(), type, payload }) + '\n';
  const file = (id: string) => path.join(day, `rollout-${now.toISOString().slice(0, 10)}T00-00-00-${id}.jsonl`);
  fs.writeFileSync(
    file('aaaa'),
    line('session_meta', { id: 'root', cwd: repo, timestamp: now.toISOString() }) +
      line('event_msg', { type: 'plan_update', plan: [{ step: 'Verify workbench', status: 'in_progress' }] })
  );
  for (let i = 0; i < 14; i++)
    fs.writeFileSync(
      file(`bb${i.toString(16).padStart(2, '0')}`),
      line('session_meta', {
        id: `agent-${i.toString().padStart(2, '0')}`,
        cwd: repo,
        parent_thread_id: 'root',
        timestamp: now.toISOString(),
      }) +
        line('event_msg', { type: 'task_started' }) +
        line('event_msg', { type: 'agent_message', message: `FOUND_THE_CAUSE_${i}` }, 50) +
        line('turn_context', { model: 'gpt-test', effort: 'high' })
    );
  // q12: prove overflow using these real rollout files and the production Work renderer, not assumed card heights.
  const listed = fs.readdirSync(day).map((name) => {
    const full = path.join(day, name),
      stat = fs.statSync(full),
      meta = JSON.parse(fs.readFileSync(full, 'utf8').split('\n')[0]);
    return { path: full, sessionId: String(meta.payload.id), timestamp: now, size: stat.size, modifiedAt: stat.mtime };
  });
  const native = buildSubagentTree('root', [], 3, now.getTime(), listed);
  assert.equal(native.nodes.length, 14);
  const pipeline = new PanelJobPipeline(dir, 'synthetic/pty-overflow', { live: false, now: () => now.getTime() }, repo);
  try {
    await pipeline.refresh();
    const composition = pipeline.compose(native, null, now.getTime());
    const frame = renderMonitor({
      tree: composition.tree,
      workboard: pipeline.workboard(composition.tree),
      state: { ...initialMonitorState(), mainTab: 'work' },
      width: 30,
      height: 20,
      nowMs: now.getTime(),
    });
    const pane = frame.panes.find((p) => p.id === 'agents')!;
    assert.ok(pane.contentLength > pane.height, `q12 requires real overflow: ${pane.contentLength}>${pane.height}`);
  } finally {
    pipeline.dispose();
  }
  const script = String.raw`
import os, pty, subprocess, fcntl, termios, struct, select, time, signal, re, sys
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 34, 30, 0, 0))
proc = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env=os.environ.copy(), start_new_session=True)
os.close(slave)
pending = b''
terminal = b''
ansi = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
def screen_text():
 # Reconstruct rows from completed cursor-positioned writes, including erasures.
 # Output is incremental: concatenating stripped PTY bytes retains obsolete rows.
 rows = {}
 for match in re.finditer(rb'\x1b\[(\d+);1H\x1b\[0m(.*?)\x1b\[0m\x1b\[K', terminal, re.S):
  rows[int(match[1])] = ansi.sub('', match[2].decode('utf-8','replace'))
 height = struct.unpack('HHHH', fcntl.ioctl(master, termios.TIOCGWINSZ, b'\0'*8))[0]
 return '\n'.join(rows.get(i,'') for i in range(1,height+1))
def wait_for(text, timeout=8):
 global pending, terminal
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  if pending and text in screen_text() and not select.select([master],[],[],0.05)[0]:
   result=screen_text().encode(); pending=b''; return result
  if select.select([master],[],[],0.1)[0]:
   try:
    chunk = os.read(master,262144)
    pending += chunk
    terminal += chunk
   except OSError: break
 raise AssertionError('Missing '+repr(text)+'; output='+repr(pending[-4000:]))
def send(keys):
 global pending
 pending=b''
 os.write(master,keys)
try:
 screen=wait_for('agent-00')
 plain=ansi.sub('', screen.decode('utf-8','replace'))
 assert 'FOUND_THE_CAUSE' not in plain, 'monitor must not show reply text'
 assert 'Checks' not in plain and 'Reports' not in plain
 # Concept §15, approved Home/Work layout (R5-UX-PLAN q2): live never lands on stacked Agents.
 assert 'Home' in plain and 'Work' in plain and '▸14' not in plain
 send(b'\r')
 wait_for('[Work]')
 # Work Enter is inert; the native worker is inspected with v instead.
 send(b'j\rv')
 inspect=wait_for('Turn age:')
 assert b'\\x1b[' not in inspect, 'Inspector must not print escaped colour codes'
 send(b'\x1b')
 wait_for('[Work]')
 # q12: compact native lanes fit the old 34-row window; use an explicitly overflowing window for this case only.
 fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',20,30,0,0))
 os.kill(proc.pid,signal.SIGWINCH)
 wait_for('[Work]')
 send(b'G')
 wait_for('agent-13')
 # Wheel changes the real Work viewport (SGR coordinates are one-based).
 send(b'\x1b[<64;3;3M')
 wait_for('agent-12')
 fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',34,30,0,0))
 os.kill(proc.pid,signal.SIGWINCH)
 wait_for('[Work]')
 # Changes remains a secondary view; its worktree/file and zoom paths are unchanged.
 send(b'3')
 wait_for('1 mod')
 send(b'z')
 zoom=wait_for('sample.ts')
 assert '▸14'.encode() not in zoom, 'zoom must hide other panes'
 send(b'\x1b')
 wait_for('1 mod')
 fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0))
 os.kill(proc.pid,signal.SIGWINCH)
 wait_for('sample.ts')
 send(b'\r')
 zoom=wait_for('after')
 assert '▸14'.encode() not in zoom.rsplit(b'\x1b[H',1)[-1], 'opening diff must zoom automatically'
 send(b'z')
 wait_for('▸14')
 send(b'z')
 zoom=wait_for('after')
 assert '▸14'.encode() not in zoom, 'wide zoom must hide other panes'
 send(b'\x1b')
 wait_for('[Work]')
 send(b'4')
 wait_for('Inspector')
 send(b',')
 wait_for('Display')
 send(b'l')
 wait_for('titanium')
 send(b's')
 wait_for('Saved')
 send(b'\x1b')
 wait_for('Turn age:')
 send(b'\x1b')
 wait_for('[Work]')
 send(b'1')
 wait_for('[Home]')
 fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',12,16,0,0))
 os.kill(proc.pid,signal.SIGWINCH)
 wait_for('Home')
 send(b'?')
 wait_for('Shortcuts')
 # The legend is the help's third page: Tab twice, then its end.
 send(b'\t\t')
 wait_for('evidence')
 send(b'G')
 wait_for('ultra')
 send(b'\x1b')
 wait_for('Home')
 send(b'q')
 tail=b''
 end=time.monotonic()+3
 while time.monotonic()<end:
  if select.select([master],[],[],0.1)[0]:
   try: tail += os.read(master,262144)
   except OSError: break
  if proc.poll() is not None: break
 proc.wait(timeout=3)
 assert proc.returncode==0, proc.returncode
 assert b'\x1b[?1000l' in tail and b'\x1b[?1006l' in tail, 'mouse tracking must be disabled'
 print('PTY monitor flow passed')
finally:
 if proc.poll() is None: proc.kill(); proc.wait()
 os.close(master)
`;
  try {
    const entry = fileURLToPath(new URL('../../src/tree-page.js', import.meta.url));
    const privateSettings = path.join(dir, 'hud-settings.json'),
      oldSettings = process.env.HUD_SETTINGS_PATH;
    process.env.HUD_SETTINGS_PATH = privateSettings;
    try {
      assert.ok(
        settingsPath().startsWith(dir + path.sep),
        'PTY settings must resolve inside its private directory before saving'
      );
    } finally {
      if (oldSettings === undefined) delete process.env.HUD_SETTINGS_PATH;
      else process.env.HUD_SETTINGS_PATH = oldSettings;
    }
    const result = await exec('python3', ['-c', script, process.execPath, entry], {
      env: {
        ...process.env,
        HOME: dir,
        HUD_HOME: dir,
        CODEX_HUD_STANDALONE_PANEL: '1',
        CODEX_HUD_CWD: repo,
        CODEX_SESSIONS_PATH: sessions,
        CODEX_HOME: dir,
        HUD_SETTINGS_PATH: privateSettings,
        CODEX_HUD_SETTINGS_PATH: privateSettings,
        CODEX_HUD_MAIN_PANE: '',
        CODEX_HUD_SESSION_START: '',
        CODEX_HUD_TOGGLE_CMD: '',
        TERM: 'xterm-256color',
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.match(result.stdout, /PTY monitor flow passed/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'hud-settings.json'), 'utf8')).theme, 'titanium');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
