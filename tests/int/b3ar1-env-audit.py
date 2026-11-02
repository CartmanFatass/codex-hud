"""Linux x86_64 ptrace is a test instrument, never a runtime dependency.
Stop each owned descendant at exec, and every env syscall including failed exec.
/proc cmdline is observed before env can run and throughout its expansion/exec.
"""
import ctypes
import json
import os
import signal
import sys

libc = ctypes.CDLL(None, use_errno=True)
TRACEME, CONT, SYSCALL, SETOPTIONS = 0, 7, 24, 0x4200
OPTIONS = 1 | 2 | 4 | 8 | 16 | 0x00100000  # TRACESYSGOOD/FORK/VFORK/CLONE/EXEC/EXITKILL
sentinel = b'synthetic-private-sentinel-92386'
original_name = b'SYNTHETIC.SECRET'
expected = {
    'SYNTHETIC.SECRET': sentinel.decode(), '-u': 'x', '--': 'y', '-i': 'z',
    'HUD_ENV_0': 'original-collision', 'PWD': '/synthetic/pwd',
    'BASH_FUNC_synthetic_fn%%': '() { printf synthetic; }',
    'SYNTHETIC_ADVERSARIAL': '${HUD_ENV_0} $ \\c \\n \\_ # \' " =\n ', 'SYNTHETIC_EMPTY': '',
}
expected_bytes = sorted((k + '=' + v).encode() for k, v in expected.items())
def ptrace(request, pid, data=0):
    rc = libc.ptrace(request, pid, None, ctypes.c_void_p(data))
    if rc == -1:
        err = ctypes.get_errno()
        if err != 3: raise OSError(err, os.strerror(err))
    return rc

def observe(pid):
    raw = open('/proc/%d/cmdline' % pid, 'rb').read()
    assert sentinel not in raw and original_name not in raw, 'original environment leaked through argv'
    return raw

pid = os.fork()
if pid == 0:
    ptrace(TRACEME, 0)
    os.kill(os.getpid(), signal.SIGSTOP)
    os.execv(sys.argv[1], [sys.argv[1], sys.argv[2], *sys.argv[3:]])
active = {pid}
stepping = set()
counts = {'leaderExecs': 0, 'envExecs': 0, 'envSyscallStops': 0, 'harnessExecs': 0, 'failedExecPhaseExits': 0, 'failedENOENTSyscalls': 0}
class Registers(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in 'r15 r14 r13 r12 rbp rbx r11 r10 r9 r8 rax rcx rdx rsi rdi orig_rax rip cs eflags rsp ss fs_base gs_base ds es fs gs'.split()]
node = os.path.realpath(sys.argv[1])
shell = os.path.realpath('/bin/bash' if len(sys.argv) > 3 and sys.argv[3].startswith('bash-') else '/bin/sh')
while active:
    who, status = os.waitpid(-1, 0x40000000)  # __WALL: tracked Node threads too
    if os.WIFEXITED(status) or os.WIFSIGNALED(status):
        if who in stepping: counts['failedExecPhaseExits'] += 1
        active.discard(who)
        stepping.discard(who)
        if who == pid: assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, 'driver failed'
        continue
    if not os.WIFSTOPPED(status): continue
    active.add(who)
    stop = os.WSTOPSIG(status)
    event = status >> 16
    if event == 4:
        raw = observe(who)
        exe = os.path.realpath('/proc/%d/exe' % who)
        if exe == '/usr/bin/env':
            counts['envExecs'] += 1
            stepping.add(who)
        else:
            stepping.discard(who)
        if exe == shell:
            counts['leaderExecs'] += 1
        if exe == node and who != pid:
            counts['harnessExecs'] += 1
            actual = sorted(open('/proc/%d/environ' % who, 'rb').read().rstrip(b'\0').split(b'\0'))
            assert actual == expected_bytes, 'harness environment is not byte-identical'
            for fd in range(3, 8):
                assert not os.path.lexists('/proc/%d/fd/%d' % (who, fd)), 'private helper FD reached harness exec'
    if stop == (signal.SIGTRAP | 0x80):
        raw = observe(who)
        counts['envSyscallStops'] += 1
        registers = Registers()
        assert libc.ptrace(12, who, None, ctypes.byref(registers)) == 0
        if registers.orig_rax == 59 and ctypes.c_longlong(registers.rax).value == -2 and b'/synthetic/exec-will-fail' in raw:
            counts['failedENOENTSyscalls'] += 1
    ptrace(SETOPTIONS, who, OPTIONS)
    deliver = 0 if stop in (signal.SIGSTOP, signal.SIGTRAP, signal.SIGTRAP | 0x80) else stop
    # ptrace wrapper's fourth parameter is the delivered signal here.
    ptrace(SYSCALL if who in stepping else CONT, who, deliver)
assert counts['leaderExecs'] == 2, counts
assert counts['envExecs'] >= 4, counts  # preflight env twice and two workload envs
assert counts['harnessExecs'] == 1, counts
assert counts['failedExecPhaseExits'] >= 1, counts
assert counts['envSyscallStops'] > 0, counts
assert counts['failedENOENTSyscalls'] == 1, counts
print(json.dumps(counts, sort_keys=True))
