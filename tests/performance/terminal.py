#!/usr/bin/env python3
"""Real 100x40 PTY, temporary synthetic CODEX_HOME; no tmux/user session access.
Usage: python3 tests/performance/pty.py /absolute/build [agents=256] [KB=256]
Measures write('?') to an expected changed-screen token, including queue wait.
"""
import fcntl, json, math, os, pathlib, pty, re, select, struct, subprocess, sys, tempfile, termios, time

build=pathlib.Path(sys.argv[1]).resolve()
agents=int(sys.argv[2]) if len(sys.argv)>2 else 256
kb=int(sys.argv[3]) if len(sys.argv)>3 else 256
probe=pathlib.Path(__file__).with_name('runtime-probe.mjs').resolve()
ansi=re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')
def summary(samples):
    s=sorted(samples)
    return dict(n=len(s),avg=sum(s)/len(s),p95=s[math.ceil(len(s)*.95)-1],max=s[-1])

with tempfile.TemporaryDirectory(prefix='hud-perf-pty-') as home:
    home=pathlib.Path(home); now=time.localtime()
    day=home/'sessions'/time.strftime('%Y/%m/%d',now);day.mkdir(parents=True)
    label=time.strftime('%Y-%m-%dT%H-%M-%S',now)
    stamp=time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime())+'.000Z'
    def ident(n):return '019d0000-0000-7000-8000-'+str(n).zfill(12)
    def row(payload):return json.dumps(dict(type='event_msg',timestamp=stamp,payload=payload))+'\n'
    paths=[]
    for n in range(agents+1):
        meta=dict(id=ident(n),cwd=str(home),timestamp=stamp)
        if n:meta.update(parent_thread_id=ident(0),agent_path='/root/agent_'+str(n))
        file=day/f'rollout-{label}-{ident(n)}.jsonl'
        file.write_text(json.dumps(dict(type='session_meta',payload=meta))+'\n'+row(dict(type='benchmark_padding',text='x'*1000))*kb+row(dict(type='task_started',turn_id=f't{n}')))
        paths.append(file)
    # Root is the only root and remains the fallback finder target.
    (home/'hud-settings.json').write_text(json.dumps(dict(refreshMs=250,briefing='off',changesPane='closed',detailsPane='closed',timelinePane='closed',language='en')))
    master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,100,0,0))
    env={k:v for k,v in os.environ.items() if not k.startswith(('CODEX_HUD_','TMUX','OPENAI_','AGY_')) and k!='CODEX_SESSIONS_PATH'}
    env.update(CODEX_HOME=str(home),CODEX_HUD_CWD=str(home),CODEX_HUD_PROFILE='1',HUD_PERF_RESULT=str(home/'runtime.json'),TERM='xterm-256color',NO_COLOR='1')
    node_args=['node']
    if os.environ.get('HUD_PERF_CPU_PROFILE_DIR'):node_args+=['--cpu-prof','--cpu-prof-dir='+os.environ['HUD_PERF_CPU_PROFILE_DIR']]
    child=subprocess.Popen(node_args+['--import',str(probe),str(build/'tree-page.js')],stdin=slave,stdout=slave,stderr=slave,cwd=home,env=env)
    os.close(slave)
    total_bytes=0
    def read_until(token,timeout=15):
        global total_bytes
        data=b'';end=time.monotonic()+timeout
        while time.monotonic()<end:
            if select.select([master],[],[],max(0,end-time.monotonic()))[0]:
                try:chunk=os.read(master,65536)
                except OSError:break
                total_bytes+=len(chunk);data+=chunk
                if token in ansi.sub(b'',data):return
        raise RuntimeError(f'expected {token!r}, exit={child.poll()}, tail={data[-1000:]!r}')
    def drain():
        global total_bytes
        while select.select([master],[],[],0)[0]:
            total_bytes+=len(os.read(master,65536))
    try:
        read_until(b'agent_')
        # Let initial collect, model-free context tails, and baseline scan saving settle.
        time.sleep(1);drain()
        warm=[]
        help_open=False
        for n in range(60):
            # Small appends keep collection active under repeatable load.
            if n%5==0:
                for file in paths:
                    with file.open('a') as f:f.write(row(dict(type='agent_message',message=f'Synthetic update {n}')))
            drain();start=time.perf_counter();os.write(master,b'?');help_open=not help_open
            read_until(b'Help' if help_open else b'agent_');warm.append((time.perf_counter()-start)*1000)
            time.sleep(.04)
        os.write(master,b'\x03');child.wait(timeout=10)
        runtime=json.loads((home/'runtime.json').read_text())
        profiles=(home/'hud'/'profile.log').read_text().splitlines()
        print(json.dumps(dict(agents=agents,kb=kb,warmKeyToOutputMs=summary(warm),terminalBytes=total_bytes,runtime=runtime,profiles=profiles),indent=2))
    finally:
        if child.poll() is None:child.terminate();child.wait(timeout=5)
        os.close(master)
