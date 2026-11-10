"""Synthetic PTY only: never contacts a terminal multiplexer or a user session."""
import errno
import json
import os
import pty
import select
import sys

argv = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execve(argv[0], argv, os.environ)  # noqa: S606 — test-owned absolute Node argv, never shell input
print('PID=' + str(pid), flush=True)
try:
    while True:
        ready, _, _ = select.select([fd, sys.stdin], [], [], 0.1)
        if sys.stdin in ready:
            data = os.read(sys.stdin.fileno(), 4096)
            if not data:
                break
            os.write(fd, data)
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
finally:
    os.close(fd)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
