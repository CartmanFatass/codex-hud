#!/usr/bin/env python3
"""Offline UI acceptance of activity/search/history and allowlisted export in private tmux."""
import datetime
import hashlib
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

with tempfile.TemporaryDirectory(prefix='hud-observe-ui-') as temporary:
    work = Path(temporary)
    socket = str(work/'tmux.sock')
    env = {k:v for k,v in os.environ.items() if not k.startswith(('CODEX','HERDR','TMUX'))}
    env.update(HOME=str(work), SHELL='/bin/bash', TERM='xterm-256color', LC_ALL='C.UTF-8')
    reader = work/'reader.py'
    reader.write_text("import os,tty,sys\ntty.setraw(0)\nf=open(sys.argv[1],'ab',buffering=0)\nwhile True:\n d=os.read(0,4096)\n if not d:break\n f.write(d)\n")
    input_log = work/'input.bin'
    now = datetime.datetime.now().astimezone()
    day = work/'sessions'/now.strftime('%Y/%m/%d'); day.mkdir(parents=True)
    root_id = '00000000-0000-4000-8000-000000000001'
    agent_id = '00000000-0000-4000-8000-000000000002'
    label = now.strftime('%Y-%m-%dT%H-%M-%S')
    def row(kind,payload):
        return json.dumps({'timestamp':datetime.datetime.now().astimezone().isoformat(),'type':kind,'payload':payload},ensure_ascii=False)+'\n'
    root_log = day/f'rollout-{label}-{root_id}.jsonl'
    root_log.write_text(row('session_meta',{'id':root_id,'cwd':str(work),'timestamp':now.isoformat()})+
                        row('event_msg',{'type':'task_started'}))
    agent_log = day/f'rollout-{label}-{agent_id}.jsonl'
    agent_log.write_text(row('session_meta',{'id':agent_id,'cwd':str(work),'timestamp':now.isoformat(),'parent_thread_id':root_id,'agent_nickname':'j中文-agent'})+
                         row('event_msg',{'type':'task_started'})+row('turn_context',{'model':'gpt-fixture','effort':'low'}))
    def tmux(*args):
        return subprocess.check_output([TMUX,'-S',socket,*args],env=env,text=True,stderr=subprocess.PIPE).rstrip('\n')
    def screen():return tmux('capture-pane','-p','-t',panel)
    def wait_for(predicate,message,timeout=10):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            view=screen()
            if predicate(view):return view
            time.sleep(.05)
        raise AssertionError(f'{message}\n{view}')
    def command(name):
        subprocess.run(['bash',str(ROOT/'bin/codex-hud-command'),'observe',name],
                       env=dict(env,TMUX=socket+',0,0'),check=True)
    def journal():
        return json.loads(next((work/'hud/activity').glob('*.json')).read_text())
    def wait_disk(predicate,message,timeout=10):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            try:
                if predicate():return
            except (StopIteration,OSError,ValueError):pass
            time.sleep(.05)
        raise AssertionError(message)
    def open_panel(language,width):
        settings=work/'hud-settings.json'
        settings.write_text(json.dumps({'briefing':'off','language':language,'theme':'terminal','look':'tab','treeWidth':width,
            'refreshMs':250,'briefingApiKey':'SECRET_TEST_DO_NOT_EXPORT','briefingApiBase':'https://SECRET_TEST.invalid/v1'}))
        cmd=shlex.join(['env',f'CODEX_HOME={work}',f'CODEX_HUD_CWD={work}',f'CODEX_SESSIONS_PATH={work/"sessions"}',
            f'CODEX_HUD_SETTINGS_PATH={settings}',f'CODEX_HUD_MAIN_PANE={main}',f'CODEX_HUD_SESSION_START={int(now.timestamp())}',
            'CODEX_HUD_TMUX_SESSION=observe',f'CODEX_HUD_TOGGLE_CMD={ROOT/"bin/codex-hud-toggle"}','NO_COLOR=1',NODE,str(ROOT/'dist/tree-page.js')])
        pane=tmux('split-window','-h','-l',str(width),'-t',main,'-d','-P','-F','#{pane_id}',cmd)
        tmux('set-option','-t','observe','@codex_hud_tree_pane',pane)
        return pane
    try:
        main=tmux('-f','/dev/null','new-session','-d','-s','observe','-x','120','-y','28','-P','-F','#{pane_id}',shlex.join(['python3',str(reader),str(input_log)]))
        tmux('set-option','-t','observe','status','off')
        tmux('set-option','-t','observe','@codex_hud_main_pane',main)
        panel=open_panel('en',48)
        wait_for(lambda s:'j中文-agent' in s,'synthetic agent not shown')
        command('find-agent')
        wait_for(lambda s:'Activity hub' in s and 'Search name' in s,'Find modal absent')
        tmux('send-keys','-t',panel,'-l','j中文')
        wait_for(lambda s:'j中文-agent' in s and 'path: j中文' in s,'literal query not retained')
        tmux('send-keys','-t',panel,'-H','10') # Ctrl+P pins without adding text to the query.
        wait_disk(lambda:agent_id in journal()['pins'],'pin not persisted')
        assert not input_log.read_bytes(), 'search or pin input leaked into main pane'
        tmux('send-keys','-t',panel,'Escape')
        wait_for(lambda s:'Activity hub' not in s,'Find did not close')
        assert tmux('display-message','-p','-t','observe','#{pane_id}')==main
        # A real appended completion is picked up while the overlay is open.
        command('activity')
        wait_for(lambda s:'Activity hub' in s,'inbox absent')
        with agent_log.open('a') as output:output.write(row('event_msg',{'type':'task_complete','last_agent_message':'SYNTHETIC_FINISH'}))
        wait_disk(lambda:any(e['kind']=='completed' for e in journal()['events']),'completion event not observed')
        tmux('send-keys','-t',panel,'Tab')
        wait_for(lambda s:'Agent completed' in s,'Since viewed missing completion')
        tmux('send-keys','-t',panel,'-l','v')
        wait_disk(lambda:any(e['kind']=='completed' and e['viewed'] for e in journal()['events']),'visible event not marked viewed')
        command('observability')
        wait_for(lambda s:'HUD evidence' in s and 'Main state' in s,'sources absent')
        tmux('send-keys','-t',panel,'Tab')
        wait_for(lambda s:'Model calls by feature' in s,'model call dashboard absent')
        tmux('send-keys','-t',panel,'Tab')
        wait_for(lambda s:'[Save report]' in s and 'schemaVersion' in s,'export preview absent')
        exports=work/'hud/diagnostics'
        assert not list(exports.glob('*.json')), 'preview wrote a report'
        tmux('send-keys','-t',panel,'-l','s')
        wait_disk(lambda:len(list(exports.glob('*.json')))==1,'explicit save missing')
        saved=next(exports.glob('*.json'));body=saved.read_text()
        assert 'SECRET_TEST' not in body and 'SYNTHETIC_FINISH' not in body and 'j中文' not in body and str(work) not in body
        assert saved.stat().st_mode & 0o777 == 0o600
        report=json.loads(body)
        assert report['schemaVersion']==1
        assert report['runtimeIdentity']['scope']=='entry-file-at-start'
        assert report['runtimeIdentity']['entrySha256']==hashlib.sha256((ROOT/'dist/tree-page.js').read_bytes()).hexdigest()
        tmux('send-keys','-t',panel,'Escape')
        wait_for(lambda s:'HUD evidence' not in s,'evidence modal did not close')
        # Persisted pins and viewed receipt survive a fresh panel and a language change.
        tmux('kill-pane','-t',panel)
        panel=open_panel('zh',32)
        wait_for(lambda s:'j中文-agent' in s,'reopened agent absent')
        command('find-agent')
        wait_for(lambda s:'活动中心' in s and '已关注' in s,'pin did not survive reopen')
        tmux('send-keys','-t',panel,'Escape')
        command('activity')
        wait_for(lambda s:'活动中心' in s,'Chinese activity absent')
        tmux('send-keys','-t',panel,'Left')
        wait_for(lambda s:'回放' in s,'history snapshots absent')
        tmux('send-keys','-t',panel,'Enter')
        wait_for(lambda s:'历史观测' in s,'historical replay absent')
        tmux('send-keys','-t',panel,'Escape','Escape')
        wait_for(lambda s:'活动中心' not in s,'history did not return')
        tmux('send-keys','-t',panel,'-l','NORMAL_INPUT')
        wait_disk(lambda:b'NORMAL_INPUT' in input_log.read_bytes(),'ordinary keys not restored')
        print('PASS: private tmux EN/ZH find/pin, completion/seen, source/call/export, restart/history and input isolation')
    finally:
        subprocess.run([TMUX,'-S',socket,'kill-server'],capture_output=True)
