/** Isolated HUD_HOME for local Codex / Claude / Pi checks. Does not write user configs. */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CODEX_MODEL = 'gpt-6-luna';
export const CODEX_EFFORT = 'medium';
export const CLAUDE_MODEL_DEFAULT = 'claude-haiku-5-5';
const MODEL_TOKEN = /^[A-Za-z0-9._:-]+$/;

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../..');
const HOOK_RECORD = join(REPO_ROOT, 'packages/hud-mcp/dist/packages/hud-mcp/src/hook/record.js');

function fail(message) {
  throw new Error(message);
}
/** Built hook helpers. A missing module stops setup and names the build. */
async function loadHookRecord() {
  if (!existsSync(HOOK_RECORD)) {
    fail(
      'built hook module is missing at packages/hud-mcp/dist/packages/hud-mcp/src/hook/record.js; run npm run build:hud-mcp first'
    );
  }
  let loaded;
  try {
    loaded = await import(pathToFileURL(HOOK_RECORD).href);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`built hook module failed to load; run npm run build:hud-mcp first: ${detail}`);
  }
  if (typeof loaded.makeHookSettings !== 'function' || typeof loaded.hookProfileFingerprint !== 'function') {
    fail(
      'built hook module does not export makeHookSettings and hookProfileFingerprint; run npm run build:hud-mcp first'
    );
  }
  return loaded;
}
function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    fail(`${path} is not a private directory owned by this user`);
  if (realpathSync(path) !== path) fail(`${path} is not a canonical path`);
}
function existingDirectory(path, label) {
  let canonicalPath;
  try {
    canonicalPath = realpathSync(path);
  } catch {
    fail(`${label} does not exist (${path}). This kit does not create or modify it.`);
  }
  if (!statSync(canonicalPath).isDirectory()) fail(`${label} is not a directory`);
  return canonicalPath;
}
function onPath(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  fail(`${name} is not an executable on PATH`);
}
export function claudeModel() {
  const model = process.env.LV_CLAUDE_MODEL || CLAUDE_MODEL_DEFAULT;
  if (!MODEL_TOKEN.test(model)) fail('LV_CLAUDE_MODEL must be a single token without spaces');
  return model;
}
function writePrivate(path, text, force) {
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (current === text) {
      chmodSync(path, 0o600);
      return 'unchanged';
    }
    if (!force) fail(`${path} already has different content; rerun with --force to replace it`);
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return 'written';
}
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Codex effort is not a native.json option. The managed adapter copies only
 * options.model onto thread/start, so effort travels as an app-server -c arg.
 */
export function nativeConfig(codexHome) {
  return {
    version: 1,
    profiles: [
      {
        id: 'codex',
        harness: 'codex',
        executable: 'codex',
        args: [
          '-c',
          `model=${JSON.stringify(CODEX_MODEL)}`,
          '-c',
          `model_reasoning_effort=${JSON.stringify(CODEX_EFFORT)}`,
          'app-server',
        ],
        env: { CODEX_HOME: codexHome },
        options: { model: CODEX_MODEL },
      },
      {
        id: 'claude',
        harness: 'claude',
        executable: 'claude',
        options: { model: claudeModel() },
      },
      {
        id: 'pi',
        harness: 'pi',
        executable: 'pi',
      },
    ],
  };
}
export function sourceConfig(roots) {
  const profile = (name, root, callSource) => ({
    name,
    harness: name,
    source: { root, label: name },
    env: {},
    mcpServerName: 'hud',
    launch: { argv: [name] },
    ...(callSource ? { callSource } : {}),
  });
  return {
    version: 1,
    profiles: [
      profile('codex', roots.codex),
      profile('claude', roots.claude, { kind: 'claude_pre_tool_use_v1' }),
      profile('pi', roots.pi, { kind: 'pi_extension_v1' }),
    ],
  };
}
export function canonicalHome(input = process.env.HUD_HOME || 'tmp/lv-home') {
  const requested = isAbsolute(input) ? input : resolve(input);
  const parent = dirname(requested);
  let parentReal;
  try {
    parentReal = realpathSync(parent);
  } catch {
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    parentReal = realpathSync(parent);
  }
  const home = join(parentReal, basename(requested));
  privateDirectory(home);
  return home;
}
export async function setupHome(input, options = {}) {
  const home = canonicalHome(input);
  const force = options.force === true;
  const { makeHookSettings, hookProfileFingerprint } = await loadHookRecord();
  const codexHome = existingDirectory(join(homedir(), '.codex-account2'), 'Codex account home');
  const claudeRoot = existingDirectory(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    'Claude config directory'
  );
  const piSessions = join(home, 'pi-sessions');
  const records = join(home, 'claude-records');
  const launch = join(home, 'launch');
  privateDirectory(piSessions);
  privateDirectory(records);
  privateDirectory(launch);
  const claudeExecutable = onPath('claude');
  const sources = sourceConfig({ codex: codexHome, claude: claudeRoot, pi: piSessions });
  const claudeProfile = sources.profiles.find((profile) => profile.name === 'claude');
  const hookPath = join(launch, 'claude.hook.json');
  const hook = {
    version: 1,
    implementation: 'claude-hook-2',
    claudeExecutable,
    sourceRoot: claudeRoot,
    directory: records,
    serverName: 'hud',
    profileFingerprint: hookProfileFingerprint(claudeProfile),
    clockTicksPerSecond: 100,
  };
  const hookCommand = [process.execPath, join(REPO_ROOT, 'packages/hud-mcp/bin/hud-claude-hook.mjs'), hookPath]
    .map(shellQuote)
    .join(' ');
  const mcpPath = join(launch, 'claude.mcp.json');
  const settingsPath = join(launch, 'claude.settings.json');
  const mcp = {
    mcpServers: {
      hud: {
        command: process.execPath,
        args: [join(REPO_ROOT, 'packages/hud-mcp/bin/hud-mcp.mjs')],
        env: {
          HUD_HOME: home,
          HUD_MCP_PROFILE: 'claude',
          HUD_CLAUDE_HOOK_CONFIG: hookPath,
        },
      },
    },
  };
  const written = {
    'native.json': writePrivate(join(home, 'native.json'), jsonText(nativeConfig(codexHome)), force),
    'delegate.json': writePrivate(join(home, 'delegate.json'), jsonText(sources), force),
    'launch/claude.hook.json': writePrivate(hookPath, jsonText(hook), force),
    'launch/claude.settings.json': writePrivate(settingsPath, jsonText(makeHookSettings(hook, hookCommand)), force),
    'launch/claude.mcp.json': writePrivate(mcpPath, jsonText(mcp), force),
  };
  return {
    home,
    codexHome,
    claudeRoot,
    piSessions,
    claudeExecutable,
    claudeModel: claudeModel(),
    mcpPath,
    settingsPath,
    hookPath,
    written,
  };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  try {
    const force = process.argv.includes('--force');
    const positional = process.argv.slice(2).filter((arg) => arg !== '--force');
    if (positional.length > 1) fail('usage: node scripts/local-validation/setup-home.mjs [HUD_HOME] [--force]');
    const result = await setupHome(positional[0], { force });
    process.stderr.write(`HUD_HOME=${result.home}\n`);
    for (const [name, state] of Object.entries(result.written)) process.stderr.write(`${state} ${name}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'setup failed'}\n`);
    process.exitCode = 1;
  }
}
