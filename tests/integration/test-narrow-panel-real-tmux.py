#!/usr/bin/env python3
"""Narrow EN/ZH panels: actual tmux screen, mouse, modal return and input forwarding.

Only synthetic sessions, a private tmux socket and a no-network HUD configuration.
"""
import datetime
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import struct
import subprocess
import tempfile
import termios
import time
import unicodedata

ROOT = Path(__file__).resolve().parents[2]
TMUX, NODE = shutil.which('tmux'), shutil.which('node')
if not TMUX or not NODE:
    raise SystemExit(77)


def columns(text):
    return sum(0 if unicodedata.combining(ch) else 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1 for ch in text)


with tempfile.TemporaryDirectory(prefix='hud-narrow-') as temporary:
    work = Path(temporary)
    socket = str(work / 'tmux.sock')
    env = {k: v for k, v in os.environ.items() if not k.startswith(('TMUX', 'HERDR_', 'CODEX_'))}
    env.update(CODEX_HOME=str(work), CODEX_SESSIONS_PATH=str(work/'sessions'),
               CODEX_HUD_CWD=str(work), CODEX_HUD_SETTINGS_PATH=str(work/'hud-settings.json'),
               TERM='xterm-256color', LC_ALL='C.UTF-8')
    reader = work/'reader.py'
    reader.write_text("import os,tty,sys\ntty.setraw(0)\nf=open(sys.argv[1],'ab',buffering=0)\nwhile True:\n data=os.read(0,4096)\n if not data:break\n f.write(data)\n")
    input_log = work/'input.bin'
    now = datetime.datetime.now().astimezone()
    day = work/'sessions'/now.strftime('%Y/%m/%d')
    day.mkdir(parents=True)
    root_id = '00000000-0000-4000-8000-000000000001'
    child_id = '00000000-0000-4000-8000-000000000002'
    def row(kind, payload):
        return json.dumps({'timestamp':now.isoformat(), 'type':kind, 'payload':payload}, ensure_ascii=False)+'\n'
    (day/f'rollout-{now.strftime("%Y-%m-%dT%H-%M-%S")}-{root_id}.jsonl').write_text(row('session_meta', {'id':root_id, 'cwd':str(work), 'timestamp':now.isoformat()}))
    (day/f'rollout-{now.strftime("%Y-%m-%dT%H-%M-%S")}-{child_id}.jsonl').write_text(row('session_meta', {
        'id':child_id, 'cwd':str(work), 'parent_thread_id':root_id, 'agent_nickname':'agent_中文', 'timestamp':now.isoformat()})+
        row('event_msg', {'type':'task_started'})+row('turn_context', {'model':'gpt-fixture', 'effort':'low'}))
    def tmux(*args):
        return subprocess.check_output([TMUX, '-S', socket, *args], env=env, text=True, stderr=subprocess.PIPE).rstrip("\n")
    master = client = None
    try:
        main = tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'narrow', '-x', '110', '-y', '24',
                    '-P', '-F', '#{pane_id}', shlex.join(['python3', str(reader), str(input_log)]))
        tmux('set-option', '-t', 'narrow', 'status', 'off')
        tmux('set-option', '-t', 'narrow', 'mouse', 'on')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 110, 0, 0))
        client = subprocess.Popen([TMUX, '-S', socket, 'attach-session', '-t', 'narrow'], env=env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        def pump(seconds=.08):
            deadline = time.monotonic()+seconds
            while time.monotonic()<deadline:
                if select.select([master], [], [], .02)[0]:
                    try: os.read(master, 262144)
                    except OSError: break
        def capture(): return tmux('capture-pane', '-p', '-t', panel)
        def wait_for(predicate, message, timeout=8):
            deadline = time.monotonic()+timeout
            while time.monotonic()<deadline:
                pump()
                screen = capture()
                if predicate(screen): return screen
            raise AssertionError(f'{message}\n{screen}')
        def click_text(word, line_index=0):
            line = capture().splitlines()[line_index]
            assert word in line, (word, line)
            x = columns(line[:line.index(word)]) + int(tmux('display-message', '-p', '-t', panel, '#{pane_left}'))+1
            y = line_index+int(tmux('display-message', '-p', '-t', panel, '#{pane_top}'))+1
            os.write(master, f'\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m'.encode())
            pump()
        for no_color in ('', '1'):
            # The server's environment belongs to this test only.
            tmux('set-environment', '-t', 'narrow', 'NO_COLOR', no_color)
            for language in ('en', 'zh'):
                settings_word, back = ('Settings', '[Back]') if language == 'en' else ('设置', '[返回]')
                for width in (32, 40, 48, 56):
                    settings = work/'hud-settings.json'
                    settings.write_text(json.dumps({'briefing':'off', 'language':language, 'theme':'terminal',
                        'look':'tab', 'icons':'unicode', 'treeWidth':width, 'refreshMs':250, 'art':'off'}))
                    original = settings.read_bytes()
                    command = shlex.join(['env', f'CODEX_HOME={work}', f'CODEX_SESSIONS_PATH={work/"sessions"}',
                                          f'CODEX_HUD_CWD={work}', f'CODEX_HUD_SETTINGS_PATH={settings}', f'NO_COLOR={no_color}',
                                          f'CODEX_HUD_MAIN_PANE={main}', 'CODEX_HUD_TMUX_SESSION=narrow', f'CODEX_HUD_SESSION_START={int(now.timestamp())}',
                                          NODE, str(ROOT/'dist/tree-page.js')])
                    panel = tmux('split-window', '-h', '-l', str(width), '-t', main, '-d', '-P', '-F', '#{pane_id}', command)
                    label = f'NO_COLOR={no_color or "empty"}/{language}/{width}'
                    wait_for(lambda s: 'agent_中文' in s and settings_word in s, label+' initial panel')
                    assert int(tmux('display-message', '-p', '-t', panel, '#{pane_width}')) == width
                    assert int(tmux('display-message', '-p', '-t', panel, '#{pane_height}')) == 24
                    click_text(settings_word)
                    wait_for(lambda s: back in s, label+' Settings mouse')
                    tmux('send-keys', '-t', panel, 'Right')
                    tmux('send-keys', '-t', panel, 'Escape')
                    warning = 'Unsaved settings' if language == 'en' else '设置尚未保存'
                    wait_for(lambda s: warning in s, label+' unsaved draft')
                    tmux('send-keys', '-t', panel, 'Escape')
                    wait_for(lambda s: back in s and warning not in s, label+' cancel leave')
                    tmux('send-keys', '-t', panel, 'Escape')
                    wait_for(lambda s: warning in s, label+' leave again')
                    tmux('send-keys', '-t', panel, 'Left', 'Enter')
                    wait_for(lambda s: 'agent_中文' in s and back not in s, label+' discard returns to cards')
                    assert settings.read_bytes() == original, label+' discard changed saved settings'
                    click_text('?')
                    wait_for(lambda s: back in s, label+' Help mouse')
                    tmux('send-keys', '-t', panel, 'Escape')
                    wait_for(lambda s: 'agent_中文' in s and back not in s, label+' Help return')
                    # At a constrained height, header hit areas still route correctly.
                    tmux('resize-window', '-t', 'narrow', '-y', '12')
                    wait_for(lambda s: int(tmux('display-message', '-p', '-t', panel, '#{pane_height}')) == 12
                             and 'agent_中文' in s and settings_word in s, label+' short panel')
                    click_text(settings_word)
                    wait_for(lambda s: back in s, label+' short Settings')
                    tmux('send-keys', '-t', panel, 'Escape')
                    wait_for(lambda s: 'agent_中文' in s and back not in s, label+' short return')
                    marker = f'FORWARD_{language}_{width}_{no_color or "color"}'
                    tmux('send-keys', '-t', panel, '-l', marker)
                    deadline = time.monotonic()+5
                    while time.monotonic()<deadline and marker.encode() not in input_log.read_bytes(): pump()
                    assert marker.encode() in input_log.read_bytes(), label+' plain input was swallowed'
                    assert tmux('display-message', '-p', '-t', 'narrow', '#{pane_id}') == main, label+' focus did not return'
                    assert settings.read_bytes() == original
                    print('PASS '+label+': mouse/settings/unsaved draft/help/short height/input forwarding', flush=True)
                    tmux('kill-pane', '-t', panel)
                    tmux('resize-window', '-t', 'narrow', '-y', '24')
    finally:
        subprocess.run([TMUX, '-S', socket, 'kill-server'], capture_output=True)
        if client:
            try: client.wait(timeout=3)
            except subprocess.TimeoutExpired: client.kill(); client.wait()
        if master is not None: os.close(master)
