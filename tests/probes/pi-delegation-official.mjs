/** Optional no-model probe using an already installed official Pi 1.4.0 package.
 * Usage: node tests/probes/pi-delegation-official.mjs /absolute/pi-coding-agent
 * Real vendor loader/context/process + product extension/MCP. Synthetic session,
 * explicit callback invocation, no model/provider/native-agent validation.
 */
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const pkg = await realpath(process.argv[2]);
const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@earendil-works/pi-coding-agent');
assert.equal(manifest.version, '1.4.0');
const root = await realpath(await mkdtemp(join(tmpdir(), 'hud-pi-official-')));
const sessions = join(root, 'sessions'),
  home = join(root, 'hud'),
  repo = resolve('.');
await mkdir(sessions);
await mkdir(home, { mode: 0o700 });
await mkdir(join(root, 'home'));
const id = '11111111-1111-4111-8111-111111111111',
  session = join(sessions, 'synthetic.jsonl');
await writeFile(
  session,
  JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-11-05T00:00:00.000Z', cwd: root }) + '\n'
);
await writeFile(
  join(home, 'delegate.json'),
  JSON.stringify({
    version: 1,
    profiles: [
      {
        name: 'pi',
        harness: 'pi',
        source: { root: sessions, label: 'Official no-model probe' },
        launch: { argv: ['/bin/false'] },
        headless: null,
        resume: null,
        resumeHeadless: null,
        host: { kind: 'none', layout: 'none' },
        env: {},
        mcpServerName: 'hud',
        claimTransport: 'config_env',
        clientToolTimeoutMs: null,
        responseMarginMs: 1000,
        orphan_policy: 'continue',
        managedShellVerified: false,
        callSource: { kind: 'pi_extension_v1' },
      },
    ],
  })
);
const probe = join(root, 'probe.ts');
await writeFile(
  probe,
  `import {writeFileSync} from 'node:fs';
import {VERSION} from '@earendil-works/pi-coding-agent';
import hudDelegate from ${JSON.stringify(join(repo, 'extensions/pi/hud-delegate.ts'))};
import {LinuxProcessReader} from ${JSON.stringify(join(repo, 'packages/hud-mcp/dist/packages/hud-mcp/src/process.js'))};
export default function probe(pi) {
  const tools = new Map();
  // Register on the real official API; retain callbacks only for this explicit no-model probe.
  hudDelegate(new Proxy(pi,{get(target,key){if(key==='registerTool')return tool=>{tools.set(tool.name,tool);target.registerTool(tool)};return target[key]}}));
  pi.on('session_start',async(_event,ctx)=>{
    const result={version:VERSION,osArgv:new LinuxProcessReader().get(process.pid).argv.filter(Boolean),sessionId:ctx.sessionManager.getSessionId(),sessionDir:ctx.sessionManager.getSessionDir(),tools:[...tools.keys()]};
    try { await tools.get('delegate_whoami').execute('official-who',{},undefined,undefined,ctx); } catch(error) {result.who=error.message;}
    try { result.list=await tools.get('delegate_list').execute('official-list',{},undefined,undefined,ctx); } catch(error) {result.error=error.message;}
    writeFileSync(${JSON.stringify(join(root, 'result.json'))},JSON.stringify(result));ctx.shutdown();
  });
}
`
);
let child;
try {
  child = spawn(
    process.execPath,
    [
      join(pkg, manifest.bin.pi),
      '--session-dir',
      sessions,
      '--session',
      session,
      '--mode',
      'rpc',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '-e',
      probe,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        HOME: join(root, 'home'),
        PI_CODING_AGENT_DIR: join(root, 'home/.pi'),
        HUD_HOME: home,
        HUD_MCP_PROFILE: 'pi',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  // In RPC mode shutdown requests are honored after an input command.
  // get_state is a read-only, no-model command, buffered until startup finishes.
  child.stdin.write(JSON.stringify({ id: 'finish-no-model-probe', type: 'get_state' }) + '\n');
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const code = await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  let diagnostic;
  try {
    diagnostic = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
  } catch {}
  assert.equal(
    code,
    0,
    JSON.stringify({ output: output.slice(0, 16384), result: diagnostic, signal: child.signalCode })
  );
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
  assert.equal(result.version, '1.4.0');
  assert.deepEqual(result.osArgv, ['pi']);
  assert.equal(result.sessionId, id);
  assert.equal(result.sessionDir, sessions);
  assert.equal(JSON.parse(result.who).code, 'claim_missing');
  assert.equal(result.list?.details.ok, true, JSON.stringify(result));
  const db = new DatabaseSync(join(home, 'ledger.sqlite'), { readOnly: true });
  const contexts = db.prepare('SELECT session_ref FROM caller_contexts').all();
  db.close();
  assert.equal(contexts.length, 1);
  assert.equal(JSON.parse(contexts[0].session_ref)[2], id);
  console.log(
    JSON.stringify(
      {
        pass: true,
        version: result.version,
        mode: 'official-client-no-model',
        processTitleErased: true,
        tools: result.tools,
        rootBound: true,
        list: result.list.details,
        providerValidation: false,
      },
      null,
      2
    )
  );
} finally {
  if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}
