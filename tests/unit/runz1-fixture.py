"""Synthetic Linux process fixtures. Keep every child unreaped until explicit cleanup."""
import ctypes
import json
import os
import signal
import sys
import threading
import time

root, mode = sys.argv[1:]
libc = ctypes.CDLL(None)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise RuntimeError("subreaper unavailable")


def mark(name, value="ready"):
    with open(os.path.join(root, name), "w") as out:
        out.write(str(value))


def owned():
    mark("owned-" + str(os.getpid()), os.getpid())


def wait(name):
    deadline = time.monotonic() + 60
    while not os.path.exists(os.path.join(root, name)):
        if time.monotonic() > deadline:
            os._exit(91)
        time.sleep(0.001)


def idle():
    while True:
        signal.pause()


leader = os.fork()
if leader == 0:
    owned()
    if mode == "visible":
        os.setpgid(0, 0)
    else:
        os.setsid()
    leader = os.getpid()
    if mode in ("fork", "escape", "join", "pair"):
        worker = os.fork()
        if worker == 0:
            owned()
            if mode == "join":
                os.setpgid(0, 0)
            mark("worker", os.getpid())
            if mode == "pair":
                wait("terminate")
                os._exit(0)
            wait("step1")
            if mode == "join":
                os.setpgid(0, leader)
                mark("step1-done")
                idle()
            child = os.fork()
            if child == 0:
                owned()
                mark("child", os.getpid())
                if mode == "escape":
                    wait("step2")
                    grandchild = os.fork()
                    if grandchild == 0:
                        owned()
                        mark("grandchild", os.getpid())
                        idle()
                    os.setsid()
                    wait("grandchild")
                    mark("step2-done")
                idle()
            wait("child")
            mark("step1-done")
            os._exit(0)
        wait("worker")
    if mode == "escaped-thread":
        writer = os.fork()
        if writer == 0:
            owned()
            os.setsid()
            def live_writer_thread():
                mark("writer-tid", threading.get_native_id())
                idle()
            threading.Thread(target=live_writer_thread).start()
            wait("writer-tid")
            mark("writer", os.getpid())
            wait("writer-terminate")
            libc.pthread_exit(None)
        wait("writer")
    if mode == "thread":
        def live_thread():
            mark("tid", threading.get_native_id())
            idle()
        threading.Thread(target=live_thread).start()
        wait("tid")
    mark("leader", leader)
    wait("terminate")
    if mode == "thread":
        libc.pthread_exit(None)
    os._exit(0)

wait("leader")
print(json.dumps({"leader": leader, "driver": os.getpid()}), flush=True)
reaped = set()
try:
    for line in sys.stdin:
        if line.strip() == "reap":
            os.waitpid(leader, 0)
            reaped.add(leader)
            mark("reaped")
        elif line.strip() == "reap-all":
            while True:
                try:
                    pid, _ = os.waitpid(-1, 0)
                    reaped.add(pid)
                except ChildProcessError:
                    break
            mark("reaped-all")
        elif line.strip() == "cleanup":
            break
finally:
    # All fixtures either remain alive or are unreaped descendants of this subreaper.
    # Killing exact owned PIDs before waiting prevents any numeric reuse during cleanup.
    for name in os.listdir(root):
        if name.startswith("owned-") and int(name[6:]) not in reaped:
            try:
                os.kill(int(name[6:]), signal.SIGKILL)
            except ProcessLookupError:
                pass
    while True:
        try:
            os.waitpid(-1, 0)
        except ChildProcessError:
            break
