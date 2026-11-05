import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalJson, digest } from '../core/canonical.js';
import { nativeFile } from './claude-tmux.js';
import {
  observeWindowsPolicy,
  queryWindowsRegistry,
  type WindowsPolicyPorts,
  type WindowsPolicyResult,
} from './claude-windows-policy.js';

/** Local inputs only, not a claim to reconstruct Claude's effective merge.
 * Discovery references (accessed 2026-11-05):
 * https://code.claude.com/docs/en/settings
 * https://code.claude.com/docs/en/claude-directory
 * https://code.claude.com/docs/en/mcp
 * https://code.claude.com/docs/en/managed-settings
 * https://code.claude.com/docs/en/managed-mcp
 */
export interface ClaudeConfiguration {
  description: {
    schema: 'claude-local-inputs-v1';
    selection: 'default-user-project-local';
    remote: 'bedrock-no-remote-settings-or-connectors';
    bookkeepingDependencies: string[];
    projectLocalTracked: boolean | null;
    layers: { role: string; state: 'missing' | 'file' | 'directory'; fingerprint: string | null }[];
  };
  /** Canonical paths and file/parent identity are private per-launch observations. */
  receipt: { cwd: string; files: FileReceipt[] };
}
interface FileReceipt {
  path: string;
  state: 'missing' | 'file' | 'directory';
  parents: { path: string; dev: string; ino: string }[];
  file: { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string } | null;
  fingerprint: string | null;
}
export interface ClaudeConfigurationRequest {
  sourceRoot: string;
  cwd: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  version: string;
  kernel: string;
  settings: Record<string, unknown>;
}
export interface ClaudeConfigurationResult {
  observation: ClaudeConfiguration | null;
  reason: string | null;
  /** Partial evidence is never an input to capability matching or dispatch. */
  candidate?: ClaudeUnverifiedCandidate;
}
export interface ClaudeUnverifiedCandidate {
  schema: 'claude-unverified-local-metadata-v1';
  status: 'unverified';
  platform: 'linux' | 'wsl';
  version: string;
  kernel: string;
  provider: { requested: 'bedrock' | 'ordinary-or-other'; authentication: 'unobserved' };
  blockers: string[];
  windows: WindowsPolicyResult | null;
  /** Metadata only: no configuration, account or credential bytes are read. */
  localLayers: { role: string; receipt: FileReceipt }[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
/** A referenced bookkeeping value becomes a configuration input, not an exemption. */
export function bookkeepingDependencies(value: unknown): string[] {
  const text = canonicalJson(value);
  return ['PWD', 'OLDPWD', '_'].filter((name) => new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`).test(text));
}
const metadata = (s: BigIntStats) => ({
  dev: String(s.dev),
  ino: String(s.ino),
  size: String(s.size),
  mtimeNs: String(s.mtimeNs),
  ctimeNs: String(s.ctimeNs),
});

/** No symlinks, devices, unbounded reads, guessed missing files or raw data output. */
function capture(
  path: string,
  budget: { bytes: number },
  contents = true
): { receipt: FileReceipt; value: Record<string, unknown> | null; entries: string[] | null } {
  if (!isAbsolute(path) || path.includes('\0') || path !== join(parse(path).root, relative(parse(path).root, path)))
    throw new Error('configuration_path_unverified');
  const parents: FileReceipt['parents'] = [];
  const parts = relative('/', path).split('/');
  if (parts.length > 64) throw new Error('configuration_path_too_deep');
  let current = '/';
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = join(current, parts[index]);
    let info;
    try {
      info = lstatSync(current, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('configuration_unreadable');
      return {
        receipt: { path, state: 'missing', parents, file: null, fingerprint: null },
        value: null,
        entries: null,
      };
    }
    if (info.isSymbolicLink()) throw new Error('configuration_symlink_unverified');
    if (index < parts.length - 1) {
      if (!info.isDirectory()) throw new Error('configuration_parent_unverified');
      parents.push({ path: current, dev: String(info.dev), ino: String(info.ino) });
      continue;
    }
    if (info.isDirectory()) {
      if (!contents)
        return {
          receipt: { path, state: 'directory', parents, file: metadata(info), fingerprint: null },
          value: null,
          entries: null,
        };
      const entries: string[] = [];
      const directory = opendirSync(current);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (entries.length === 128) throw new Error('configuration_directory_too_large');
          entries.push(entry.name);
        }
      } finally {
        directory.closeSync();
      }
      entries.sort();
      return {
        receipt: { path, state: 'directory', parents, file: metadata(info), fingerprint: digest(entries) },
        value: null,
        entries,
      };
    }
    if (!contents) {
      if (!info.isFile()) throw new Error('configuration_file_unverified');
      return {
        receipt: { path, state: 'file', parents, file: metadata(info), fingerprint: null },
        value: null,
        entries: null,
      };
    }
    if (!info.isFile() || info.size > 262144n || Number(info.size) > budget.bytes)
      throw new Error('configuration_file_unverified');
    let fd: number | undefined;
    try {
      fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || !equal(metadata(info), metadata(before))) throw new Error('configuration_changed');
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, length);
        if (!count) break;
        length += count;
      }
      const after = fstatSync(fd, { bigint: true });
      if (BigInt(length) !== before.size || !equal(metadata(before), metadata(after)))
        throw new Error('configuration_changed');
      budget.bytes -= length;
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      if (!object(value)) throw new Error('configuration_not_object');
      return {
        receipt: { path, state: 'file', parents, file: metadata(after), fingerprint: digest(value) },
        value,
        entries: null,
      };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw new Error('configuration_path_unverified');
}

// Additional discovery or computed configuration is deliberately outside this
// file-backed slice. Unknown settings keys do not silently acquire coverage.
const settingsKeys = new Set([
  '$schema',
  'permissions',
  'hooks',
  'env',
  'model',
  'effortLevel',
  'language',
  'statusLine',
  'disableAllHooks',
  'disableClaudeAiConnectors',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'enabledMcpServers',
  'disabledMcpServers',
  'allowedMcpServers',
  'deniedMcpServers',
  'allowManagedMcpServersOnly',
  'allowManagedHooksOnly',
  'allowManagedPermissionRulesOnly',
  'skipDangerousModePermissionPrompt',
]);
function supportedSettings(value: Record<string, unknown>) {
  if (Object.keys(value).some((key) => !settingsKeys.has(key))) throw new Error('configuration_settings_key_uncovered');
  if (value.env !== undefined) {
    if (!object(value.env) || Object.values(value.env).some((v) => typeof v !== 'string'))
      throw new Error('configuration_env_unverified');
    if (
      Object.keys(value.env).some((key) =>
        /^(?:CLAUDE_|ANTHROPIC_|HUD_|LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|ENV$|BASH_ENV$)/.test(key)
      )
    )
      throw new Error('configuration_env_selector_uncovered');
  }
}
function supportedMcp(value: unknown) {
  if (value === undefined) return;
  if (!object(value)) throw new Error('configuration_mcp_unverified');
  for (const server of Object.values(value)) {
    if (!object(server) || Object.hasOwn(server, 'headersHelper') || Object.hasOwn(server, 'serverInstructions'))
      throw new Error('configuration_mcp_helper_uncovered');
    if (Object.keys(server).some((key) => !['type', 'command', 'args', 'env', 'url', 'headers', 'oauth'].includes(key)))
      throw new Error('configuration_mcp_key_uncovered');
  }
}

// This is a finite projection for the already-supported 2.1.305 file-backed
// lane. Do not infer that an arbitrary new field is statistics from its name.
const globalSelectionKeys = new Set(['mcpServers']);
const projectSelectionKeys = new Set([
  'mcpServers',
  'allowedTools',
  'mcpContextUris',
  'hasTrustDialogAccepted',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'enabledMcpServers',
  'disabledMcpServers',
]);
function routineStatistic(key: string, value: unknown): boolean {
  if (key === 'numStartups') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (key === 'lastCost') return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (key === 'lastSessionId')
    return value === null || (typeof value === 'string' && value.length <= 256 && !value.includes('\0'));
  return false;
}
function configurationSelection(value: Record<string, unknown>, scope: 'global' | 'project') {
  const selected: Record<string, unknown> = {};
  const allowed = scope === 'global' ? globalSelectionKeys : projectSelectionKeys;
  for (const [key, field] of Object.entries(value)) {
    if (allowed.has(key)) selected[key] = field;
    else if (!routineStatistic(key, field)) throw new Error(`configuration_${scope}_selector_uncovered`);
  }
  supportedMcp(selected.mcpServers);
  return selected;
}

function globalAndLocalSelection(value: Record<string, unknown>, cwd: string) {
  if (value.projects !== undefined && !object(value.projects)) throw new Error('configuration_projects_unverified');
  const { projects, ...global } = value;
  const project = (projects as Record<string, unknown> | undefined)?.[cwd] ?? null;
  if (project !== null && !object(project)) throw new Error('configuration_project_unverified');
  return {
    global: configurationSelection(global, 'global'),
    selectedProject: project === null ? null : configurationSelection(project, 'project'),
  };
}

function trustedGitExecutable(): string {
  const binary = realpathSync('/usr/bin/git');
  if (!nativeFile(binary)) throw new Error('configuration_git_untrusted');
  for (let path = binary; ; path = dirname(path)) {
    const info = lstatSync(path);
    if (info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('configuration_git_untrusted');
    if (path === '/') break;
  }
  return binary;
}

/** A bounded inventory, not a configuration identity or an effective merge.
 * In particular, absence under /etc cannot establish Windows policy absence:
 * WSL may inherit HKLM, Windows managed files/drop-ins and HKCU. Only an
 * explicitly trusted host adapter may supply the Windows executable/mapping;
 * no environment variable or assumed /mnt/c location establishes that trust.
 * https://code.claude.com/docs/en/managed-settings (accessed 2026-11-05)
 */
function unverifiedCandidate(
  request: ClaudeConfigurationRequest,
  managedRoot: string,
  wsl: boolean,
  remote: boolean,
  windowsPorts?: Pick<WindowsPolicyPorts, 'system'> & Partial<Pick<WindowsPolicyPorts, 'query'>>
): ClaudeConfigurationResult {
  const blockers = [
    'configuration_contents_unobserved',
    'configuration_selection_unobserved',
    'configuration_global_account_and_mcp_unobserved',
    'configuration_extensions_unobserved',
    'configuration_authentication_unobserved',
  ];
  if (remote) blockers.push('configuration_remote_sources_unobserved', 'configuration_connectors_unobserved');
  const windowsBudget = { bytes: 1048576 };
  const windows = wsl
    ? observeWindowsPolicy(
        request.version,
        windowsPorts && {
          ...windowsPorts,
          query: windowsPorts.query ?? queryWindowsRegistry,
          read: (path) => capture(path, windowsBudget),
        }
      )
    : null;
  if (windows?.reason) blockers.push(windows.reason);
  if (windows?.observation) blockers.push('configuration_windows_effective_merge_unverified');
  const candidate: ClaudeUnverifiedCandidate = {
    schema: 'claude-unverified-local-metadata-v1',
    status: 'unverified',
    platform: wsl ? 'wsl' : 'linux',
    version: request.version,
    kernel: request.kernel,
    provider: { requested: remote ? 'ordinary-or-other' : 'bedrock', authentication: 'unobserved' },
    blockers,
    windows,
    localLayers: [],
  };
  // Fixed paths only. Directory contents and global account/credential stores
  // are deliberately not enumerated. Selector args/env cannot redirect probes.
  for (const [role, path] of [
    ['user-settings', join(request.sourceRoot, 'settings.json')],
    ['project-settings', join(request.cwd, '.claude/settings.json')],
    ['project-local-settings', join(request.cwd, '.claude/settings.local.json')],
    ['project-mcp', join(request.cwd, '.mcp.json')],
    ['managed-settings', join(managedRoot, 'managed-settings.json')],
    ['managed-mcp', join(managedRoot, 'managed-mcp.json')],
    ['managed-dropins', join(managedRoot, 'managed-settings.d')],
  ]) {
    try {
      candidate.localLayers.push({ role, receipt: capture(path, { bytes: 0 }, false).receipt });
    } catch (error) {
      // Keep already-observed metadata, never turn an unreadable layer into a
      // missing one or expose filesystem error text that may contain user data.
      const reason =
        error instanceof Error && error.message.startsWith('configuration_')
          ? error.message
          : 'configuration_unreadable';
      blockers.push(reason);
      break;
    }
  }
  return {
    observation: null,
    reason: wsl
      ? (windows?.reason ?? 'configuration_windows_effective_merge_unverified')
      : 'configuration_remote_sources_unobserved',
    candidate,
  };
}

/** Read default local settings/MCP layers only. This does not disable any source.
 * The finite complete lane requires an already-selected Bedrock provider (no
 * remote policy/connectors), Linux without WSL policy, and no extra discovery.
 * WSL and ordinary provider configurations expose only an explicitly unverified
 * metadata candidate. Other native versions remain unknown without observation.
 */
export function observeClaudeConfiguration(
  request: ClaudeConfigurationRequest,
  /** Trusted test/composition dependencies, never CLI/config/env selectors. */
  trusted: {
    managedRoot?: string;
    gitExecutable?: () => string;
    windows?: Pick<WindowsPolicyPorts, 'system'> & Partial<Pick<WindowsPolicyPorts, 'query'>>;
  } = {}
): ClaudeConfigurationResult {
  try {
    if (request.version !== '2.1.305') throw new Error('configuration_version_uncovered');
    const wsl = /microsoft|wsl/i.test(request.kernel);
    const remote =
      request.env.CLAUDE_CODE_USE_BEDROCK !== '1' ||
      Object.keys(request.env).some(
        (key) =>
          request.env[key] &&
          /^(?:CLAUDE_CODE_USE_(?:VERTEX|FOUNDRY)|CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST|ANTHROPIC_BASE_URL|ANTHROPIC_PROFILE|.*GATEWAY.*)$/.test(
            key
          )
      );
    if (wsl || remote)
      return unverifiedCandidate(request, trusted.managedRoot ?? '/etc/claude-code', wsl, remote, trusted.windows);
    if (Object.keys(request.env).some((key) => key.startsWith('GIT_') && request.env[key]))
      throw new Error('configuration_git_selector_uncovered');
    const at = request.argv.indexOf('--', 1);
    if (
      request.argv
        .slice(1, at < 0 ? undefined : at)
        .some(
          (arg) =>
            /^--(?:setting-sources|mcp-config|strict-mcp-config|plugin-dir|add-dir|agent|agents|settings|worktree|cwd)(?:=|$)/.test(
              arg
            ) || /^-w/.test(arg)
        )
    )
      throw new Error('configuration_cli_selector_uncovered');
    if (realpathSync(request.sourceRoot) !== request.sourceRoot || realpathSync(request.cwd) !== request.cwd)
      throw new Error('configuration_root_unverified');
    supportedSettings(request.settings);
    const files: FileReceipt[] = [];
    const layers: ClaudeConfiguration['description']['layers'] = [];
    const dependencies = new Set(bookkeepingDependencies(request.settings));
    let projectLocalTracked: boolean | null = null;
    const budget = { bytes: 1048576 };
    const read = (role: string, path: string, projection?: (v: Record<string, unknown>) => unknown) => {
      if (files.length >= 64) throw new Error('configuration_file_limit');
      const result = capture(path, budget);
      files.push(result.receipt);
      const selected = result.value && projection ? projection(result.value) : result.value;
      if (selected) for (const name of bookkeepingDependencies(selected)) dependencies.add(name);
      layers.push({
        role,
        state: result.receipt.state,
        fingerprint: result.value && projection ? digest(selected) : result.receipt.fingerprint,
      });
      return result;
    };
    const settings = (role: string, path: string) => {
      const value = read(role, path);
      if (value.receipt.state === 'directory') throw new Error('configuration_file_expected');
      if (value.value) supportedSettings(value.value);
    };
    // Restrict project discovery to a repository root or a non-repository cwd.
    // Git files/worktrees and nested checkouts need a separate selection proof.
    for (let path = request.cwd, depth = 0; ; path = dirname(path), depth++) {
      if (depth > 32) throw new Error('configuration_repository_depth');
      const git = capture(join(path, '.git'), budget);
      files.push(git.receipt);
      if (git.receipt.state !== 'missing' && (path !== request.cwd || git.receipt.state !== 'directory'))
        throw new Error('configuration_repository_selection_uncovered');
      if (git.receipt.state === 'directory') {
        const binary = (trusted.gitExecutable ?? trustedGitExecutable)();
        const lines = execFileSync(
          binary,
          [
            '--no-pager',
            '-c',
            'core.fsmonitor=false',
            'rev-parse',
            '--show-toplevel',
            '--absolute-git-dir',
            '--path-format=absolute',
            '--git-common-dir',
            '--is-bare-repository',
          ],
          {
            cwd: request.cwd,
            env: request.env,
            timeout: 500,
            maxBuffer: 8192,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        )
          .trim()
          .split('\n');
        if (!equal(lines, [request.cwd, join(request.cwd, '.git'), join(request.cwd, '.git'), 'false']))
          throw new Error('configuration_repository_selection_uncovered');
        const tracked = execFileSync(
          binary,
          ['--no-pager', '-c', 'core.fsmonitor=false', 'ls-files', '--', '.claude/settings.local.json'],
          {
            cwd: request.cwd,
            env: request.env,
            timeout: 500,
            maxBuffer: 8192,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        ).trim();
        if (tracked !== '' && tracked !== '.claude/settings.local.json')
          throw new Error('configuration_tracking_unverified');
        projectLocalTracked = tracked !== '';
        break;
      }
      if (path === '/') break;
    }
    settings('user-settings', join(request.sourceRoot, 'settings.json'));
    settings('project-settings', join(request.cwd, '.claude/settings.json'));
    settings('project-local-settings', join(request.cwd, '.claude/settings.local.json'));
    const global = read('global-and-selected-local-mcp', join(request.sourceRoot, '.claude.json'), (value) =>
      globalAndLocalSelection(value, request.cwd)
    );
    if (global.receipt.state === 'directory') throw new Error('configuration_file_expected');
    const mcp = (role: string, path: string) => {
      const entry = read(role, path);
      if (entry.receipt.state === 'directory') throw new Error('configuration_file_expected');
      if (entry.value) {
        if (Object.keys(entry.value).some((key) => key !== 'mcpServers'))
          throw new Error('configuration_mcp_key_uncovered');
        supportedMcp(entry.value.mcpServers);
      }
    };
    mcp('project-mcp', join(request.cwd, '.mcp.json'));
    const managed = trusted.managedRoot ?? '/etc/claude-code';
    settings('managed-settings', join(managed, 'managed-settings.json'));
    mcp('managed-mcp', join(managed, 'managed-mcp.json'));
    const dropins = read('managed-dropins', join(managed, 'managed-settings.d'));
    if (dropins.receipt.state === 'file') throw new Error('configuration_directory_expected');
    const selected = (dropins.entries ?? []).filter((name) => !name.startsWith('.') && name.endsWith('.json'));
    if (selected.length > 16) throw new Error('configuration_dropin_limit');
    for (const name of selected) settings(`managed-dropin:${name}`, join(managed, 'managed-settings.d', name));
    for (const [role, path] of [
      ['user-plugins', join(request.sourceRoot, 'plugins')],
      ['user-agents', join(request.sourceRoot, 'agents')],
      ['project-agents', join(request.cwd, '.claude/agents')],
    ]) {
      const entry = read(role, path);
      if (entry.receipt.state !== 'missing') throw new Error('configuration_extensions_uncovered');
    }
    return {
      observation: {
        description: {
          schema: 'claude-local-inputs-v1',
          selection: 'default-user-project-local',
          remote: 'bedrock-no-remote-settings-or-connectors',
          bookkeepingDependencies: [...dependencies].sort(),
          projectLocalTracked,
          layers,
        },
        receipt: { cwd: request.cwd, files },
      },
      reason: null,
    };
  } catch (error) {
    return {
      observation: null,
      reason:
        error instanceof Error && error.message.startsWith('configuration_')
          ? error.message
          : 'configuration_unreadable',
    };
  }
}

export function sameClaudeConfiguration(original: ClaudeConfiguration, current: ClaudeConfiguration | null): boolean {
  return current !== null && equal(original, current);
}
