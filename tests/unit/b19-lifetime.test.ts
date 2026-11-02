import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { readProcess, sameStamp } from '../../src/core/run/process.js';
import type { ProcessStamp } from '../../src/core/types/supervision.js';

test('B19 parent guard applies to initialize, ping, list and tools/call before dispatch', async () => {
  for (const method of ['initialize', 'ping', 'tools/list', 'tools/call']) {
    let resolved = false;
    const server = new HudMcpServer(
      {
        resolve: async () => {
          resolved = true;
          throw new Error('unexpected');
        },
      },
      undefined,
      () => false
    );
    const reply: any = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { protocolVersion: '2025-06-18' },
    });
    assert.equal(reply.error.message, 'server_shutdown');
    assert.equal(server.shutdownSignal.aborted, true);
    assert.equal(resolved, false);
  }
});

const python = `
import ctypes,os,subprocess,sys,threading
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
p=subprocess.Popen([sys.argv[1],'tests/int/b19-lifetime.mjs',sys.argv[2]],stdout=subprocess.PIPE)
lock=threading.Lock()
def emit(line):
 with lock: sys.stdout.buffer.write(line);sys.stdout.buffer.flush()
def relay():
 for line in p.stdout: emit(line)
thread=threading.Thread(target=relay);thread.start()
while True:
 try: pid,status=os.waitpid(-1,0)
 except ChildProcessError: break
 emit(('{"reaped":'+str(pid)+'}\\n').encode())
thread.join()
`;
const supported =
  ledgerRuntimeSupported() && process.platform === 'linux' && spawnSync('python3', ['--version']).status === 0;
function launched(root: string) {
  const child = spawn('python3', ['-c', python, process.execPath, root], { stdio: ['pipe', 'pipe', 'pipe'] });
  let data = '';
  let stderr = '';
  const lines: any[] = [];
  const subscribers = new Set<() => void>();
  child.stdout.on('data', (chunk) => {
    data += chunk.toString();
    for (;;) {
      const i = data.indexOf('\n');
      if (i < 0) break;
      const line = data.slice(0, i);
      data = data.slice(i + 1);
      try {
        lines.push(JSON.parse(line));
      } catch {
        /* Node warning is stderr only. */
      }
    }
    for (const callback of subscribers) callback();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const wait = (match: (line: any) => boolean, timeout = 10000): Promise<any> =>
    new Promise((resolve, reject) => {
      const inspect = () => {
        const found = lines.find(match);
        if (found) {
          clearTimeout(timer);
          subscribers.delete(inspect);
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        subscribers.delete(inspect);
        reject(new Error('lifecycle timeout: ' + stderr));
      }, timeout);
      subscribers.add(inspect);
      inspect();
    });
  const send = (id: number) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n');
  return { child, wait, send };
}
function cleanupChild(child: ChildProcessWithoutNullStreams, stamps: ProcessStamp[]) {
  for (const stamp of stamps)
    try {
      const current = readProcess(stamp.pid);
      if (current && sameStamp(current.stamp, stamp)) process.kill(stamp.pid, 'SIGKILL');
    } catch {
      /* Already reaped. */
    }
  child.stdin.destroy();
  if (child.exitCode === null) child.kill('SIGKILL');
}
for (const mode of ['eof', 'on_call', 'timer'] as const)
  test(
    `B19 real hud-mcp ${mode}: EOF/reparented parent with inherited pipe exits and subreaper reaps it`,
    { skip: !supported, timeout: 37000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'b19-life-'));
      const s = launched(root);
      let stamps: ProcessStamp[] = [];
      t.after(() => {
        cleanupChild(s.child, stamps);
        rmSync(root, { recursive: true, force: true });
      });
      const p = await s.wait((line) => typeof line.mcp === 'number');
      stamps = [readProcess(p.harness)?.stamp, readProcess(p.mcp)?.stamp].filter((v): v is ProcessStamp => !!v);
      s.send(1);
      await s.wait((line) => line.id === 1);
      const start = performance.now();
      if (mode === 'eof') s.child.stdin.end();
      else {
        process.kill(p.harness, 'SIGKILL');
        await s.wait((line) => line.reaped === p.harness);
        if (mode === 'on_call') s.send(2);
      }
      await s.wait((line) => line.reaped === p.mcp, mode === 'timer' ? 32000 : 2000);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < (mode === 'timer' ? 32000 : 2000), String(elapsed));
      // Exit has closed the private SQLite connection and all its file descriptors.
      assert.throws(() => process.kill(p.mcp, 0), { code: 'ESRCH' });
      const exited = s.child.exitCode === null ? once(s.child, 'exit') : Promise.resolve();
      await exited;
      t.diagnostic(`${mode} exit/reap ${elapsed.toFixed(2)} ms; no /proc PID or open descriptors remain`);
    }
  );
