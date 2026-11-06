// SIMULATED Codex target. Direct Node child of owned ELF fixture. Real registry,
// resolver, ledger, handshake and report paths; no network/model/provider.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.env.SYNTHETIC_NATIVE_REPO;
const load = (p) => import(pathToFileURL(join(repo, 'packages/hud-mcp/dist', p)));
const { LinuxProcessReader } = await load('packages/hud-mcp/src/process.js');
const { registerCaller } = await load('packages/hud-mcp/src/registry.js');
const { createLedgerCallerRegistry } = await load('packages/hud-mcp/src/ledger-registry.js');
const { validateDelegateConfig } = await load('packages/hud-mcp/src/config.js');
const { SessionRefResolver } = await load('packages/hud-mcp/src/resolvers.js');
const { DelegationService } = await load('packages/hud-mcp/src/delegation.js');
const { ReadOnlyScopeSnapshot } = await load('src/core/ledger-scope-read.js');
const { createManagedNativeRuntime } = await load('packages/hud-mcp/src/managed-runtime.js');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++)
  if (argv[i] === '-c') {
    const setting = argv[++i];
    const match = setting.match(/^mcp_servers\.hud\.env\.(HUD_[A-Z_]+)=(.*)$/);
    if (match) process.env[match[1]] = JSON.parse(match[2]);
  }
let brief = '';
for await (const chunk of process.stdin) brief += chunk;
assert.ok(brief.includes('delegate_whoami') && brief.includes('delegate_report'));
const resumed = argv.includes('resume');
const hex = Date.now().toString(16).padStart(12, '0');
const sessionId = resumed
  ? argv[argv.indexOf('resume') + 1]
  : `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000001`;
const date = new Date(parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16));
const dir = join(
  process.env.CODEX_HOME,
  'sessions',
  String(date.getUTCFullYear()),
  String(date.getUTCMonth() + 1).padStart(2, '0'),
  String(date.getUTCDate()).padStart(2, '0')
);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const record = join(dir, `rollout-simulated-${sessionId}.jsonl`);
if (!resumed)
  writeFileSync(
    record,
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cli_version: '0.166.0', source: 'exec' } }) + '\n',
    { mode: 0o600, flag: 'wx' }
  );
else assert.equal(JSON.parse(readFileSync(record, 'utf8').split('\n')[0]).payload.id, sessionId);
const home = process.env.HUD_HOME;
const config = validateDelegateConfig(JSON.parse(readFileSync(join(home, 'delegate.json'), 'utf8')));
const selected = config.profiles.find((p) => p.name === 'native-target');
const reader = new LinuxProcessReader();
const registry = await createLedgerCallerRegistry(home);
const registration = await registerCaller({
  reader,
  registry,
  profile: selected,
  pid: process.pid,
  cwd: () => process.cwd(),
  envPane: null,
  nowMs: Date.now(),
});
const runtime = await createManagedNativeRuntime({ registration, reader, config, selected, env: process.env });
const scopes = new ReadOnlyScopeSnapshot(join(home, 'ledger.sqlite'));
const resolver = new SessionRefResolver(registration, reader, selected, undefined, undefined, scopes);
const service = new DelegationService({
  ledger: registry.ledger,
  home,
  config,
  registration,
  reader,
  capability: runtime.capability,
  hudRunPath: join(repo, 'bin/hud-run'),
});
let n = 0;
const call = async (tool, args = {}) => {
  const meta = {
    callId: `simulated-${++n}`,
    sessionId,
    threadId: sessionId,
    'x-codex-turn-metadata': {
      session_id: sessionId,
      thread_id: sessionId,
      thread_source: 'user',
      turn_trigger: 'exec',
      codex_version: '0.166.0',
    },
  };
  return service.invoke(await resolver.resolve(meta, tool), tool, args);
};
try {
  let who;
  for (let attempt = 0; attempt < 12; attempt++) {
    who = await call('delegate_whoami');
    if (who.state !== 'pending') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(who.ok && who.state !== 'pending', JSON.stringify(who));
  const report = await call('delegate_report', {
    runId: process.env.HUD_RUN,
    status: 'completed',
    summary: 'SIMULATED native target completed',
  });
  assert.equal(report.ok, true);
  process.stdout.write(
    JSON.stringify({ synthetic: true, resumed, sessionId, who, report, parentPid: process.ppid }) + '\n'
  );
} finally {
  await service.close();
  await registry.ledger.close();
}
