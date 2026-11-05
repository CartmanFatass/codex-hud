// Launcher only: the entire lab worker and all descendants receive no ambient credentials.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const home=mkdtempSync(join(tmpdir(),'hud-vertical-lab-'));
try {
  const result=spawnSync(process.execPath,[resolve('scripts/workbench/vertical-runner.mjs'),...process.argv.slice(2)],{
    cwd:resolve('.'), stdio:'inherit', env:{HOME:home,HUD_HOME:home,CODEX_HOME:home,PATH:'/usr/bin:/bin',LANG:'C',TMPDIR:home}
  });
  if (result.error) throw result.error;
  process.exitCode=result.status ?? 1;
} finally { rmSync(home,{recursive:true,force:true}); }
