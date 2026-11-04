import os,sys,json,hashlib,subprocess,time
from datetime import datetime,timezone
R='/LV/p065-c3-local-preparation-20261104T134138Z-2371624/wt-source';B='/LV/p065-c3-local-preparation-20261104T134138Z-2371624/p065-local-build-node24-01';E='/LV/p065-c3-local-preparation-20261104T134138Z-2371624/p065-local-build-node24-stage-';M=B+'/manifest.json';C='33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5';T='ef8dc07594d5605eeeb94f3e2bac3e81c80e8822'
launch=['78e282318d9cc0d6f4772229e55b013dbee20c9cf4a2bee4a6616c0a176c24d4']
expected={M:'e7a883d1abee980bb320c88a8c26eb2dba1268d31bd7d3763098a883b981c150','/NVM/versions/node/v24.22.1/bin/node':'e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb','/usr/bin/python3':'e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f','/usr/bin/env':'886e5fa8be716b03eeda48856e0f04493f2969fc148fb7812594ffac647fa050','/usr/bin/timeout':'12690a043dfd555a6c14ccc1564f5649c18f1762c0d6ff66729948130898ec52','/usr/bin/git':'eb54b535467e0975c1284d4c4d08eea779aeb248a5d34b02e2ee171382e22201','/usr/bin/bash':'bc5945feb8bd26203ebfafea5ce1878bb2e32cb8fb50ab7ae395cfb1e1aaaef1','/usr/bin/tail':'03806be6481b4232405b9a16cb6d2a615977f12b2fd49fc6eabcefc6c6abbbdc'}
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def emit(k,v):print(json.dumps({'item':k,'value':v},sort_keys=True),flush=True)
def check(v,m):
 if not v:raise RuntimeError(m)
def git(*args):return subprocess.check_output(['git',*args],cwd=R,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}).decode()
def inv(root):
 if not os.path.lexists(root):return None
 check(os.path.isdir(root) and not os.path.islink(root),'invalid inventory root '+root)
 result=[]
 for d,dirs,files in os.walk(root,followlinks=False,onerror=lambda e: (_ for _ in ()).throw(e)):
  dirs.sort();files.sort()
  for n in dirs+files:
   p=os.path.join(d,n);rel=os.path.relpath(p,root)
   if os.path.islink(p):result.append({'path':rel,'type':'symlink','target':os.readlink(p)})
   elif os.path.isdir(p):result.append({'path':rel,'type':'directory'})
   elif os.path.isfile(p):result.append({'path':rel,'type':'file','bytes':os.path.getsize(p),'sha256':sha(p)})
   else:raise RuntimeError('invalid inventory entry '+p)
   result[-1]['mode']=format(os.lstat(p).st_mode & 0o7777,'04o')
 return result
stage=int(sys.argv[1]);phase=sys.argv[2]
emit('start',{'utc':datetime.now(timezone.utc).isoformat(),'monotonic_ns':time.monotonic_ns(),'stage':stage,'phase':phase})
try:
 for p,h in expected.items():
  v=sha(p);emit('identity',{'path':p,'sha256':v});check(v==h,'identity '+p)
 lp=f'{B}/stage-{stage}-launcher.py';check(sha(lp)==launch[stage-1],'launcher changed');emit('launcher',{'path':lp,'sha256':sha(lp)})
 check(git('rev-parse','HEAD').strip()==C and git('rev-parse','HEAD^{tree}').strip()==T,'head/tree changed')
 status=git('status','--porcelain=v1','--untracked-files=all');emit('status',status);check(not status,'worktree changed')
 ignored=git('ls-files','--others','--ignored','--exclude-standard','--','src','tests','packages','node_modules').splitlines();ignored=[p for p in ignored if not p.startswith('packages/hud-mcp/dist/')];emit('ignored_input_files',ignored);check(not ignored,'ignored inputs')
 entries=subprocess.check_output(['git','ls-files','--stage','-z'],cwd=R).split(b'\0');n=0;deps=0
 for e in entries:
  if not e:continue
  meta,name=e.split(b'\t',1);mode,oid,istage=meta.decode().split();p=name.decode();f=R+'/'+p;check(istage=='0','unmerged '+p)
  if mode=='120000':data=os.readlink(f).encode()
  else:
   check(not os.path.islink(f),'symlink '+p)
   with open(f,'rb') as h:data=h.read()
   check(bool(os.stat(f).st_mode&0o111)==(mode=='100755'),'mode '+p)
  v=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest();emit('tracked',{'path':p,'expected':oid,'actual':v,'sha256':hashlib.sha256(data).hexdigest()});check(v==oid,'tracked changed '+p);n+=1;deps+=p.startswith('node_modules/')
 check(n==1425 and deps==275,'tracked/dependency count');emit('tracked_count',n);emit('dependency_count',deps)
 if phase=='before':check(not os.path.lexists(E+str(stage)+'-evidence-01'),'evidence collision')
 roots={'dist':(R+'/dist',1),'dist-test':(R+'/dist-test',2),'mcp-dist':(R+'/packages/hud-mcp/dist',3)}
 for key,(path,built) in roots.items():
  x=inv(path)
  if stage<built or (stage==built and phase=='before'):check(x is None,'output collision '+key)
  else:
   check(x is not None,'output missing '+key);baseline=f'{B}/baseline-{key}.json'
   if stage==built and phase=='after':
    with open(baseline,'x') as f:json.dump(x,f,sort_keys=True)
   else:check(x==json.load(open(baseline)),'output drift '+key)
  emit('inventory',{'root':path,'entries':x})
 if phase=='after':
  for name in ('home','hud-home','tmp'):
   path=E+str(stage)+'-evidence-01/'+name;x=inv(path);emit('stage_local_inventory',{'root':path,'entries':x})
   check(x is not None,'missing temporary root')
   if name in ('home','hud-home'):check(not x,'temporary home residue')
   if name=='tmp':check(all(i['path']=='node-compile-cache' or i['path'].startswith('node-compile-cache/') for i in x),'temporary fixture residue')
 emit('result',{'status':'PASS','utc':datetime.now(timezone.utc).isoformat(),'monotonic_ns':time.monotonic_ns()})
except BaseException as exc:
 emit('result',{'status':'FAIL','reason':repr(exc),'utc':datetime.now(timezone.utc).isoformat(),'monotonic_ns':time.monotonic_ns()});sys.exit(1)
