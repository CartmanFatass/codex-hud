// Capability probe: Unix socket, ptrace, /proc/<pid>/task/<tid>/children. Prints raw results, never bypasses.
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = {};
// 1. AF_UNIX listen + connect
await new Promise((resolve) => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  const p = join(dir, 's.sock');
  const srv = net.createServer((c) => { c.end('pong'); });
  srv.on('error', (e) => { out.unix_socket = { ok: false, error: `${e.code} ${e.message}` }; rmSync(dir, { recursive: true, force: true }); resolve(); });
  srv.listen(p, () => {
    const c = net.connect(p);
    let data = '';
    c.on('data', (d) => (data += d));
    c.on('error', (e) => { out.unix_socket = { ok: false, error: `connect ${e.code} ${e.message}` }; srv.close(); resolve(); });
    c.on('end', () => { out.unix_socket = { ok: data === 'pong', path_len: p.length, reply: data }; srv.close(); rmSync(dir, { recursive: true, force: true }); resolve(); });
  });
});
// 2. ptrace: TRACEME in a python child, and PTRACE_ATTACH to an own child (ptrace_scope 1 allows descendants)
const py = `
import ctypes, os, sys, time, signal
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]
pid = os.fork()
if pid == 0:
    r = libc.ptrace(0, 0, None, None)  # PTRACE_TRACEME
    e = ctypes.get_errno()
    print("traceme", r, e, os.strerror(e) if r != 0 else "", flush=True)
    os._exit(0)
os.waitpid(pid, 0)
c = os.fork()
if c == 0:
    time.sleep(5); os._exit(0)
r = libc.ptrace(16, c, None, None)  # PTRACE_ATTACH
e = ctypes.get_errno()
print("attach", r, e, os.strerror(e) if r != 0 else "", flush=True)
if r == 0:
    os.waitpid(c, 0); libc.ptrace(17, c, None, None)  # PTRACE_DETACH
os.kill(c, signal.SIGKILL); os.waitpid(c, 0)
`;
const r = spawnSync('/usr/bin/python3', ['-c', py], { encoding: 'utf8' });
out.ptrace = { status: r.status, stdout: r.stdout.trim().split('\n'), stderr: r.stderr.trim(), ptrace_scope: readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim() };
out.ptrace.ok = /traceme 0 /.test(r.stdout) && /attach 0 /.test(r.stdout);
// 3. /proc/<pid>/task/<tid>/children
const child = spawn('/bin/sleep', ['5']);
await new Promise((res) => setTimeout(res, 100));
try {
  const txt = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8');
  const kids = txt.trim().split(/\s+/).filter(Boolean).map(Number);
  out.proc_children = { ok: kids.includes(child.pid), contents: txt.trim(), expected_child: child.pid };
} catch (e) {
  out.proc_children = { ok: false, error: `${e.code} ${e.message}` };
}
child.kill('SIGKILL');
out.node = process.version;
console.log(JSON.stringify(out, null, 2));
process.exitCode = out.unix_socket?.ok && out.ptrace.ok && out.proc_children.ok ? 0 : 1;
