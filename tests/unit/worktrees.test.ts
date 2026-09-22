import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeCollector, worktreeGit, parseWorktreeList, parseWorktreeStatus, worktreeSources, PROBES_PER_REFRESH, WORKTREE_LIMIT } from '../../src/collectors/worktrees.js';
const exec=promisify(execFile);
const metadata=(paths:string[])=>paths.map((path,i)=>`worktree ${path}\0HEAD ${'a'.repeat(40)}\0branch refs/heads/branch${i}\0\0`).join('');
const status='# branch.head main\0# branch.ab +2 -3\0';

test('worktree list parses NUL fields, including multiline paths, empty lock reason and detached/bare',()=>{
  const input='worktree /tmp/a\n\tb\0HEAD abcd\0branch refs/heads/test\0locked\0\0worktree /tmp/b\0HEAD efgh\0detached\0prunable gone\0\0worktree /bare\0bare\0\0';
  const list=parseWorktreeList(input);assert.equal(list.length,3);assert.equal(list[0].path,'/tmp/a\n\tb');assert.equal(list[0].locked,'');
  assert.equal(list[1].detached,true);assert.equal(list[1].prunable,'gone');assert.equal(list[2].bare,true);
});

test('status counts files, not rename paths, and staged/unstaged overlap',()=>{
  const text=status+'1 MM N... 100644 100644 100644 a b x\0'+'2 R. N... 100644 100644 100644 a b R100 new\0? old\npath\0'+'? untracked\nname\0'+'u UU N... 100644 100644 100644 100644 a b c conflict\0';
  const s=parseWorktreeStatus(text);assert.equal(s.changed,4);assert.equal(s.staged,2);assert.equal(s.unstaged,1);assert.equal(s.untracked,1);assert.equal(s.conflicts,1);assert.equal(s.ahead,2);assert.equal(s.behind,3);
});

test('truncated and unrecognized records fail instead of pretending clean',()=>{
  assert.throws(()=>parseWorktreeList('worktree /x\0HEAD x\0'));
  assert.throws(()=>parseWorktreeStatus('1 .M incomplete'));
  assert.throws(()=>parseWorktreeStatus('unexpected\0'));
  assert.throws(()=>parseWorktreeStatus('2 R. x\0'));
});

test('unknown upstream differs from ahead=0 behind=0',()=>{
  assert.equal(parseWorktreeStatus('# branch.head main\0').ahead,null);
  assert.equal(parseWorktreeStatus('# branch.head main\0# branch.ab +0 -0\0').ahead,0);
});

test('repository selection uses only explicit configuration or session/launch cwd',()=>{
  assert.deepEqual(worktreeSources('/launch','/session'),['/session','/launch']);
  assert.deepEqual(worktreeSources('/launch','/session','project'),['/launch/project']);
  assert.deepEqual(worktreeSources('/launch','/session','/configured','/override'),['/override']);
});

test('collector probes a bounded round-robin batch with at most two concurrent Git calls',async()=>{
  const paths=Array.from({length:9},(_,i)=>'/wt/'+i);let concurrent=0;let maximum=0;const reads:string[]=[];
  const collector=new WorktreeCollector(async(cwd,args)=>{
    concurrent++;maximum=Math.max(maximum,concurrent);try{
      await new Promise(resolve=>setTimeout(resolve,1));
      if(args[0]==='worktree')return metadata(paths);
      if(args[0]==='config')throw {code:1};
      assert.ok(args.includes('status'));reads.push(cwd);return '# branch.head branch'+paths.indexOf(cwd)+'\0';
    }finally{concurrent--;}
  },()=>1000);
  const first=await collector.refresh(['/repo']);assert.equal(reads.length,PROBES_PER_REFRESH);assert.ok(maximum<=2);
  assert.equal(first.entries.filter(w=>w.status).length,PROBES_PER_REFRESH);
  assert.equal(first.entries.at(-1)?.status,undefined);
  await collector.refresh(['/repo']);assert.ok(reads.includes('/wt/7'));
});

