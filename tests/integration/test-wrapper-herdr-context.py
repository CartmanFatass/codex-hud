#!/usr/bin/env python3
"""Real isolated tmux server: stale server env must not select another pane."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time
import runpy
import selectors


ROOT = Path(__file__).resolve().parents[2]
KEYS = ("HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID")


def verify_codex_daemon():
    """Exercise the real config and command APIs without making model calls."""
    binary = shutil.which("codex")
    if not binary:
        print("Codex API check: SKIP (codex CLI not installed)")
        return
    command = runpy.run_path(str(ROOT / "bin/codex-with-herdr-context"))["command"]
    contexts = [dict(zip(KEYS, ["1", "new", "new:t1", "new:p1"])), {}]
    for context in contexts:
        with tempfile.TemporaryDirectory(prefix="codex-herdr-api-") as temporary:
            Path(temporary, "config.toml").write_text(
                '[shell_environment_policy]\ninherit="all"\n'
                '[shell_environment_policy.set]\nNODE_USE_ENV_PROXY="1"\n')
            environment = {k: v for k, v in os.environ.items() if not k.startswith("HERDR_")}
            environment.update(CODEX_HOME=temporary, HERDR_ENV="1", HERDR_PANE_ID="old:p9")
            process = subprocess.Popen(command(binary, ["app-server", "--stdio"], context), env=environment,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, text=True, bufsize=1)
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)

            def request(identifier, method, params):
                process.stdin.write(json.dumps({"id": identifier, "method": method, "params": params}) + "\n")
                process.stdin.flush()
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if selector.select(timeout=.2):
                        line = process.stdout.readline()
                        assert line, "app server exited before replying"
                        value = json.loads(line)
                        if value.get("id") == identifier:
                            assert "error" not in value, value
                            return value["result"]
                raise AssertionError("app server response timeout")

            try:
                request(1, "initialize", {"clientInfo": {"name": "herdr-context-regression", "version": "1.0.0"}})
                process.stdin.write('{"method":"initialized"}\n')
                process.stdin.flush()
                config = request(2, "config/read", {"includeLayers": False})
                assert config["config"]["shell_environment_policy"]["set"]["NODE_USE_ENV_PROXY"] == "1"
                script = "import os,json; print(json.dumps({k:os.getenv(k) for k in " + repr(list(KEYS)) + "}))"
                result = request(3, "command/exec", {"command": ["python3", "-c", script], "cwd": temporary,
                                                     "timeoutMs": 10000, "outputBytesCap": 2000})
                assert result["exitCode"] == 0, result
                assert json.loads(result["stdout"]) == {k: context.get(k, "") for k in KEYS}, result
            finally:
                selector.close()
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    print("Codex config/read + command/exec: PASS (stale backend context overridden; outside Herdr cleared)")


def run():
    real_tmux = shutil.which("tmux")
    if not real_tmux:
        raise SystemExit(77)
    with tempfile.TemporaryDirectory(prefix="codex-herdr-") as temporary:
        work = Path(temporary)
        socket = str(work / "tmux.sock")
        scripts = {
            "tmux": f"#!/bin/sh\nexec {shlex.quote(real_tmux)} -S {shlex.quote(socket)} \"$@\"\n",
            "node": '#!/bin/sh\n[ "${1:-}" = --version ] && echo v20.0.0\nexit 0\n',
            "npm": "#!/bin/sh\nexit 0\n",
            "codex": '''#!/usr/bin/env python3
import json,os,sys,time
from pathlib import Path
args=sys.argv[1:]
capture=next(a.split('=',1)[1] for a in args if a.startswith('--capture='))
overrides={}
for i,arg in enumerate(args):
 if arg=='-c':
  key,value=args[i+1].split('=',1)
  overrides[key]=json.loads(value)
Path(capture).write_text(json.dumps({'environment':{k:os.environ.get(k) for k in ['HERDR_ENV','HERDR_WORKSPACE_ID','HERDR_TAB_ID','HERDR_PANE_ID']},'overrides':overrides,'arguments':args}))
time.sleep(60)
''',
        }
        for name, content in scripts.items():
            path = work / name
            path.write_text(content)
            path.chmod(0o755)
        base = {k: v for k, v in os.environ.items() if not k.startswith("HERDR_")}
        base.pop("TMUX", None)
        base.pop("TMUX_PANE", None)
        base.update(PATH=str(work) + os.pathsep + base["PATH"],
                    CODEX_HUD_TREE="0", CODEX_HUD_STATUSLINE="0",
                    CODEX_HUD_HEIGHT="1", CODEX_HUD_HEIGHT_AUTO="0",
                    CODEX_HUD_WINDOWS_DEFER_ATTACH="1")
        stale = dict(zip(KEYS, ["1", "old", "old:t1", "old:p1"]))
        tmux = [real_tmux, "-S", socket]
        subprocess.run([*tmux, "-f", "/dev/null", "new-session", "-d", "-s", "bootstrap", "sleep 60"],
                       env=base | stale, check=True, capture_output=True)
        try:
            contexts = [dict(zip(KEYS, ["1", "A", "A:t1", "A:p1"])),
                        dict(zip(KEYS, ["1", "B", "B:t2", "B:p3"])), {}]
            for i, context in enumerate(contexts):
                capture = work / f"captured-{i}.json"
                result = subprocess.run([str(ROOT / "bin/codex-hud"), "--new-session", f"--capture={capture}"],
                                        cwd=work, env=base | context, text=True, capture_output=True, timeout=30)
                assert result.returncode == 0, result.stderr + result.stdout
                deadline = time.monotonic() + 10
                while not capture.exists() and time.monotonic() < deadline:
                    time.sleep(.05)
                assert capture.exists(), "Codex recorder was not started"
                record = json.loads(capture.read_text())
                assert record["environment"] == {k: context.get(k, "") for k in KEYS}, record
                for key in KEYS:
                    assert record["overrides"]["shell_environment_policy.set." + key] == context.get(key, ""), record
                server_value = subprocess.check_output([*tmux, "show-environment", "-g", "HERDR_PANE_ID"], text=True).strip()
                assert server_value == "HERDR_PANE_ID=old:p1", server_value
            # Values are individual argv entries, not executable shell text.
            capture = work / "quoted.json"
            marker = work / "must-not-exist"
            exotic = 'space " quote \\ newline\n$(touch ' + str(marker) + ')'
            try:
                subprocess.run([str(ROOT / "bin/codex-with-herdr-context"), str(work / "codex"),
                                f"--capture={capture}", "--version"], env=base | contexts[0] | {"HERDR_PANE_ID": exotic},
                               timeout=.5, capture_output=True)
            except subprocess.TimeoutExpired:
                pass  # The recorder deliberately stays alive after saving output.
            record = json.loads(capture.read_text())
            assert record["overrides"]["shell_environment_policy.set.HERDR_PANE_ID"] == exotic
            assert record["arguments"][-1] == "--version"
            assert not marker.exists()
        finally:
            subprocess.run([*tmux, "kill-server"], capture_output=True)
    print("test-wrapper-herdr-context: PASS (two panes, outside Herdr, unchanged global env, quoted argv)")
    verify_codex_daemon()


if __name__ == "__main__":
    run()
