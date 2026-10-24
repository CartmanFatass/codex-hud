#!/usr/bin/env python3
"""F12 uses a tmux id, but the panel must consume name-keyed bridge health."""
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
TMUX = shutil.which('tmux')
if not TMUX or not shutil.which('node'):
    raise SystemExit(77)
with tempfile.TemporaryDirectory(prefix='hud-health-toggle-') as temporary:
    work = Path(temporary)
    socket = str(work / 'tmux.sock')
    env = {k:v for k,v in os.environ.items() if not k.startswith(('TMUX','HERDR_','CODEX_HUD_'))}
    env.update(CODEX_HOME=str(work), CODEX_HUD_SETTINGS_PATH=str(work/'hud-settings.json'))
    (work/'hud-settings.json').write_text(json.dumps({'briefing':'off', 'language':'en'}))
    now = datetime.datetime.now(datetime.timezone.utc)
    day = work/'sessions'/now.strftime('%Y/%m/%d')
    day.mkdir(parents=True)
    (day/'rollout-fixture-00000000-0000-4000-8000-000000000001.jsonl').write_text(json.dumps({
        'timestamp':now.isoformat(),'type':'session_meta','payload':{
            'id':'00000000-0000-4000-8000-000000000001','cwd':str(work),'timestamp':now.isoformat()}})+'\n')
    def tmux(*args):
        return subprocess.check_output([TMUX,'-S',socket,*args],env=env,text=True).strip()
    try:
        tmux('-f','/dev/null','new-session','-d','-s','health-fixture','-x','130','-y','35','sleep 90')
        env['TMUX'] = f'{socket},{os.getpid()},0'
        pane = tmux('display-message','-p','-t','health-fixture','#{pane_id}')
        session_id = tmux('display-message','-p','-t','health-fixture','#{session_id}')
        assert session_id.startswith('$')
        for key,value in {'mode':'single','cwd':str(work),'main_pane':pane,'codex_home':str(work),'statusline':'0','session_start':str(int(now.timestamp()))}.items():
            tmux('set-option','-t','health-fixture',f'@codex_hud_{key}',value)
        health = work/'hud/herdr/health-fixture'
        health.mkdir(parents=True)
        (health/'123.json').write_text(json.dumps({'schemaVersion':1,'session':'health-fixture',
            'mainPaneId':pane,'lifecycle':'running','updatedAtMs':int(time.time()*1000),
            'transport':{'status':'connected','lastSuccessAtMs':int(time.time()*1000)},
            'probe':{'status':'ok'},'notificationGap':False}))
        subprocess.run(['bash',str(ROOT/'bin/codex-hud-toggle'),session_id],env=env,check=True)
        tree = tmux('show-option','-t','health-fixture','-qv','@codex_hud_tree_pane')
        start = tmux('display-message','-p','-t',tree,'#{pane_start_command}')
        assert 'CODEX_HUD_TMUX_SESSION=health-fixture' in start, start
        snapshot = work/'hud/state/health-fixture.json'
        deadline = time.monotonic()+10
        while time.monotonic()<deadline:
            try:
                data=json.loads(snapshot.read_text())
                if data.get('bridgeHealth',{}).get('state') == 'connected':break
            except (OSError,ValueError):pass
            time.sleep(.05)
        else:raise AssertionError('F12 panel did not read name-keyed bridge health')
        assert data['bridgeHealth']['probeFailed'] is False
        print('PASS: F12 session-id -> canonical name -> live bridge health -> matching snapshot')
    finally:
        subprocess.run([TMUX,'-S',socket,'kill-server'],env=env,capture_output=True)
