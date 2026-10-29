#!/usr/bin/env python3
"""Native Usage acceptance with synthetic records and a private tmux server."""
import datetime
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
TMUX, NODE = shutil.which('tmux'), shutil.which('node')
if not TMUX or not NODE:
    raise SystemExit(77)

with tempfile.TemporaryDirectory(prefix='hud-native-usage-') as temporary:
    work = Path(temporary)
    socket = str(work / 'tmux.sock')
    env = {k: v for k, v in os.environ.items() if not k.startswith(('CODEX', 'HERDR', 'TMUX'))}
    env.update(HOME=str(work), SHELL='/bin/bash', TERM='xterm-256color', LC_ALL='C.UTF-8')
    now = datetime.datetime.now().astimezone()
    day = work / 'sessions' / now.strftime('%Y/%m/%d')
    day.mkdir(parents=True)
    reader = work / 'reader.py'
    reader.write_text("import os,tty,sys\ntty.setraw(0)\nf=open(sys.argv[1],'ab',buffering=0)\nwhile True:\n d=os.read(0,4096)\n if not d:break\n f.write(d)\n")
    input_log = work / 'input.bin'
    ids = [f'00000000-0000-4000-8000-{n:012d}' for n in (1, 2, 3)]

    def record(kind, payload, seconds=0):
        return json.dumps({'timestamp': (now + datetime.timedelta(seconds=seconds)).isoformat(),
                           'type': kind, 'payload': payload}, ensure_ascii=False) + '\n'

    def create_log(thread, inputs, outputs, parent=None, other=False):
        filename = day / f'rollout-{now.strftime("%Y-%m-%dT%H-%M-%S")}-{thread}.jsonl'
        meta = {'id': thread, 'cwd': str(work / 'other' if other else work),
                'timestamp': (now - datetime.timedelta(seconds=20)).isoformat()}
        if parent:
            meta.update(parent_thread_id=parent, agent_nickname='usage-fixture', agent_role='reviewer')
        tokens = {'input_tokens': inputs, 'cached_input_tokens': inputs // 2,
                  'output_tokens': outputs, 'reasoning_output_tokens': outputs // 2,
                  'total_tokens': inputs + outputs}
        content = record('session_meta', meta, -20)
        content += record('event_msg', {'type': 'task_started', 'turn_id': thread}, -15)
        content += record('turn_context', {'turn_id': thread, 'model': 'gpt-fixture-child' if parent else 'gpt-fixture-main',
                                           'effort': 'high', 'cwd': meta['cwd']}, -14)
        content += record('event_msg', {'type': 'token_count', 'info': {
            'total_token_usage': tokens, 'last_token_usage': tokens}}, -10)
        filename.write_text(content)
        return filename

    root_log = create_log(ids[0], 1000, 100)
    create_log(ids[1], 200, 20, parent=ids[0])
    other_log = create_log(ids[2], 700, 70, other=True)
    # A second, archived copy of the same thread must not inflate native usage.
    archive = work / 'archived_sessions'
    archive.mkdir()
    (archive / other_log.name).write_bytes(other_log.read_bytes())

    def tmux(*args):
        return subprocess.check_output([TMUX, '-S', socket, *args], env=env,
                                       text=True, stderr=subprocess.PIPE).rstrip('\n')

    def screen():
        return tmux('capture-pane', '-p', '-t', panel)

    def capture(name):
        destination = os.environ.get('CODEX_HUD_USAGE_EVIDENCE_DIR')
        if destination:
            target = Path(destination)
            target.mkdir(parents=True, exist_ok=True)
            (target / f'{name}.ansi').write_text(tmux('capture-pane', '-e', '-p', '-t', panel))
            (target / f'{name}.txt').write_text(screen())

    def wait_for(predicate, message, timeout=18):
        deadline = time.monotonic() + timeout
        view = ''
        while time.monotonic() < deadline:
            view = screen()
            if predicate(view):
                return view
            time.sleep(.05)
        raise AssertionError(f'{message}\n{view}')

    def command(name):
        subprocess.run(['bash', str(ROOT / 'bin/codex-hud-command'), 'usage-acceptance', name],
                       env=dict(env, TMUX=socket + ',0,0'), check=True)

    def click_label(label):
        for row, line in enumerate(screen().splitlines()):
            if label in line:
                # This helper is only used for ASCII labels in the English chrome.
                col = line.index(label)
                sequence = f'\x1b[<0;{col + 1};{row + 1}M'.encode()
                tmux('send-keys', '-t', panel, '-H', *[f'{byte:02x}' for byte in sequence])
                return
        raise AssertionError(f'click target absent: {label}\n{screen()}')

    def open_panel(language, width, no_color):
        settings = work / 'hud-settings.json'
        settings.write_text(json.dumps({'briefing': 'off', 'language': language, 'look': 'quiet',
            'theme': 'none' if no_color else 'teal', 'icons': 'text', 'panelStyle': 'compact',
            'paneLayout': 'tabs', 'statusCard': 'status', 'agentColors': 'off', 'agentLog': False,
            'treeWidth': width, 'refreshMs': 250}))
        cmd = shlex.join(['env', f'CODEX_HOME={work}', f'CODEX_HUD_CWD={work}',
            f'CODEX_SESSIONS_PATH={work / "sessions"}', f'CODEX_HUD_SETTINGS_PATH={settings}',
            f'CODEX_HUD_MAIN_PANE={main}', f'CODEX_HUD_SESSION_START={int(now.timestamp()) - 30}',
            'CODEX_HUD_TMUX_SESSION=usage-acceptance', f'CODEX_HUD_TOGGLE_CMD={ROOT / "bin/codex-hud-toggle"}',
            f'NO_COLOR={"1" if no_color else ""}', NODE, str(ROOT / 'dist/tree-page.js')])
        pane = tmux('split-window', '-h', '-l', str(width), '-t', main, '-d', '-P', '-F', '#{pane_id}', cmd)
        tmux('set-option', '-t', 'usage-acceptance', '@codex_hud_tree_pane', pane)
        return pane

    try:
        main = tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'usage-acceptance', '-x', '140', '-y', '38',
                    '-P', '-F', '#{pane_id}', shlex.join(['python3', str(reader), str(input_log)]))
        tmux('set-option', '-t', 'usage-acceptance', 'status', 'off')
        tmux('set-option', '-t', 'usage-acceptance', '@codex_hud_main_pane', main)
        panel = open_panel('en', 48, False)
        wait_for(lambda s: 'usage-fixture' in s, 'synthetic child not shown')
        capture('quiet-en-48')
        command('settings')
        wait_for(lambda s: '[Save]' in s and 'Usage' in s, 'settings/Quiet navigation not ready')
        click_label('Usage')
        wait_for(lambda s: 'Codex usage' in s and '2,090' in s, 'global total or archived-copy dedup incorrect')
        capture('usage-en-48')
        tmux('send-keys', '-t', panel, '-l', 's')
        wait_for(lambda s: 'Current task' in s and '1,320' in s, 'current task scope incorrect')
        tmux('send-keys', '-t', panel, 'Tab')
        wait_for(lambda s: 'Self' in s and '1,100' in s and '220' in s, 'self/descendant attribution absent')
        tmux('send-keys', '-t', panel, 'Tab')
        wait_for(lambda s: 'gpt-fixture-main' in s, 'model grouping absent')
        tmux('send-keys', '-t', panel, '-l', 'f')
        wait_for(lambda s: '[7 days]' in s, 'period navigation absent')
        # Appended native events update without restarting the page or losing scope.
        new_tokens = {'input_tokens': 1100, 'cached_input_tokens': 550, 'output_tokens': 110,
                      'reasoning_output_tokens': 55, 'total_tokens': 1210}
        last = {'input_tokens': 100, 'cached_input_tokens': 50, 'output_tokens': 10,
                'reasoning_output_tokens': 5, 'total_tokens': 110}
        with root_log.open('a') as output:
            output.write(record('event_msg', {'type': 'token_count', 'info': {
                'total_token_usage': new_tokens, 'last_token_usage': last}}, -1))
        tmux('send-keys', '-t', panel, 'Left', 'Left')
        tmux('send-keys', '-t', panel, '-l', 'r')
        wait_for(lambda s: '1,430' in s and 'Current task' in s, 'incremental refresh lost query or count')
        assert not input_log.read_bytes(), 'Usage input leaked into main pane'
        tmux('send-keys', '-t', panel, 'Escape')
        wait_for(lambda s: 'Codex usage' not in s and 'usage-fixture' in s, 'Esc did not return to sidebar')
        tmux('kill-pane', '-t', panel)
        panel = open_panel('zh', 32, True)
        wait_for(lambda s: 'usage-fixture' in s, 'narrow Chinese sidebar not ready')
        capture('quiet-zh-32')
        command('usage')
        wait_for(lambda s: '用量' in s and '2,200' in s, 'Chinese/narrow persisted index display incorrect')
        capture('usage-zh-32')
        tmux('send-keys', '-t', panel, '-l', 's')
        wait_for(lambda s: '1,430' in s, 'narrow current-task scope incorrect')
        tmux('send-keys', '-t', panel, 'Tab', 'Tab', 'Tab', 'Tab', 'PageDown', 'Home')
        assert not input_log.read_bytes(), 'Chinese navigation leaked into main pane'
        tmux('send-keys', '-t', panel, 'Escape')
        wait_for(lambda s: 'usage-fixture' in s, 'narrow return failed')
        tmux('send-keys', '-t', panel, '-l', 'NORMAL_INPUT')
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and b'NORMAL_INPUT' not in input_log.read_bytes():
            time.sleep(.05)
        assert b'NORMAL_INPUT' in input_log.read_bytes(), 'normal input forwarding not restored'
        print('PASS: native Usage EN/ZH, quiet 48/32 columns, archive dedup, task/model/period views, incremental refresh, restart, input isolation')
    finally:
        subprocess.run([TMUX, '-S', socket, 'kill-server'], capture_output=True)
