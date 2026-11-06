#!/usr/bin/env python3
"""Exercise real terminal input and restoration using only the synthetic lab."""
import os, pty, select, subprocess, termios, time
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
proc = subprocess.Popen(['node', 'scripts/workbench/unified.mjs'], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
output = bytearray()
try:
    deadline = time.monotonic() + 50
    while time.monotonic() < deadline and b'SIMULATED unified HUD' not in output:
        ready, _, _ = select.select([master], [], [], 0.25)
        if ready:
            try: output.extend(os.read(master, 65536))
            except OSError: break
        if proc.poll() is not None: break
    assert b'SIMULATED unified HUD' in output, output[-3000:].decode(errors='replace')
    for key in [b'j', b'c', b'i', b'l', b'q']:
        os.write(master, key); time.sleep(0.25)
    deadline = time.monotonic() + 40
    while proc.poll() is None and time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.25)
        if ready:
            try: output.extend(os.read(master, 65536))
            except OSError: break
    proc.wait(timeout=1)
    while select.select([master], [], [], 0)[0]:
        try: output.extend(os.read(master, 65536))
        except OSError: break
    assert proc.returncode == 0, output[-3000:].decode(errors='replace')
    for text in [b'SIMULATED Codex', b'SIMULATED Pi', b'Cancellation request:', b'Owned run stdout']:
        assert text in output, text
    # The canonical Agents rows precede the ordinary observation and Inspector.
    agents = output.split(b'Ordinary Pi observation:', 1)[0]
    assert b'main' in agents and b'SIMULATED Jev' in agents, agents[-3000:]
    assert b'SIMULATED Jobs' not in output
    after = termios.tcgetattr(slave)
    assert before[3] & (termios.ICANON | termios.ECHO) == after[3] & (termios.ICANON | termios.ECHO)
    print('PASS: interactive selection/cancel/inspector/log keys, quit and terminal mode restoration')
finally:
    if proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=40)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    os.close(master); os.close(slave)
