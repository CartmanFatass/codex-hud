import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, digest } from '../../core/canonical.js';

export const CLAUDE_RUN_ENV = [
  'HUD_CLAIM',
  'HUD_RUN',
  'HUD_LINK',
  'HUD_HOME',
  'HUD_MCP_PROFILE',
  'HUD_CLAUDE_HOOK_CONFIG',
] as const;
export interface ClaudeManagedServer {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface Layer {
  path: string;
  state: 'missing' | 'file';
  sha256: string | null;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 16384 && !value.includes('\0');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Every component is opened relative to a held parent descriptor. Leaf-only
 * O_NOFOLLOW after path-based lstat is insufficient: a parent can be swapped
 * while the read is pending, then restored before post-read path checks.
 */
async function openAnchored(file: string, directory = false): Promise<FileHandle> {
  if (!isAbsolute(file) || resolve(file) !== file || file.includes('\0'))
    throw new Error('claude_configuration_invalid_path');
  const parts = file.split('/').filter(Boolean);
  if (!parts.length || parts.length > 128) throw new Error('claude_configuration_invalid_path');
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let parent: FileHandle | undefined = await fs.open('/', directoryFlags);
  try {
    for (let index = 0; index < parts.length; index++) {
      const last = index === parts.length - 1;
      const flags =
        !last || directory ? directoryFlags : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
      const next = await fs.open(`/proc/self/fd/${parent.fd}/${parts[index]}`, flags);
      await parent.close();
      parent = next;
    }
    const result = parent;
    parent = undefined;
    return result;
  } catch (error) {
    if (['ELOOP', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code)))
      throw new Error('claude_configuration_symlink');
    throw error;
  } finally {
    await parent?.close();
  }
}

/** Bounded, no-follow local inputs. This snapshot deliberately does not reconstruct
 * Claude's effective merge, remote managed policy, plugin or connector discovery.
 */
export async function claudeManagedConfiguration(sourceRoot: string, cwd: string, serverName: string) {
  if (!text(serverName) || serverName.length > 256) throw new Error('hud_stdio_server_unavailable');
  const layers: Layer[] = [];
  const candidates: ClaudeManagedServer[] = [];
  let remaining = 1024 * 1024;
  const read = async (file: string): Promise<Record<string, unknown> | null> => {
    let handle: FileHandle;
    try {
      handle = await openAnchored(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      layers.push({ path: file, state: 'missing', sha256: null });
      return null;
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 131072 || before.size > remaining)
        throw new Error('claude_configuration_limit');
      const bytes = Buffer.alloc(before.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await handle.read(bytes, size, bytes.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const after = await handle.stat();
      if (
        size !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error('claude_configuration_changed');
      remaining -= size;
      const content = bytes.subarray(0, size);
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
      if (!object(value)) throw new Error('claude_configuration_invalid');
      layers.push({ path: file, state: 'file', sha256: sha256(content) });
      return value;
    } finally {
      await handle.close();
    }
  };
  const settings = (value: Record<string, unknown> | null) => {
    if (!value) return;
    if (value.disableAllHooks === true || value.allowManagedHooksOnly === true) throw new Error('claude_hook_disabled');
    for (const key of ['disabledMcpServers', 'disabledMcpjsonServers'])
      if (Array.isArray(value[key]) && value[key].includes(serverName)) throw new Error('hud_stdio_server_disabled');
    if (
      Array.isArray(value.deniedMcpServers) &&
      value.deniedMcpServers.some((item) => item === serverName || (object(item) && item.serverName === serverName))
    )
      throw new Error('hud_stdio_server_disabled');
    // These settings would replace the exact launch source or hook contract.
    if (
      object(value.env) &&
      Object.keys(value.env).some(
        (key) => key.startsWith('HUD_') || key === 'CLAUDE_CONFIG_DIR' || key === 'CLAUDE_CODE_SIMPLE'
      )
    )
      throw new Error('claude_configuration_source_override');
  };
  const select = (value: Record<string, unknown> | null) => {
    if (!value) return;
    settings(value);
    if (value.mcpServers === undefined) return;
    if (!object(value.mcpServers)) throw new Error('claude_configuration_invalid');
    if (!Object.hasOwn(value.mcpServers, serverName)) return;
    const server = value.mcpServers[serverName];
    if (
      !object(server) ||
      (server.type !== undefined && server.type !== 'stdio') ||
      !text(server.command) ||
      Object.keys(server).some((key) => !['type', 'command', 'args', 'env'].includes(key)) ||
      (server.args !== undefined &&
        (!Array.isArray(server.args) || server.args.length > 128 || !server.args.every(text))) ||
      (server.env !== undefined &&
        (!object(server.env) ||
          Object.values(server.env).some((value) => typeof value !== 'string' || value.includes('\0'))))
    )
      throw new Error('hud_stdio_server_unavailable');
    candidates.push(structuredClone(server) as unknown as ClaudeManagedServer);
  };
  const global = await read(join(sourceRoot, '.claude.json'));
  select(global);
  if (global?.projects !== undefined) {
    if (!object(global.projects)) throw new Error('claude_configuration_invalid');
    const local = global.projects[cwd];
    if (local !== undefined && !object(local)) throw new Error('claude_configuration_invalid');
    if (object(local)) select(local);
  }
  select(await read(join(cwd, '.mcp.json')));
  for (const file of [
    join(sourceRoot, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ])
    settings(await read(file));
  const managed = '/etc/claude-code';
  settings(await read(join(managed, 'managed-settings.json')));
  select(await read(join(managed, 'managed-mcp.json')));
  const dropins = join(managed, 'managed-settings.d');
  let dropinHandle: FileHandle | undefined;
  try {
    dropinHandle = await openAnchored(dropins, true);
    const directory = await fs.opendir(`/proc/self/fd/${dropinHandle.fd}`);
    let count = 0;
    try {
      for await (const entry of directory) {
        if (++count > 64) throw new Error('claude_configuration_limit');
        if (entry.name.endsWith('.json')) settings(await read(join(dropins, entry.name)));
      }
    } finally {
      try {
        await directory.close();
      } catch {}
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    layers.push({ path: dropins, state: 'missing', sha256: null });
  } finally {
    await dropinHandle?.close();
  }
  if (!candidates.length) throw new Error('hud_stdio_server_unavailable');
  const selected = candidates[0];
  if (candidates.some((candidate) => canonicalJson(candidate) !== canonicalJson(selected)))
    throw new Error('hud_stdio_server_ambiguous');
  const description = {
    schema: 'claude-managed-target-local-inputs-v1',
    discovery: 'default' as const,
    coverage: 'partial' as const,
    limitations: ['remote-policy', 'plugins', 'connectors', 'effective-merge', 'configuration-change-after-snapshot'],
    layers: layers.sort((a, b) => a.path.localeCompare(b.path)),
    serverName,
    server: {
      ...selected,
      env: Object.fromEntries(
        Object.entries(selected.env ?? {}).filter(([key]) => !(CLAUDE_RUN_ENV as readonly string[]).includes(key))
      ),
    },
  };
  return { server: selected, fingerprint: digest(description), coverage: 'partial' as const };
}
