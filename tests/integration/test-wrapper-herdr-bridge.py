#!/usr/bin/env python3
"""HUD-only bridge: real isolated tmux/PTY, synthetic Codex and Herdr socket."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import socket
import struct
import subprocess
import tempfile
import termios
import threading
import time

ROOT = Path(__file__).resolve().parents[2]


def run():
    real_tmux = shutil.which("tmux")
    if not real_tmux or not shutil.which("node"):
        raise SystemExit(77)
    with tempfile.TemporaryDirectory(prefix="hud-herdr-bridge-") as temporary:
        work = Path(temporary)
        binaries = work / "bin"
        binaries.mkdir()
        proxy = binaries / "tmux"
        proxy.write_text(f"#!/bin/sh\nif [ \"$1\" = display-message ] && [ -f {shlex.quote(str(work / 'probe-failure'))} ]; then echo 'fixture timeout' >&2; exit 1; fi\nexec {shlex.quote(real_tmux)} -S {shlex.quote(str(work / 'tmux.sock'))} \"$@\"\n")
        proxy.chmod(0o755)
        codex = binaries / "codex"
        codex.write_text("#!/usr/bin/env bash\nprintf '\\033]0;Synthetic Codex | fixture\\007'\nexec -a codex sleep 120\n")
        codex.chmod(0o755)
        home = work / "codex-home"
        home.mkdir()
        environment = {k: v for k, v in os.environ.items() if not k.startswith("HERDR_")}
        for key in ("TMUX", "TMUX_PANE", "CODEX_HUD_WINDOWS_DEFER_ATTACH", "CODEX_HUD_SESSION_NAME_FILE"):
            environment.pop(key, None)
        environment.update(PATH=str(binaries) + os.pathsep + environment["PATH"],
                           TERM="xterm-256color", CODEX_HOME=str(home),
                           CODEX_HUD_TREE="0", CODEX_HUD_STATUSLINE="0",
                           CODEX_HUD_AUTO_ATTACH="0", CODEX_HUD_HERDR_BRIDGE="1")
        tmux_command = [real_tmux, "-S", str(work / "tmux.sock")]

        native_state = "idle"

        def tmux(*args):
            nonlocal native_state
            if args[0] == "select-pane" and "-T" in args:
                title = args[args.index("-T") + 1]
                native_state = "blocked" if "Action Required" in title else "working" if any(c in title for c in "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏") else "idle"
            return subprocess.check_output([*tmux_command, *args], env=environment, text=True).strip()

        records = []
        accepted = []
        disconnected = threading.Event()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(work / "herdr.sock"))
        listener.listen()
        listener.settimeout(.1)
        stopping = threading.Event()

        def receive():
            while not stopping.is_set():
                try:
                    client, _ = listener.accept()
                except socket.timeout:
                    continue
                with client:
                    client.settimeout(2)
                    data = b""
                    try:
                        while b"\n" not in data:
                            chunk = client.recv(4096)
                            if not chunk:
                                break
                            data += chunk
                        request = json.loads(data.split(b"\n", 1)[0])
                        records.append(request)
                        if disconnected.is_set():
                            continue
                        request["observedState"] = native_state
                        accepted.append(request)
                        client.sendall((json.dumps({"id": request["id"], "result": {"pane": {
                            "pane_id": request["params"]["pane_id"], "agent": "codex", "agent_status": native_state}}}) + "\n").encode())
                    except (OSError, ValueError):
                        pass

        receiver = threading.Thread(target=receive, daemon=True)
        receiver.start()
        tmux("-f", "/dev/null", "new-session", "-d", "-s", "bootstrap", "sleep 120")
        tmux("set-environment", "-g", "HERDR_PANE_ID", "stale:p9")
        clients = []
        masters = []
        terminals = {}

        def context(pane):
            return dict(HERDR_ENV="1", HERDR_PANE_ID=pane, HERDR_SOCKET_PATH=str(work / "herdr.sock"))

        def attach(arguments, extra):
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
            terminals[master] = os.ttyname(slave)
            try:
                process = subprocess.Popen([str(ROOT / "bin/codex-hud"), *arguments],
                                           cwd=work, env=environment | extra,
                                           stdin=slave, stdout=slave, stderr=slave)
            finally:
                os.close(slave)
            clients.append(process)
            masters.append(master)
            return process, master

        def pump(master):
            if select.select([master], [], [], .03)[0]:
                try:
                    os.read(master, 65536)
                except OSError:
                    pass

        def wait(predicate, master, message):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if predicate():
                    return
                pump(master)
            raise AssertionError(message)

        def session_attached():
            lines = tmux("list-sessions", "-F", "#{session_name} #{session_attached}").splitlines()
            return next((line.rsplit(" ", 1)[0] for line in lines if line.startswith("codex-hud-") and line.endswith(" 1")), None)

        def has_state(start, pane, state):
            return any(r["params"].get("pane_id") == pane and r.get("observedState") == state
                       for r in records[start:])

        def health(pane):
            files = list((home / "hud" / "herdr").glob("*/*.json"))
            rows = [json.loads(file.read_text()) for file in files]
            return next((row for row in rows if row["herdrPaneId"] == pane and row["lifecycle"] == "running"), None)

        def detach(process, master, session):
            tmux("detach-client", "-t", terminals[master])
            wait(lambda: process.poll() is not None, master, "launcher did not stop after detach")
            assert process.returncode == 0, process.returncode

        try:
            start = len(records)
            process, master = attach(["--new-session"], context("first:p1"))
            wait(lambda: session_attached() is not None, master, "new HUD client never attached")
            session = session_attached()
            wait(lambda: has_state(start, "first:p1", "idle"), master, "initial idle not reported")
            main = tmux("show-option", "-t", session, "-qv", "@codex_hud_main_pane")
            tmux("select-pane", "-t", main, "-T", "⠋ Synthetic activity | fixture")
            wait(lambda: has_state(start, "first:p1", "working"), master, "working not reported")
            # Fail only bridge display-message probes, not test controls or attach.
            (work / "probe-failure").touch()
            wait(lambda: health("first:p1")["probe"]["status"] == "retrying", master,
                 "probe failure missing from health sidecar")
            assert health("first:p1")["publishedState"] == "working"
            before_failure = len(records)
            tmux("select-pane", "-t", main, "-T", "Synthetic complete | fixture")
            (work / "probe-failure").unlink()
            wait(lambda: has_state(before_failure, "first:p1", "idle"), master,
                 "brief probe failure lost subsequent completion")
            assert not has_state(before_failure, "first:p1", "unknown")
            assert health("first:p1")["mode"] == "native"
            assert not health("first:p1")["notificationGap"]
            tmux("select-pane", "-t", main, "-T", "⠋ Synthetic second activity | fixture")
            wait(lambda: has_state(before_failure, "first:p1", "working"), master, "second turn missing")
            completed = len(records)
            tmux("select-pane", "-t", main, "-T", "Synthetic complete | fixture")
            wait(lambda: has_state(completed, "first:p1", "idle"), master, "working to idle completion not reported")
            tmux("select-pane", "-t", main, "-T", "Action Required | fixture")
            wait(lambda: has_state(start, "first:p1", "blocked"), master, "blocked not reported")
            detach(process, master, session)
            assert not health("first:p1"), "detach left a running observer"
            assert all(r["method"] == "pane.get" for r in records), "observer must not write lifecycle state"

            # A deferred session has no attached outer Herdr pane: no bridge yet.
            native_state = "idle"
            session_file = work / "session-name"
            before = len(records)
            result = subprocess.run([str(ROOT / "bin/codex-hud"), "--new-session"], cwd=work,
                                    env=environment | context("creator:p1") | {
                                        "CODEX_HUD_WINDOWS_DEFER_ATTACH": "1",
                                        "CODEX_HUD_SESSION_NAME_FILE": str(session_file)},
                                    capture_output=True, text=True, timeout=30)
            assert result.returncode == 0, result.stderr + result.stdout
            assert len(records) == before, "deferred creation must not start a bridge"
            reused = session_file.read_text().strip()
            process, master = attach(["--attach"], context("reattach:p2"))
            wait(lambda: has_state(before, "reattach:p2", "idle"), master, "reattach used stale creator identity")
            # Simultaneous attaches own separate outer panes and private sidecars.
            second, second_master = attach(["--attach"], context("parallel:p3"))
            wait(lambda: has_state(before, "parallel:p3", "idle"), second_master, "parallel bridge missing")
            assert health("reattach:p2")["bridgePid"] != health("parallel:p3")["bridgePid"]
            detach(second, second_master, reused)
            assert not health("parallel:p3")
            assert health("reattach:p2")["lifecycle"] == "running"

            main = tmux("show-option", "-t", reused, "-qv", "@codex_hud_main_pane")
            tmux("select-pane", "-t", main, "-T", "⠋ Before outage")
            wait(lambda: health("reattach:p2")["publishedState"] == "working", master, "outage baseline missing")
            disconnected.set()
            tmux("select-pane", "-t", main, "-T", "Synthetic offline completion")
            wait(lambda: health("reattach:p2")["transport"]["status"] == "disconnected", master,
                 "socket outage missing from health")
            reconnect_start = len(accepted)
            tmux("select-pane", "-t", main, "-T", "⠋ Latest turn")
            disconnected.clear()
            wait(lambda: health("reattach:p2")["publishedState"] == "working" and
                 health("reattach:p2")["transport"]["status"] == "connected", master, "reconnect failed")
            reconnect_states = [r["observedState"] for r in accepted[reconnect_start:]]
            assert reconnect_states and set(reconnect_states) == {"working"}, reconnect_states
            assert health("reattach:p2")["notificationGap"]
            current = len(accepted)
            tmux("select-pane", "-t", main, "-T", "Synthetic current completion")
            wait(lambda: any(r["observedState"] == "idle" for r in accepted[current:]), master,
                 "new completion missing after reconnect")
            detach(process, master, reused)
            assert not health("reattach:p2")
            tmux("has-session", "-t", reused)  # Attach-only cleanup must preserve it.
            assert all(r["params"]["pane_id"] in ("reattach:p2", "parallel:p3") for r in records[before:])

            for extra in ({}, context("disabled:p1") | {"CODEX_HUD_HERDR_BRIDGE": "0"}):
                before = len(records)
                process, master = attach(["--attach"], extra)
                wait(lambda: session_attached() == reused, master, "disabled client never attached")
                for _ in range(20):
                    pump(master)
                detach(process, master, reused)
                assert len(records) == before, "bridge reported outside Herdr or while disabled"

            assert tmux("show-environment", "-g", "HERDR_PANE_ID") == "HERDR_PANE_ID=stale:p9"
            for record in records:
                assert record["method"] == "pane.get", record
                assert set(record["params"]) == {"pane_id"}, record
                assert "Synthetic" not in json.dumps(record), "title text must not leave the bridge"
            print("test-wrapper-herdr-bridge: PASS (new/parallel attach, probe grace, socket recovery, completion, private health, detach, disabled, stale global env)")
        finally:
            subprocess.run([*tmux_command, "kill-server"], env=environment, capture_output=True)
            for client in clients:
                try:
                    client.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    client.kill()
                    client.wait()
            for master in masters:
                os.close(master)
            stopping.set()
            receiver.join(timeout=3)
            listener.close()


if __name__ == "__main__":
    run()
