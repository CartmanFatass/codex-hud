import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { loadDelegateConfig } from './config.js';
import { LinuxProcessReader } from './process.js';
import { FileCallerRegistry, MemoryCallerRegistry, registerCaller } from './registry.js';
import { createLedgerCallerRegistry } from './ledger-registry.js';
import { SessionRefResolver } from './resolvers.js';
import { HudMcpServer, serveStdio } from './server.js';
const home = process.env.HUD_HOME;
if (!home || !isAbsolute(home)) throw new Error('HUD_HOME must name an absolute private HUD directory');
const file = join(home, 'delegate.json');
const config = existsSync(file) ? loadDelegateConfig(file) : { version: 1, profiles: [] };
const profileName = process.env.HUD_MCP_PROFILE;
const profile = config.profiles.find((p) => p.name === profileName) ?? null;
if (profileName && !profile) throw new Error('HUD_MCP_PROFILE is not present in delegate.json');
const reader = new LinuxProcessReader();
const fakeDirectory = process.env.HUD_MCP_REGISTRY_DIR;
if (fakeDirectory && !isAbsolute(fakeDirectory)) throw new Error('HUD_MCP_REGISTRY_DIR must be absolute');
const registry = existsSync(join(home, 'ledger.sqlite'))
  ? await createLedgerCallerRegistry(home)
  : fakeDirectory
    ? new FileCallerRegistry(fakeDirectory)
    : new MemoryCallerRegistry();
const registration = await registerCaller({
  reader,
  registry,
  profile,
  pid: process.pid,
  cwd: () => process.cwd(),
  envPane: process.env.HERDR_PANE_ID ?? null,
  nowMs: Date.now(),
});
await serveStdio(
  new HudMcpServer(new SessionRefResolver(registration, reader, profile)),
  process.stdin,
  process.stdout
);
