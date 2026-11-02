// One real interactive Claude launch, with /clear; synthetic prompts only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const compiled = join(repo, 'packages/hud-mcp/dist');
const { IMPLEMENTATION, CLAUDE_VERSION, hookProfileFingerprint, makeHookSettings } = await import(
  pathToFileURL(join(compiled, 'packages/hud-mcp/src/hook/record.js'))
);
const { cleanupHookNamespace } = await import(pathToFileURL(join(compiled, 'packages/hud-mcp/src/hook/cleanup.js')));
const { openLedger } = await import(pathToFileURL(join(compiled, 'src/ledger/ledger.js')));
const output = process.argv[2];
if (!output?.startsWith('/')) throw new Error('Absolute evidence directory required');
mkdirSync(output, { recursive: true, mode: 0o700 });
const work = realpathSync(mkdtempSync(join(tmpdir(), 'hud-b1b-clear-')));
const home = join(work, 'hud');
mkdirSync(home, { mode: 0o700 });
const hooks = join(home, 'hook');
mkdirSync(hooks, { mode: 0o700 });
const ledgerPath = join(home, 'ledger.sqlite');
const ledger = await openLedger(ledgerPath);
await ledger.close();
const sourceRoot = realpathSync(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, '.claude'));
const executable = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
if (!spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.startsWith(CLAUDE_VERSION + ' '))
  throw new Error('Unsupported Claude');
const p = {
  name: 'synthetic-hook-probe',
  harness: 'claude',
  source: { root: sourceRoot, label: 'Synthetic probe' },
  launch: { argv: ['claude', '{{prompt}}'] },
  headless: null,
  resume: null,
  resumeHeadless: null,
  host: { kind: 'none', layout: 'none' },
  env: {},
  mcpServerName: 'b1bprobe',
  claimTransport: 'config_env',
  clientToolTimeoutMs: 60000,
  responseMarginMs: 2000,
  orphan_policy: 'continue',
  managedShellVerified: false,
  callSource: { kind: 'claude_pre_tool_use_v1' },
};
const config = {
  version: 1,
  implementation: IMPLEMENTATION,
  claudeVersion: CLAUDE_VERSION,
  claudeExecutable: realpathSync(executable),
  sourceRoot,
  ledgerPath,
  directory: hooks,
  serverName: 'b1bprobe',
  profileFingerprint: hookProfileFingerprint(p),
  clockTicksPerSecond: 100,
};
const configFile = join(home, 'config.json');
writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const settings = makeHookSettings(
  config,
  `${quote(process.execPath)} ${quote(join(repo, 'packages/hud-mcp/bin/hud-claude-hook.mjs'))} ${quote(configFile)}`
);
const log = join(output, 'calls.jsonl');
const mcp = {
  mcpServers: {
    b1bprobe: {
      command: process.execPath,
      args: [join(repo, 'tests/hud-mcp/hook-bench-real.mjs'), '--server', configFile, log],
      env: { HUD_HOME: home },
    },
  },
};
const mcpFile = join(home, 'mcp.json');
writeFileSync(mcpFile, JSON.stringify(mcp), { mode: 0o600 });
const prompt =
  'Synthetic timing probe: call mcp__b1bprobe__delegate_whoami with {} exactly once. Its error is expected. Reply OK, and do not call any other tools.';
const args = [
  'claude',
  '--model',
  'haiku',
  '--effort',
  'low',
  '--settings',
  JSON.stringify(settings),
  '--mcp-config',
  mcpFile,
  '--strict-mcp-config',
  '--allowedTools',
  'mcp__b1bprobe__delegate_whoami',
  '--',
  prompt,
];
const python = String.raw`
import os,pty,select,time,json,sys,fcntl,termios,struct,signal
args=json.loads(sys.argv[1]);work=sys.argv[2];out=sys.argv[3];log=sys.argv[4];prompt=sys.argv[5]
pid,fd=pty.fork()
if pid==0:
 os.chdir(work);os.environ['HUD_HOME']=work+'/hud';os.environ['TERM']='xterm-256color';os.environ.pop('CLAUDECODE',None);os.environ.pop('NODE_COMPILE_CACHE',None);os.execvp(args[0],args)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',40,160,0,0));terminal=open(out+'/terminal','wb');stages=[];screen=b''
def pump(seconds):
 global screen
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  ready,_,_=select.select([fd],[],[],min(.1,max(0,end-time.monotonic())))
  if ready:
   try:data=os.read(fd,65536)
   except OSError:return
   terminal.write(data);terminal.flush();screen=(screen+data)[-131072:]
   if b'\x1b[6n' in data:os.write(fd,b'\x1b[1;1R')
def send(text):
 os.write(fd,text.encode());pump(.2);os.write(fd,b'\r');stages.append({'mono':time.monotonic(),'send':text})
def calls():
 try:
  with open(log) as f:return [json.loads(s) for s in f if s.strip()]
 except:return []
try:
 pump(4)
 if b'trust' in screen.lower() and not calls():os.write(fd,b'\x1b[B\r');pump(4)
 deadline=time.monotonic()+70
 while len(calls())<1 and time.monotonic()<deadline:pump(.2)
 if not calls():stages.append({'failure':'no first call'})
 else:
  pump(4);send('/clear');pump(4);send(prompt)
  deadline=time.monotonic()+70
  while len(calls())<2 and time.monotonic()<deadline:pump(.2)
  pump(4)
 send('/exit');pump(2)
finally:
 with open(out+'/stages.json','w') as f:json.dump(stages,f,indent=2)
 try:os.kill(pid,signal.SIGTERM)
 except ProcessLookupError:pass
 pump(.2)
 try:os.waitpid(pid,0)
 except ChildProcessError:pass
 os.close(fd);terminal.close()
`;
try {
  const result = spawnSync('python3', ['-c', python, JSON.stringify(args), work, output, log, prompt], {
    env: process.env,
    timeout: 170000,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('PTY driver failed: ' + result.stderr);
  const rows = (() => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch {
      return [];
    }
  })();
  const sameHarness = rows.length >= 2 && rows[0].harnessPid === rows.at(-1).harnessPid;
  const changedRoot = rows.length >= 2 && rows[0].sessionId !== rows.at(-1).sessionId;
  const verified = rows.length >= 2 && rows.every((r) => r.sourceVerified);
  const stillAlive = [...new Set(rows.map((r) => r.mcpPid))].filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (stillAlive.length) throw new Error('Run MCP remained after owning harness exited');
  let removed = 0;
  for (const name of readdirSync(hooks)) {
    const result = cleanupHookNamespace(join(hooks, name));
    if (!result.complete) throw new Error('Cleanup incomplete');
    removed += result.removed;
  }
  const summary = {
    realRuns: 1,
    calls: rows,
    sameHarness,
    changedRoot,
    verified,
    cleanedFiles: removed,
    residentProcesses: 0,
    projectDirectory: join(sourceRoot, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-')),
  };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
