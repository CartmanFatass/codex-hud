/** Synthetic test construction only. Not selected into any runtime bundle. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { REQUIRED, INSTALLER_FILES, DEPENDENCIES, COMMANDS } from './manifest.mjs';
import { digest, json } from './safety.mjs';
const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function fixture(t, label = 'A') {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'hud-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  const prefix = path.join(root, "private space ';$() prefix");
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'unrelated');
  for (const dir of [bundle, prefix, home, cwd]) fs.mkdirSync(dir, { mode: 0o700 });
  const entries = [];
  for (const name of REQUIRED) {
    let data = Buffer.from(`fixture ${label}\n`);
    if (name === 'package.json' || name === 'packages/hud-mcp/package.json')
      data = json({ name: 'codex-hud', type: 'module', version: '0.0.0' });
    for (const [pkg, version] of Object.entries(DEPENDENCIES))
      if (name === `node_modules/${pkg}/package.json`) data = json({ name: pkg, version });
    if (Object.values(COMMANDS).includes(name))
      data = Buffer.from(
        name === 'bin/codex-hud'
          ? `#!/usr/bin/env bash\nprintf '%s\\n' '${label}'\n`
          : `#!/usr/bin/env node\nconsole.log(${JSON.stringify(label)});\n`
      );
    if (INSTALLER_FILES.includes(name)) data = fs.readFileSync(path.join(scripts, name));
    const target = path.join(bundle, name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const mode = name.startsWith('bin/') || name === 'install-runtime.mjs' ? 0o700 : 0o600;
    fs.writeFileSync(target, data, { mode });
    entries.push({
      path: name,
      bytes: data.length,
      sha256: digest(data),
      mode: mode.toString(8).padStart(4, '0'),
      origin: 'synthetic-fixture',
    });
  }
  const manifest = {
    schemaVersion: 1,
    repositorySha: 'a'.repeat(40),
    repositoryTree: 'b'.repeat(40),
    dirty: true,
    lockfileSha256: 'c'.repeat(64),
    platform: 'linux',
    nodeRequirement: '^22.13.0 || ^24.0.0',
    provenance: 'synthetic fixture, not publisher signature',
    capabilityLimitation: 'No capability qualification',
    entries,
  };
  fs.writeFileSync(path.join(bundle, 'RUNTIME-MANIFEST.json'), json(manifest), { mode: 0o600 });
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    HUD_HOME: path.join(home, 'never-created'),
  };
  return { root, bundle, prefix, home, cwd, env, manifest };
}
export function rewriteManifest(f, change) {
  change(f.manifest);
  fs.writeFileSync(path.join(f.bundle, 'RUNTIME-MANIFEST.json'), json(f.manifest));
}
// A bounded Linux subreaper harness owns and reaps both the runner and any orphan
// produced by an interrupted pre-fix runner. No broad PID/process-name cleanup.
export function interruptedRunnerCode() {
  return String.raw`
import ctypes, os, sys, subprocess, time, json, signal
ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)
node, module, root, signame = sys.argv[1:]
pidfile=os.path.join(root,'child.json'); marker='runtime-owned-interrupt-fixture'
child_js="const fs=require('node:fs');const stat=fs.readFileSync('/proc/self/stat','utf8');fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));setTimeout(()=>process.exit(0),5000);setInterval(()=>{},100);"
runner_js="import {runOwned} from "+json.dumps(module)+";try{await runOwned('interrupted',process.execPath,['-e',"+json.dumps(child_js)+","+json.dumps(pidfile)+","+json.dumps(marker)+"],"+json.dumps(root)+",process.env,"+json.dumps(root)+",1000);}catch(e){console.error(e.message);process.exitCode=1;}"
runner=None; child=None; reaped=False; reap_evidence=None; alive=None; error=None
started=time.monotonic(); started_wall=time.time(); deadline=started+7
try:
  runner=subprocess.Popen([node,'--input-type=module','-e',runner_js],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  while not os.path.exists(pidfile) and time.monotonic()<started+2:
    if runner.poll() is not None: raise RuntimeError('runner_exited_before_child')
    time.sleep(.01)
  child=json.load(open(pidfile)); runner.send_signal(getattr(signal,signame))
  try: runner.communicate(timeout=2)
  except subprocess.TimeoutExpired: raise RuntimeError('runner_did_not_terminate')
  while time.monotonic()<started+1.5: time.sleep(.01)
  try:
    stat=open('/proc/'+str(child['pid'])+'/stat').read(); fields=stat[stat.rfind(')')+2:].split()
    alive=fields[0]!='Z' and fields[19]==child['start']
  except FileNotFoundError: alive=False
except BaseException as e: error=str(e)
finally:
  if runner is not None and runner.poll() is None:
    runner.kill()
    try: runner.wait(timeout=1)
    except subprocess.TimeoutExpired: error=(error or '')+'; runner_reap_uncertain'
  if child is not None:
    try:
      stat=open('/proc/'+str(child['pid'])+'/stat').read(); fields=stat[stat.rfind(')')+2:].split()
      cmd=open('/proc/'+str(child['pid'])+'/cmdline','rb').read().split(b'\0')
      if fields[19]==child['start'] and marker.encode() in cmd and fields[0]!='Z': os.kill(child['pid'],signal.SIGKILL)
    except FileNotFoundError: pass
    while time.monotonic()<deadline:
      try:
        found,status=os.waitpid(child['pid'],os.WNOHANG)
        if found: reaped=True; reap_evidence='harness_waitpid'; break
      except ChildProcessError:
        if not os.path.exists('/proc/'+str(child['pid'])): reaped=True; reap_evidence='already_gone_not_harness_waited'; break
      time.sleep(.01)
receipt_path=os.path.join(root,'interrupted.receipt.json')
receipt=json.load(open(receipt_path)) if os.path.exists(receipt_path) else None
print(json.dumps({'startedAtMs':int(started_wall*1000),'deadlineAtMs':int((started_wall+7)*1000),'aliveAfterDeadline':alive,'reaped':reaped,'reapEvidence':reap_evidence,'error':error,'receipt':receipt,'runnerCode':runner.returncode if runner else None}))
`;
}
export function installedSignalCode() {
  return String.raw`
import ctypes, os, sys, subprocess, time, json, signal
ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)
entry, root, signame = sys.argv[1:]
budget=9 if signame=='NONE' else 7
pidfile=os.path.join(root,'payload.json'); marker='runtime-installed-signal-fixture'
launcher=None; child=None; reaped=False; reap_evidence=None; alive=None; error=None; output=None; errors=None
started=time.monotonic(); started_wall=time.time(); deadline=started+budget
try:
  launcher=subprocess.Popen([entry,pidfile,marker],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  while not os.path.exists(pidfile) and time.monotonic()<started+2:
    if launcher.poll() is not None: raise RuntimeError('launcher_exited_before_payload')
    time.sleep(.01)
  child=json.load(open(pidfile))
  if signame!='NONE': launcher.send_signal(getattr(signal,signame))
  try:
    launcher.wait(timeout=6 if signame=='NONE' else 2)
  except subprocess.TimeoutExpired: raise RuntimeError('launcher_did_not_terminate')
  time.sleep(.1)
  try:
    stat=open('/proc/'+str(child['pid'])+'/stat').read(); fields=stat[stat.rfind(')')+2:].split()
    alive=fields[0]!='Z' and fields[19]==child['start']
  except FileNotFoundError: alive=False
except BaseException as e: error=str(e)
finally:
  if launcher is not None and launcher.poll() is None:
    launcher.kill()
    try: launcher.wait(timeout=1)
    except subprocess.TimeoutExpired: error=(error or '')+'; launcher_reap_uncertain'
  if child is not None:
    try:
      stat=open('/proc/'+str(child['pid'])+'/stat').read(); fields=stat[stat.rfind(')')+2:].split()
      cmd=open('/proc/'+str(child['pid'])+'/cmdline','rb').read().split(b'\0')
      if fields[19]==child['start'] and marker.encode() in cmd and fields[0]!='Z': os.kill(child['pid'],signal.SIGKILL)
    except FileNotFoundError: pass
    while time.monotonic()<deadline:
      try:
        found,status=os.waitpid(child['pid'],os.WNOHANG)
        if found: reaped=True; reap_evidence='harness_waitpid'; break
      except ChildProcessError:
        if not os.path.exists('/proc/'+str(child['pid'])): reaped=True; reap_evidence='already_gone_not_harness_waited'; break
      time.sleep(.01)
if launcher is not None:
  try: output,errors=launcher.communicate(timeout=1)
  except subprocess.TimeoutExpired: error=(error or '')+'; output_observation_uncertain'
print(json.dumps({'startedAtMs':int(started_wall*1000),'deadlineAtMs':int((started_wall+budget)*1000),'aliveAfterSignal':alive,'reaped':reaped,'reapEvidence':reap_evidence,'error':error,'payload':child,'launcherPid':launcher.pid if launcher else None,'parentPid':os.getpid(),'launcherCode':launcher.returncode if launcher else None,'stderr':errors.decode() if errors else None}))
`;
}
export function replaceFixtureFile(f, name, data) {
  fs.writeFileSync(path.join(f.bundle, name), data);
  const entry = f.manifest.entries.find((entry) => entry.path === name);
  entry.bytes = Buffer.byteLength(data);
  entry.sha256 = digest(Buffer.from(data));
  rewriteManifest(f, () => {});
}
