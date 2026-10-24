#!/usr/bin/env python3
"""Real terminal acceptance with synthetic session and local mock API only."""
import datetime
import http.server
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
TMUX = shutil.which('tmux')
NODE = shutil.which('node')
if not TMUX or not NODE:
    raise SystemExit(77)

with tempfile.TemporaryDirectory(prefix='hud-diagnostic-ui-') as temporary:
    work = Path(temporary)
    requests = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(request)
            body = json.dumps({'choices': [{'message': {'content': 'OK'}}]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *_args):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config = {
        'briefing': 'api', 'briefingPaused': True, 'briefAgents': False, 'briefMain': False,
        'agentProgress': False, 'agentLabels': False, 'resultDigest': False, 'failureCause': False,
        'changeSummary': False, 'approvalDescription': False, 'language': 'en',
        'briefingApiBase': f'http://127.0.0.1:{server.server_port}/v1',
        'briefingApiKey': 'synthetic-ui-key', 'briefingApiModel': '',
        'briefingApiLiteModel': 'fixture-none', 'briefingApiLowModel': 'fixture-low',
        'briefingApiMediumModel': 'fixture-high', 'refreshMs': 500, 'art': 'off',
    }
    settings = work / 'hud-settings.json'
    settings.write_text(json.dumps(config))
    settings.chmod(0o600)
    now = datetime.datetime.now(datetime.timezone.utc)
    day = work / 'sessions' / now.strftime('%Y/%m/%d')
    day.mkdir(parents=True)
    session = '00000000-0000-4000-8000-000000000001'
    records = [
        {'type': 'session_meta', 'payload': {'id': session, 'cwd': str(work), 'timestamp': now.isoformat()}},
        {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'SYNTHETIC_PRIVATE_SESSION_DO_NOT_SEND'}},
    ]
    (day / f'rollout-{now.strftime("%Y-%m-%dT%H-%M-%S")}-{session}.jsonl').write_text(''.join(json.dumps(dict(r, timestamp=now.isoformat()))+'\n' for r in records))
    env = {k: v for k, v in os.environ.items() if not k.startswith(('HERDR_', 'TMUX', 'CODEX_HUD_'))}
    env.pop('NO_COLOR', None)
    env.update(CODEX_HOME=str(work), CODEX_SESSIONS_PATH=str(work/'sessions'), CODEX_HUD_CWD=str(work),
               CODEX_HUD_SETTINGS_PATH=str(settings), TERM='xterm-256color', NO_PROXY='127.0.0.1,localhost')
    socket = str(work/'tmux.sock')
    def tmux(*args):
        return subprocess.check_output([TMUX, '-S', socket, *args], env=env, text=True).strip()
    def capture():
        return tmux('capture-pane', '-p', '-t', 'fixture:0.0')
    def wait_for(text, timeout=12):
        deadline = time.monotonic()+timeout
        while time.monotonic()<deadline:
            screen = capture()
            if text in screen:
                return screen
            time.sleep(.05)
        raise AssertionError(f'Missing {text!r}: {screen}')
    def command(name):
        tmux('send-keys', '-t', 'fixture:0.0', '-l', '\x1b_codex-hud:'+name+'\x1b\\')
    try:
        tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '100', '-y', '40',
             shlex.join([NODE, str(ROOT/'dist/tree-page.js')]))
        tmux('set-option', '-t', 'fixture', 'status', 'off')
        wait_for('Agents')
        command('diagnostics')
        screen = wait_for('Main session TPS')
        assert 'no sample yet' in screen
        assert 'HUD diagnostics' in screen
        command('settings')
        wait_for('Display')
        index = int(subprocess.check_output([NODE, '--input-type=module', '-e',
            "import {SETTING_ROWS} from './dist/render/settings-page.js';console.log(SETTING_ROWS.findIndex(r=>r.key==='briefing'))"], cwd=ROOT, env=env, text=True))
        tmux('send-keys', '-t', 'fixture:0.0', '-N', str(index), 'Down')
        wait_for('[Test API]')
        before_test = settings.read_bytes()
        tmux('send-keys', '-t', 'fixture:0.0', '-l', 't')
        screen = wait_for('medium: ok')
        assert 'lite: ok' in screen and 'low: ok' in screen
        assert [r['model'] for r in requests] == ['fixture-none', 'fixture-low', 'fixture-high']
        assert all(r['max_tokens']==256 for r in requests)
        assert all(r['messages'][1]['content']=='Reply with OK.' for r in requests)
        assert 'SYNTHETIC_PRIVATE_SESSION_DO_NOT_SEND' not in json.dumps(requests)
        assert settings.read_bytes() == before_test, 'test must not save draft or change preferences'
        command('back')
        wait_for('HUD diagnostics')
        print('PASS: real tmux diagnostics + Settings test action + three synthetic API routes + no saved draft')
    finally:
        subprocess.run([TMUX, '-S', socket, 'kill-server'], env=env, capture_output=True)
        server.shutdown()
        server.server_close()
