// Launcher supplies the complete worker allowlist before importing lab code.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const home=mkdtempSync(join(tmpdir(),'hud-unified-lab-'));
try {
  const child=spawn(process.execPath,[resolve('scripts/workbench/unified-runner.mjs'),...process.argv.slice(2)],{cwd:resolve('.'),stdio:'inherit',env:{HOME:home,HUD_HOME:home,CODEX_HOME:home,PATH:'/usr/bin:/bin',LANG:'C',TMPDIR:home}});
  const forward=(signal)=>{if(child.exitCode===null&&child.signalCode===null)child.kill(signal);};
  const interrupt=()=>forward('SIGINT'), terminate=()=>forward('SIGTERM');
  process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
  process.exitCode=result.code??1;
} finally {rmSync(home,{recursive:true,force:true});}
