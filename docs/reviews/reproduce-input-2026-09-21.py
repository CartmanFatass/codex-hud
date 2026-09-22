"""Real terminal mouse probe, using the current wrapper's input policy.

No live Codex, user tmux server or system clipboard is touched.
Requires Linux/macOS, python3 and tmux. Prints observations, not pass assertions.
"""
import fcntl
import os
from pathlib import Path
import pty
import select
import shlex
import struct
import subprocess
import tempfile
import termios
import time

repo = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="hud-input-review-") as temp:
    root = Path(temp)
    socket = str(root / "tmux.sock")
    env = dict(os.environ, TERM="xterm-256color")
    env.pop("TMUX", None)
    def tmux(*args):
        return subprocess.check_output(["tmux", "-S", socket, *args], env=env, text=True).strip()

    reader = root / "reader.py"
    reader.write_text('''import os, sys, tty
tty.setraw(0)
if len(sys.argv) > 2: os.write(1, b"\\x1b[?1000h\\x1b[?1006h")
for i in range(100): os.write(1, ("history row %d\\r\\n" % i).encode())
with open(sys.argv[1], "ab", buffering=0) as output:
    while True:
        data = os.read(0, 4096)
        if not data: break
        output.write(data)
''')
    log = root / "input.log"
    command = f"python3 {shlex.quote(str(reader))} {shlex.quote(str(log))}"
    master = None
    client = None
    try:
        main = tmux("-f", "/dev/null", "new-session", "-d", "-s", "probe", "-x", "100", "-y", "30", "-P", "-F", "#{pane_id}", command)
        tmux("set-option", "-t", "probe", "status", "off")
        tmux("set-option", "-t", "probe", "mouse", "on")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        client = subprocess.Popen(["tmux", "-S", socket, "attach-session", "-t", "probe"], stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        def pump(seconds=0.35):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                ready, _, _ = select.select([master], [], [], 0.03)
                if ready:
                    try: os.read(master, 65536)
                    except OSError: break
        def mouse(code, x=5, y=5):
            os.write(master, f"\x1b[<{code};{x};{y}M".encode())
            if code < 64: os.write(master, f"\x1b[<{code};{x};{y}m".encode())
            pump()
        def mode(): return tmux("display-message", "-p", "-t", main, "#{pane_in_mode}")
        pump(0.6)
        mouse(64)
        print("baseline, app mouse off: wheel enters copy mode =", mode())
        if mode() == "1": tmux("send-keys", "-t", main, "-X", "cancel")
        tmux("bind-key", "-T", "root", "F12", "display-message", "CUSTOM_F12")
        print("custom F12 before policy =", tmux("list-keys", "-T", "root", "F12"))

        # Extract the actual function, rather than duplicating its bindings.
        source = (repo / "bin/codex-hud").read_text()
        start = source.index("install_session_input_policy() {")
        end = source.index("\n}\n", start) + 3
        toggle = root / "codex-hud-toggle"
        toggle.write_text("#!/bin/sh\nexit 0\n")
        # Synthetic tmux buffer only; never invoke the real clipboard helper.
        paste = root / "codex-hud-paste"
        paste.write_text('#!/bin/sh\nexec tmux paste-buffer -p -t "$1"\n')
        tmux("set-option", "-t", "probe", "@codex_hud_main_pane", main)
        script = source[start:end] + '\ninstall_session_input_policy probe "$1"\n'
        subprocess.run(["bash", "-c", script, "probe", str(toggle)], env=dict(env, TMUX=f"{socket},0,0"), check=True)
        pump()
        mouse(64)
        print("HUD policy, app mouse off: wheel enters copy mode =", mode())
        print("HUD policy, app mouse off: app bytes =", log.read_bytes().hex())
        print("custom F12 after policy =", tmux("list-keys", "-T", "root", "F12"))

        # Positive control: forwarding succeeds when the application requests mouse.
        tmux("respawn-pane", "-k", "-t", main, command + " mouse")
        pump(0.6)
        log.write_bytes(b"")
        mouse(64)
        print("HUD policy, app mouse on: wheel bytes =", log.read_bytes().hex())
        log.write_bytes(b"")
        tmux("set-buffer", "SYNTHETIC_PASTE")
        mouse(2)
        print("HUD policy, app mouse on: right-click bytes =", log.read_bytes().hex())

        # Route a right-click into the actual Monitor process with synthetic 'q'.
        page_command = "env " + " ".join(shlex.quote(item) for item in [
            f"CODEX_HOME={root}", f"CODEX_HUD_SETTINGS_PATH={root / 'settings.json'}",
            f"CODEX_HUD_CWD={root}", f"CODEX_HUD_MAIN_PANE={main}", "CODEX_HUD_TREE_WIDTH=30",
        ]) + " node " + shlex.quote(str(repo / "dist/tree-page.js"))
        panel = tmux("split-window", "-h", "-l", "30", "-d", "-t", main, "-P", "-F", "#{pane_id}", page_command)
        tmux("set-option", "-t", "probe", "@codex_hud_tree_pane", panel)
        pump(0.8)
        before = tmux("list-panes", "-t", "probe", "-F", "#{pane_id}").splitlines()
        if panel not in before: raise RuntimeError("Monitor did not start; run npm run build first")
        left = int(tmux("display-message", "-p", "-t", panel, "#{pane_left}"))
        tmux("set-buffer", "q")
        mouse(2, left + 5, 5)
        pump(0.5)
        after = tmux("list-panes", "-t", "probe", "-F", "#{pane_id}").splitlines()
        print("right-click panel with clipboard q: panel alive before/after =", panel in before, panel in after)
    finally:
        subprocess.run(["tmux", "-S", socket, "kill-server"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if client is not None:
            try: client.wait(timeout=3)
            except subprocess.TimeoutExpired: client.kill(); client.wait()
        if master is not None: os.close(master)
