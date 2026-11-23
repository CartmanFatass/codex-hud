import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';

// JSON.parse validates the document; this index locates its values and separators
// so that changing a HUD entry never reformats unrelated settings or auth data.
function indexJson(text) {
  JSON.parse(text);
  const tokens = text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/g);
  let next = tokens.next().value;
  function take() {
    const token = next;
    next = tokens.next().value;
    return token;
  }
  function value(key, start) {
    const { 0: token, index: offset } = take();
    const node = { key, start: start ?? offset, offset, end: offset + token.length };
    if (token !== '{' && token !== '[') return node;
    node.children = [];
    const close = token === '{' ? '}' : ']';
    while (next[0] !== close) {
      const property = token === '{' ? take() : undefined;
      if (property) take(); // colon
      const child = value(property ? JSON.parse(property[0]) : node.children.length, property?.index);
      node.children.push(child);
      if (next[0] === ',') child.comma = take().index;
    }
    node.end = take().index + 1;
    return node;
  }
  return value();
}

class JsonText {
  constructor(text) {
    this.text = text;
    this.root = indexJson(text);
    if (!this.root.children || text[this.root.offset] !== '{') throw new Error('expected a JSON object');
  }

  at(keys) {
    return keys.reduce((node, key) => node?.children?.findLast((entry) => entry.key === key), this.root);
  }

  raw(keys) {
    const node = this.at(keys);
    return node && this.text.slice(node.offset, node.end);
  }

