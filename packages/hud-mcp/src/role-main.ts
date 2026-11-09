/**
 * Role-facade MCP entry. It serves hud_roster, hud_create, hud_read, hud_send,
 * hud_respond, and hud_close. It does not construct the native agent host.
 *
 * Live sessions keep the managed_* tool list until R6. A new session opts into
 * this surface with HUD_MCP_SURFACE=roles.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { PiEvidenceChannel } from './pi-channel.js';
import { RoleCallSource } from './role-source.js';
import { createRoleJevExecutor } from '../../../src/roles/facade.js';
import { ParentLifetime } from './lifetime.js';
import { RoleFacadeTools } from './role-extension.js';
import { HudMcpServer, serveStdioProcess } from './server.js';

const home = process.env.HUD_HOME;
if (!home || !isAbsolute(home)) throw new Error('HUD_HOME must name an absolute private HUD directory');
const directory = lstatSync(home);
if (
  !directory.isDirectory() ||
  directory.isSymbolicLink() ||
  realpathSync(home) !== home ||
  directory.uid !== process.getuid?.() ||
  (directory.mode & 0o077) !== 0
) {
  throw new Error('HUD_HOME must be a private owned directory');
}

const lifetime = new ParentLifetime();
const pi = process.env.HUD_PI_DELEGATION_FD === '3' ? PiEvidenceChannel.inherited() : null;
const source = new RoleCallSource(undefined, pi);
const server = new HudMcpServer(
  source,
  undefined,
  () => lifetime.alive(),
  undefined,
  new RoleFacadeTools(home, process.env, createRoleJevExecutor(home), (resolved) => source.assertCurrent(resolved))
);
const { discardPendingOutput } = await serveStdioProcess(server, () => lifetime.alive());
pi?.close();
if (discardPendingOutput) process.exit(0);
