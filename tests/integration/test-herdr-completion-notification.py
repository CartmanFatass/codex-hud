#!/usr/bin/env python3
"""Opt-in native Herdr integration: isolated server/PTY + rendered synthetic Codex.

Exercises native SessionStart ownership, actual footer/title output, both layouts,
side-pane focus, notification delivery, old authority migration, and read-only health.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]


def run_layout(tree):
    herdr = shutil.which("herdr")
    real_tmux = shutil.which("tmux")
    with tempfile.TemporaryDirectory(prefix="hud-native-notify-") as temporary:
        work = Path(temporary)
        binaries = work / "bin"
        binaries.mkdir()
        config = work / "config.toml"
        config.write_text('onboarding = false\n[ui.toast]\ndelivery = "off"\ndelay_seconds = 1\n[ui.sound]\nenabled = false\n[update]\nmanifest_check = false\n')
        (binaries / "tmux").write_text(
            '#!/bin/sh\nif [ "$1" = display-message ] && [ -f ' + shlex.quote(str(work / "probe-failure")) +
            ' ]; then echo fixture-timeout >&2; exit 1; fi\nexec ' + shlex.quote(real_tmux) +
            ' -S ' + shlex.quote(str(work / "tmux.sock")) + ' "$@"\n')
        (binaries / "tmux").chmod(0o755)
        fixture = work / "fixture.py"
        fixture.write_text(r'''import json,os,pathlib,socket,time
statefile=pathlib.Path(os.environ['HOME'])/'fixture-state'
params={'pane_id':os.environ['HERDR_PANE_ID'],'source':'herdr:codex','agent':'codex','seq':time.time_ns(),'agent_session_id':'synthetic-native-session'}
def send(method,values):
 c=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);c.settimeout(2);c.connect(os.environ['HERDR_SOCKET_PATH'])
 c.sendall((json.dumps({'id':'fixture-start','method':method,'params':values})+'\n').encode());c.recv(4096);c.close()
# Full-layout case also reproduces an already-applied legacy Working report.
if os.environ.get('FIXTURE_LEGACY_AUTHORITY')=='1':
 send('pane.report_agent',{'pane_id':params['pane_id'],'source':'codex-hud:codex','agent':'codex','state':'working','seq':int(time.time()*1000000)})
send('pane.report_agent_session',params)
last=None
while True:
 state=statefile.read_text().strip() if statefile.exists() else 'idle'
 if state!=last:
  title=('⠋ Synthetic Codex working' if state=='working' else 'Action Required | Synthetic Codex' if state=='blocked' else 'Synthetic Codex idle')
  print('\x1b[2J\x1b[H\x1b]0;'+title+'\x07',end='')
  print('  Synthetic Codex native notification fixture\r\n')
  if state=='working':print('• Working (12s • esc to interrupt)\r\n')
  elif state=='blocked':print('Action Required\r\n  Allow command? [y/n]\r\n')
  else:print('• Synthetic turn completed.\r\n')
  print('› \r\n\r\n  gpt-6.1-sol · 98% context left',flush=True)
  last=state
 time.sleep(.05)
''')
        (binaries / "codex").write_text("#!/bin/bash\nexec -a codex python3 " + shlex.quote(str(fixture)) + "\n")
        (binaries / "codex").chmod(0o755)
        home = work / "codex-home"
        home.mkdir()
        env = {k: v for k, v in os.environ.items() if not k.startswith(("HERDR_", "TMUX", "CODEX_HUD_"))}
        env.pop("CODEX_THREAD_ID", None)
        env.update(HOME=str(work), XDG_CONFIG_HOME=str(work / "config"), XDG_STATE_HOME=str(work / "state"),
                   SHELL="/bin/bash", HISTFILE=os.devnull, TERM="xterm-256color", HERDR_CONFIG_PATH=str(config),
                   PATH=str(binaries) + os.pathsep + env["PATH"], CODEX_HOME=str(home),
                   CODEX_HUD_TREE=str(tree), CODEX_HUD_STATUSLINE="1", CODEX_HUD_AUTO_ATTACH="0",
                   FIXTURE_LEGACY_AUTHORITY=str(tree))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 130, 0, 0))
        process = subprocess.Popen([herdr, "--session", "hud-notify-test"], env=env, stdin=slave,
                                   stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        raw = bytearray()

        def pump(wait=.1):
            if select.select([master], [], [], wait)[0]:
                try:
                    raw.extend(os.read(master, 262144))
                except OSError:
                    pass

        def cli(*args):
            result = subprocess.run([herdr, "--session", "hud-notify-test", *args], env=env,
                                    capture_output=True, text=True, timeout=5)
            if result.returncode:
                raise RuntimeError(result.stderr[:500])
            return json.loads(result.stdout) if result.stdout.lstrip().startswith("{") else result.stdout

        def tmux(*args):
            return subprocess.check_output([real_tmux, "-S", str(work / "tmux.sock"), *args], text=True).strip()

        def until(predicate, message, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                pump()
                try:
                    if predicate():
                        return
                except (RuntimeError, subprocess.CalledProcessError, StopIteration, FileNotFoundError):
                    pass
            raise AssertionError(message)

        def drain(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                pump()

        def output():
            return re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", bytes(raw)).decode("utf-8", "replace")

        def finished():
            return "codex finished" in output() or "codex done" in output()

        def health():
            return next(row for file in (home / "hud" / "herdr").glob("*/*.json")
                        if (row := json.loads(file.read_text()))["mode"] == "native" and row["lifecycle"] == "running")

        try:
            until(lambda: bool(cli("api", "snapshot")), "isolated Herdr server did not start")
            drain(1)
            created = cli("workspace", "create", "--cwd", str(work), "--label", "HUD-Notify-Fixture", "--no-focus")
            pane = created["result"]["root_pane"]["pane_id"]
            cli("pane", "run", pane, shlex.quote(str(ROOT / "bin/codex-hud")) + " --new-session")
            def pane_info():
                return cli("pane", "get", pane)["result"]["pane"]
            def state():
                return pane_info()["agent_status"]
            until(lambda: pane_info().get("agent_session", {}).get("value") == "synthetic-native-session",
                  "native SessionStart was not retained")
            native_session = pane_info()["agent_session"]
            assert native_session["source"] == "herdr:codex"
            if tree:
                # Custom Working before SessionStart remains effective and blocks
                # native idle. Detect it honestly, then release only the old source.
                until(lambda: health()["probe"]["status"] == "mismatch", "old authority mismatch was hidden")
                assert state() == "working"
                cli("pane", "release-agent", pane, "--source", "codex-hud:codex", "--agent", "codex",
                    "--seq", str(int(time.time() * 1000000)))
                assert pane_info()["agent_session"] == native_session
            until(lambda: state() == "idle", "native detector did not establish idle")
            until(lambda: health()["stateMatches"], "native health did not match idle")
            # Successful API reply does not mean a foreign source's state applied.
            cli("pane", "report-agent", pane, "--source", "codex-hud:codex", "--agent", "codex",
                "--state", "blocked", "--seq", str(int(time.time() * 1000000)))
            assert state() == "idle", "native owner unexpectedly accepted foreign lifecycle state"
            session = tmux("list-sessions", "-F", "#{session_name}").splitlines()[0]
            main = tmux("show-option", "-t", session, "-qv", "@codex_hud_main_pane")
            assert tmux("show-option", "-t", session, "-qv", "set-titles") == "on"
            if tree:
                side = tmux("show-option", "-t", session, "-qv", "@codex_hud_tree_pane")
                tmux("select-pane", "-t", side, "-T", "Action Required | wrong pane")
                tmux("select-pane", "-t", side)
                drain(1)
                assert pane_info()["terminal_title"] == "Synthetic Codex idle", "side focus contaminated main title"
            config.write_text(config.read_text().replace('delivery = "off"', 'delivery = "herdr"'))
            assert cli("server", "reload-config")["result"]["status"] == "applied"
            raw.clear()
            (work / "fixture-state").write_text("working")
            until(lambda: state() == "working", "rendered Working footer/title not detected")
            until(lambda: health()["observedState"] == "working" and health()["stateMatches"], "working readback mismatch")
            (work / "fixture-state").write_text("idle")
            until(lambda: state() == "done", "rendered completion not retained as done")
            until(finished, "native finished toast missing")
            drain(6.5)
            assert state() == "done", "read-only observer cleared unseen completion"
            assert health()["nativeState"] == "done"
            print(f"PASS layout={tree}: native SessionStart + actual footer/title + side focus -> done/toast; repeated reads preserve done", flush=True)

            raw.clear()
            (work / "fixture-state").write_text("working")
            until(lambda: state() == "working", "second turn missing")
            # A brief observed completion followed by new work must not replay
            # an obsolete finished toast after the new working state is visible.
            (work / "fixture-state").write_text("idle")
            until(lambda: state() == "done", "rapid idle transition missing")
            (work / "fixture-state").write_text("working")
            until(lambda: state() == "working", "rapid restart missing")
            drain(1.5)
            assert state() == "working", "old completion overrode restarted work"
            assert not finished(), "old completion toast appeared after rapid restart"
            raw.clear()
            (work / "fixture-state").write_text("blocked")
            until(lambda: state() == "blocked", "actual blocked output not detected")
            until(lambda: "needs attention" in output(), "native attention toast missing")
            drain(1.5)
            (work / "fixture-state").write_text("working")
            until(lambda: state() == "working", "probe test working missing")
            until(lambda: health()["observedState"] == "working", "observer working missing")
            (work / "probe-failure").touch()
            until(lambda: health()["probe"]["status"] == "retrying", "probe failure not diagnosed")
            raw.clear()
            (work / "fixture-state").write_text("idle")
            until(lambda: state() == "done", "observer probe failure interrupted native completion")
            until(finished, "observer probe failure interrupted native toast")
            (work / "probe-failure").unlink()
            until(lambda: health()["stateMatches"], "probe recovery did not read latest state")
            print(f"PASS layout={tree}: rapid restart + blocked attention + observer probe failure preserve native completion/toast", flush=True)

            # Disconnect only new API clients. Native detection/TUI keep running;
            # the observer must read current state after recovery without replay.
            (work / "fixture-state").write_text("working")
            until(lambda: state() == "working", "outage baseline missing")
            socket_path = Path(tmux("show-environment", "-t", session, "HERDR_SOCKET_PATH").split("=", 1)[1])
            offline = socket_path.with_name(socket_path.name + ".offline")
            socket_path.rename(offline)
            try:
                until(lambda: health()["transport"]["status"] == "disconnected", "readback outage not diagnosed")
                raw.clear()
                (work / "fixture-state").write_text("idle")
                until(finished, "native completion stalled with observer socket unavailable")
            finally:
                offline.rename(socket_path)
            until(lambda: health()["transport"]["status"] == "connected" and health()["nativeState"] == "done",
                  "native observer did not recover latest completion")
            assert health()["notificationGap"]
            assert pane_info()["agent_session"] == native_session
            # Native observer exit must not release either lifecycle or session.
            observer_pid = health()["bridgePid"]
            os.kill(observer_pid, signal.SIGTERM)
            health_file = home / "hud" / "herdr" / session / f"{observer_pid}.json"
            until(lambda: json.loads(health_file.read_text())["lifecycle"] == "stopped", "observer did not stop")
            assert state() == "done"
            assert pane_info()["agent_session"] == native_session
            print(f"PASS layout={tree}: socket recovery reads latest state; observer exit preserves native session/done", flush=True)
        finally:
            try:
                cli("server", "stop")
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            subprocess.run([real_tmux, "-S", str(work / "tmux.sock"), "kill-server"], capture_output=True)
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            os.close(master)
            # Herdr/tmux termination can briefly outlive the client wait. Wait on
            # the test-owned observer PIDs before TemporaryDirectory removes files.
            for file in (home / "hud" / "herdr").glob("*/*.json"):
                row = json.loads(file.read_text())
                deadline = time.monotonic() + 3
                while row["lifecycle"] == "running" and time.monotonic() < deadline:
                    time.sleep(.05)
                    row = json.loads(file.read_text())


if __name__ == "__main__":
    if os.environ.get("CODEX_HUD_TEST_REAL_HERDR") != "1":
        print("SKIP: set CODEX_HUD_TEST_REAL_HERDR=1 for the isolated real Herdr test")
        raise SystemExit(77)
    if not all(shutil.which(binary) for binary in ("herdr", "tmux", "node", "bash")):
        raise SystemExit(77)
    for layout in (0, 1):
        run_layout(layout)
