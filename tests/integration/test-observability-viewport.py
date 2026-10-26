#!/usr/bin/env python3
"""Bounded constrained-size native tmux acceptance for observability overlays."""
import datetime, json, os, shlex, shutil, subprocess, tempfile, time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
TMUX,NODE=shutil.which('tmux'),shutil.which('node')
if not TMUX or not NODE: raise SystemExit(77)

evidence=Path(tempfile.mkdtemp(prefix='hud-viewport-evidence-'))
print(f'EVIDENCE_DIR={evidence}')
with tempfile.TemporaryDirectory(prefix='hud-viewport-') as td:
 w=Path(td); sock=str(w/'tmux.sock'); env={k:v for k,v in os.environ.items() if not k.startswith(('CODEX','HERDR','TMUX'))}
 env.update(HOME=str(w),SHELL='/bin/bash',TERM='xterm-256color',LC_ALL='C.UTF-8')
 reader=w/'reader.py'; inp=w/'input.bin'; reader.write_text("import os,tty,sys\ntty.setraw(0)\nf=open(sys.argv[1],'ab',buffering=0)\nwhile True:\n d=os.read(0,4096)\n if not d:break\n f.write(d)\n")
 now=datetime.datetime.now().astimezone(); sess=w/'sessions'/now.strftime('%Y/%m/%d'); sess.mkdir(parents=True)
 rid='00000000-0000-4000-8000-000000000001'; aid='00000000-0000-4000-8000-000000000002'; stamp=now.strftime('%Y-%m-%dT%H-%M-%S')
 def row(k,p): return json.dumps({'timestamp':datetime.datetime.now().astimezone().isoformat(),'type':k,'payload':p},ensure_ascii=False)+'\n'
 (sess/f'rollout-{stamp}-{rid}.jsonl').write_text(row('session_meta',{'id':rid,'cwd':str(w),'timestamp':now.isoformat()})+row('event_msg',{'type':'task_started'}))
 log=sess/f'rollout-{stamp}-{aid}.jsonl'; log.write_text(row('session_meta',{'id':aid,'cwd':str(w),'timestamp':now.isoformat(),'parent_thread_id':rid,'agent_nickname':'j中文-agent'})+row('event_msg',{'type':'task_started'})+row('turn_context',{'model':'fixture','effort':'low'}))
 def tx(*a): return subprocess.check_output([TMUX,'-S',sock,*a],env=env,text=True,stderr=subprocess.PIPE).rstrip('\n')
 def screen(): return tx('capture-pane','-p','-t',panel)
 def wait(pred,msg,timeout=4):
  end=time.monotonic()+timeout; s=''
  while time.monotonic()<end:
   s=screen()
   if pred(s): return s
   time.sleep(.05)
  raise AssertionError(msg+'\n'+s)
 def cmd(n): subprocess.run(['bash',str(ROOT/'bin/codex-hud-command'),'observe',n],env=dict(env,TMUX=sock+',0,0'),check=True,stdout=subprocess.DEVNULL)
 def store(): return json.loads(next((w/'hud/activity').glob('*.json')).read_text())
 def wait_store(pred,msg,timeout=4):
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   try:
    value=store()
    if pred(value): return value
   except (StopIteration,OSError,ValueError): pass
   time.sleep(.05)
  raise AssertionError(msg)
 def open_panel(language,width,color):
  settings=w/'settings.json'; settings.write_text(json.dumps({'briefing':'off','language':language,'theme':'terminal','look':'tab','treeWidth':width,'refreshMs':250}))
  c=['env',f'CODEX_HOME={w}',f'CODEX_HUD_CWD={w}',f'CODEX_SESSIONS_PATH={w/"sessions"}',f'CODEX_HUD_SETTINGS_PATH={settings}',f'CODEX_HUD_MAIN_PANE={main}',f'CODEX_HUD_SESSION_START={int(now.timestamp())}','CODEX_HUD_TMUX_SESSION=observe',f'CODEX_HUD_TOGGLE_CMD={ROOT/"bin/codex-hud-toggle"}']
  if not color: c+=['NO_COLOR=1']
  c += [NODE,str(ROOT/'dist/tree-page.js')]
  p=tx('split-window','-h','-l',str(width),'-t',main,'-d','-P','-F','#{pane_id}',shlex.join(c)); tx('set-option','-t','observe','@codex_hud_tree_pane',p); return p
 try:
  main=tx('-f','/dev/null','new-session','-d','-s','observe','-x','100','-y','12','-P','-F','#{pane_id}',shlex.join(['python3',str(reader),str(inp)])); tx('set-option','-t','observe','status','off'); tx('set-option','-t','observe','@codex_hud_main_pane',main)
  for lang,width,color in [('en',32,False),('zh',48,False),('en',48,True)]:
   panel=open_panel(lang,width,color); wait(lambda s:'j中文-agent' in s,'main tree missing'); input_baseline=inp.read_bytes()
   cmd('activity'); s=wait(lambda s:('Activity hub' if lang=='en' else '活动中心') in s,'activity missing')
   with log.open('a') as f: f.write(row('event_msg',{'type':'task_complete','last_agent_message':'SYNTHETIC'}))
   (evidence/f'activity-{lang}-{width}-{color}.txt').write_text(s)
   tx('send-keys','-t',panel,'Tab'); s=wait(lambda s:('Agent completed' if lang=='en' else '代理完成') in s,'completion row missing from Updates')
   tx('send-keys','-t',panel,'s'); wait_store(lambda j:any(e.get('snoozedUntil',0)>0 for e in j.get('events',[])),'Snooze was not persisted')
   tx('send-keys','-t',panel,'v'); wait_store(lambda j:any(e.get('viewed') for e in j.get('events',[])),'Mark viewed receipt was not persisted')
   assert inp.read_bytes()==input_baseline, 'modal keys leaked into main reader'
   # Read/snooze are exercised against the selected event row.
   tx('send-keys','-t',panel,'Escape')
   cmd('find-agent'); wait(lambda s:('Search name' if lang=='en' else '搜索') in s,'find absent')
   tx('send-keys','-t',panel,'-l','j中文'); wait(lambda s:'j中文-agent' in s and 'j中文' in s,'unicode find failed')
   tx('send-keys','-t',panel,'-H','10'); wait_store(lambda j:aid in j.get('pins',[]),'Find pin action was not persisted')
   tx('send-keys','-t',panel,'Escape'); cmd('activity'); tx('send-keys','-t',panel,'Left'); time.sleep(.2)
   tx('send-keys','-t',panel,'Enter'); wait(lambda s:('Historical observation' if lang=='en' else '历史观测') in s,'history snapshot not visibly historical')
   tx('send-keys','-t',panel,'Escape','Escape'); cmd('observability')
   s=wait(lambda s:('HUD evidence' if lang=='en' else 'HUD 证据') in s,'evidence modal missing')
   tabs=[]
   headings=(['[Sources]','Model calls by feature','[Save report]'] if lang=='en' else ['[来源]','调用','[保存报告]'])
   for i,heading in enumerate(headings):
    s=wait(lambda x:heading in x,'evidence tab not visible: '+heading); tabs.append(s)
    if i<2: tx('send-keys','-t',panel,'Tab')
   tx('send-keys','-t',panel,'End'); s=screen(); assert 'Back' in s or '返回' in s, f'Back hidden at end: {s}'
   (evidence/f'evidence-{lang}-{width}-{color}.txt').write_text('\n---TAB---\n'.join(tabs)+'\n---END---\n'+s)
   assert not list((w/'hud'/'diagnostics').glob('*.json')) if (w/'hud'/'diagnostics').exists() else True
   tx('send-keys','-t',panel,'Escape'); wait(lambda s:('HUD evidence' if lang=='en' else 'HUD 证据') not in s,'back/close failed')
   tx('send-keys','-t',panel,'-l','NORMAL_INPUT')
   end=time.monotonic()+3
   while time.monotonic()<end and b'NORMAL_INPUT' not in inp.read_bytes(): time.sleep(.05)
   assert b'NORMAL_INPUT' in inp.read_bytes(), 'main reader did not receive ordinary input after modal close'
   tx('kill-pane','-t',panel)
   print(f'PASS lang={lang} width={width} height=12 color={color}')
  print('LIMITS: synthetic tmux terminal only; transient detail layout and real terminal emulators are not covered')
 finally:
  subprocess.run([TMUX,'-S',sock,'kill-server'],capture_output=True)