test('failed status clears old clean evidence and errors do not echo argv or paths',async()=>{
  let fail=false;
  const collector=new WorktreeCollector(async(_cwd,args)=>{
    if(args[0]==='worktree')return metadata(['/private/repo']);if(args[0]==='config')throw {code:1};
    if(fail)throw new Error('git status PRIVATE_SECRET');return '# branch.head branch0\0';
  },()=>2000);
  assert.equal((await collector.refresh(['/repo'])).entries[0].status?.changed,0);
  fail=true;const next=await collector.refresh(['/repo']);assert.equal(next.entries[0].status,undefined);assert.equal(next.entries[0].observedAt,undefined);assert.doesNotMatch(next.entries[0].error??'',/PRIVATE|git status/);
});

test('prunable and bare entries never trigger status or filter commands',async()=>{
  const calls:string[][]=[];
  const snapshot=await new WorktreeCollector(async(_cwd,args)=>{calls.push(args);return 'worktree /bare\0bare\0\0worktree /gone\0prunable gone\0\0';}).refresh(['/repo']);
  assert.equal(snapshot.entries.length,2);assert.equal(calls.length,1);
});

test('filter commands are disabled before status and never executed as shell text',async()=>{
  const calls:string[][]=[];
  await new WorktreeCollector(async(_cwd,args)=>{
    calls.push(args);
    if(args[0]==='worktree')return metadata(['/repo']);if(args[0]==='config')return 'filter.custom.clean\0filter.custom.required\0';
    assert.ok(args.includes('filter.custom.clean='));assert.ok(args.includes('filter.custom.process='));assert.ok(args.includes('filter.custom.required=false'));
    return '# branch.head branch0\0';
  }).refresh(['/repo']);
  assert.ok(calls.flat().every(arg=>!['add','commit','checkout','diff','fetch','prune'].includes(arg)));
});

test('an unrepresentable filter key fails closed before touching file contents',async()=>{
  let statusRead=false;
  const snapshot=await new WorktreeCollector(async(_cwd,args)=>{if(args[0]==='worktree')return metadata(['/repo']);if(args[0]==='config')return 'filter.a=b.clean\0';statusRead=true;return status;}).refresh(['/repo']);
  assert.equal(statusRead,false);assert.equal(snapshot.entries[0].status,undefined);assert.ok(snapshot.entries[0].error);
});

test('list limit is visible rather than claiming an exhaustive result',async()=>{
  const snapshot=await new WorktreeCollector(async(_cwd,args)=>{if(args[0]==='worktree')return metadata(Array.from({length:140},(_,i)=>'/x/'+i));if(args[0]==='config')throw {code:1};return status;}).refresh(['/repo']);
  assert.equal(snapshot.entries.length,WORKTREE_LIMIT);assert.equal(snapshot.truncated,true);
});

test('concurrent refresh requests share a single collection instead of spawning duplicate probes',async()=>{
  let reads=0;const c=new WorktreeCollector(async(_cwd,args)=>{if(args[0]==='worktree'){reads++;return metadata(['/x']);}if(args[0]==='config')throw{code:1};return status;});
  const a=c.refresh(['/x']);const b=c.refresh(['/x']);assert.equal(a,b);await Promise.all([a,b]);assert.equal(reads,1);
});

test('real Git read-only smoke: unusual untracked filenames; no staging, commit or checkout',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hud-worktrees-'));
  try{
    // Only initializes an isolated test repository. No add/commit/checkout/worktree-add.
    await exec('git',['init','--quiet',dir],{timeout:5000});
    await writeFile(join(dir,'space newline\n\t\x1b[2J.txt'),'fixture');
    const before=await worktreeGit(dir,['status','--porcelain=v2','-z','--untracked-files=all']);
    const snapshot=await new WorktreeCollector().refresh([dir]);
    assert.equal(snapshot.error,undefined);assert.equal(snapshot.entries.length,1);assert.equal(snapshot.entries[0].status?.untracked,1);
    assert.equal(snapshot.entries[0].status?.changed,1);
    assert.equal(await worktreeGit(dir,['status','--porcelain=v2','-z','--untracked-files=all']),before);
  }finally{await rm(dir,{recursive:true,force:true});}
});