  get(keys) {
    const raw = this.raw(keys);
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  splice(start, end, raw) {
    this.text = this.text.slice(0, start) + raw + this.text.slice(end);
    this.root = indexJson(this.text);
  }

  append(keys, raw) {
    const parent = this.at(keys);
    const last = parent.children.at(-1);
    const pos = last?.end ?? parent.offset + 1;
    this.splice(pos, pos, (last ? ',' : '') + raw);
  }

  put(keys, raw) {
    const node = this.at(keys);
    if (node) {
      if (!equal(this.get(keys), JSON.parse(raw))) this.splice(node.offset, node.end, raw);
    } else {
      const parent = keys.slice(0, -1);
      const member = `${JSON.stringify(keys.at(-1))}:${raw}`;
      if (this.at(parent)) this.append(parent, member);
      else this.put(parent, `{${member}}`);
    }
  }

  remove(keys) {
    const node = this.at(keys);
    if (!node) return;
    const siblings = this.at(keys.slice(0, -1)).children;
    const index = siblings.indexOf(node);
    const comma = index ? siblings[index - 1].comma : node.comma;
    // Remove just the member and its separator, not adjacent owner whitespace.
    if (comma === undefined) this.splice(node.start, node.end, '');
    else if (comma < node.start) this.splice(comma, node.end, this.text.slice(comma + 1, node.start));
    else this.splice(node.start, comma + 1, this.text.slice(node.end, comma));
  }
}

const read = (file) => fs.readFileSync(file, 'utf8');
const exists = (file) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;

function writeAtomic(target, text, mode) {
  const tmp = fs.mkdtempSync(path.join(path.dirname(target), '.hud-agy-'));
  const file = path.join(tmp, 'config');
  try {
    fs.writeFileSync(file, text, { mode: 0o600 });
    fs.chmodSync(file, mode);
    fs.renameSync(file, target);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// agy leaves an empty config file behind when it has nothing to write; that is
// an empty object, not a malformed document.
const objectText = (text) => (text === undefined || text.trim() === '' ? '{}\n' : text);

function readConfig(file) {
  const target = exists(file) ? fs.realpathSync(file) : file;
  const before = exists(target) ? read(target) : undefined;
  const backup = file + '.hud-agy-backup';
  const baseline = exists(backup) ? read(backup) : before;
  try {
    return {
      target, before, backup, baseline,
      live: new JsonText(objectText(before)),
      original: new JsonText(objectText(baseline)),
    };
  } catch {
    throw new Error(`${file}: expected a valid JSON object (including any HUD backup)`);
  }
}

function save(config, installing, keepBackup = false) {
  const { target, before, backup, baseline, live } = config;
  if (live.text !== objectText(before)) {
    if (installing && !exists(backup)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // An empty backup records that the config file did not exist; a blank
      // file is recorded as an empty object so uninstall leaves it in place.
      fs.writeFileSync(backup, before === undefined ? '' : objectText(before), { mode: 0o600, flag: 'wx' });
    }
    if (!installing && baseline === '' && live.text === '{}\n') {
      fs.unlinkSync(target);
    } else {
      const mode = before === undefined ? 0o600 : fs.statSync(target).mode & 0o777;
      writeAtomic(target, live.text, mode);
    }
  }
  if (!installing && !keepBackup && exists(backup)) fs.unlinkSync(backup);
}

const { HOME, BIN_DIR, HUD_HOME } = process.env;
const settingsPath = path.join(HOME, '.gemini/antigravity-cli/settings.json');
const hooksPath = path.join(HOME, '.gemini/config/hooks.json');
const mcpRelative = '.gemini/config/mcp_config.json';
const mcpPath = path.join(HOME, mcpRelative);
const instructionsPath = path.join(HOME, '.gemini/antigravity-cli/mcp/hud/instructions.md');
const instructionsRecord = instructionsPath + '.hud-agy-backup';
const allowKey = ['permissions', 'allow'];
const statusKey = ['statusLine'];
const hookKey = ['hud'];
const mcpKey = ['mcpServers', 'hud'];
const rule = 'mcp(hud/*)';
const status = { type: 'command', command: path.join(BIN_DIR, 'hud-statusline') };
const hookPath = path.join(HUD_HOME, 'integrations/agy/pre-invocation.sh');
const hook = { PreInvocation: [{ type: 'command', command: `'${hookPath.replaceAll("'", "'\\''")}'` }] };
const mcpCommand = path.join(BIN_DIR, 'hud-mcp');
const mcpRecord = { command: mcpCommand, disabled: false, env: { HUD_MCP_SURFACE: 'roles' } };

function stagedMcp() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-agy-mcp-'));
  const options = {
    cwd: home,
    env: {
      ...process.env, HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_STATE_HOME: path.join(home, '.local/state'),
    },
    stdio: 'ignore',
  };
  try {
    spawnSync('agy', ['mcp', 'remove', 'hud'], options);
    const add = spawnSync('agy', ['mcp', 'add', '--env', 'HUD_MCP_SURFACE=roles', 'hud', mcpCommand], {
      ...options, stdio: 'inherit',
    });
    if (add.status !== 0) throw new Error(`agy mcp add failed (${add.error?.message ?? add.status ?? add.signal})`);
    try {
      const record = JSON.parse(read(path.join(home, mcpRelative))).mcpServers?.hud;
      if (equal(record, mcpRecord)) return record;
    } catch { /* Missing or malformed staged config is an unexpected result too. */ }
    throw new Error(`agy mcp add produced an unexpected hud registration in ${mcpRelative}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function objectOrMissing(value, name) {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(`${name} must be a JSON object`);
  }
}

const isHudStatus = (line) => line?.type === 'command' && typeof line.command === 'string' &&
  line.command.endsWith('hud-statusline');

// The per-file record holds the last HUD text so uninstall works without a
// build and never removes pre-existing instructions or intervening owner edits.
function saveInstructions(text) {
  const before = fs.lstatSync(instructionsPath, { throwIfNoEntry: false });
  const last = exists(instructionsRecord) ? read(instructionsRecord) : undefined;
  const owned = last !== undefined && before?.isFile() && read(instructionsPath) === last;
  if (text === undefined) {
    if (owned) fs.unlinkSync(instructionsPath);
    if (last !== undefined) fs.unlinkSync(instructionsRecord);
  } else if (!before || (owned && text !== last)) {
    fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
    if (text !== last) writeAtomic(instructionsRecord, text, 0o600);
    writeAtomic(instructionsPath, text, 0o600);
  }
}

async function install() {
  const { MAIN_SESSION_INSTRUCTIONS } = await import('../dist/mcp/mcp/instructions.js');
  const settings = readConfig(settingsPath);
  const hooks = readConfig(hooksPath);
  const mcp = readConfig(mcpPath);
  objectOrMissing(settings.live.get(['permissions']), `${settingsPath}: permissions`);
  objectOrMissing(mcp.live.get(['mcpServers']), `${mcpPath}: mcpServers`);
  const allow = settings.live.get(allowKey);
  if (allow === undefined) settings.live.put(allowKey, JSON.stringify([rule]));
  else if (!Array.isArray(allow)) throw new Error(`${settingsPath}: permissions.allow must be an array`);
  else if (!allow.includes(rule)) settings.live.append(allowKey, JSON.stringify(rule));
  const statusLine = settings.live.get(statusKey);
  if (!statusLine || isHudStatus(statusLine)) settings.live.put(statusKey, JSON.stringify(status));
  hooks.live.put(hookKey, JSON.stringify(hook));
  mcp.live.put(mcpKey, JSON.stringify(stagedMcp()));
  for (const config of [settings, hooks, mcp]) save(config, true);
  saveInstructions(MAIN_SESSION_INSTRUCTIONS);
}

// Keep an owner edit to a HUD entry, and keep the backup if it holds a previous
// value that uninstall could not put back without overwriting that edit.
function revert(config, key, owned) {
  const { live, original } = config;
  const prior = original.raw(key);
  if (equal(live.get(key), owned)) {
    if (prior === undefined) live.remove(key);
    else live.put(key, prior);
  }
  return prior !== undefined && !equal(live.get(key), original.get(key));
}

function removeEmptyObject(config, key) {
  if (config.original.raw(key) === undefined && equal(config.live.get(key), {})) config.live.remove(key);
}

function uninstall() {
  if (exists(settingsPath + '.hud-agy-backup')) {
    const settings = readConfig(settingsPath);
    const allow = settings.live.get(allowKey);
    if (!settings.original.get(allowKey)?.includes(rule) && Array.isArray(allow)) {
      const index = allow.lastIndexOf(rule);
      if (index !== -1) {
        settings.live.remove([...allowKey, index]);
        if (settings.original.raw(allowKey) === undefined && allow.length === 1) settings.live.remove(allowKey);
        removeEmptyObject(settings, ['permissions']);
      }
    }
    save(settings, false, revert(settings, statusKey, status));
  }
  if (exists(hooksPath + '.hud-agy-backup')) {
    const hooks = readConfig(hooksPath);
    save(hooks, false, revert(hooks, hookKey, hook));
  }
  if (exists(mcpPath + '.hud-agy-backup')) {
    const mcp = readConfig(mcpPath);
    const keep = revert(mcp, mcpKey, mcpRecord);
    removeEmptyObject(mcp, ['mcpServers']);
    save(mcp, false, keep);
  }
  saveInstructions();
}

try {
  if (process.argv[2] === 'install') await install();
  else uninstall();
} catch (err) {
  console.error(`agy extension: ${err.message}`);
  process.exitCode = 1;
}
