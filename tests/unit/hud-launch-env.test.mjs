import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic shell-contract tests, not tmux/provider/renderer qualification.
// Run the actual entrypoints byte-for-byte in a disposable installation layout.
// No source extraction, TypeScript loader, real build output or live tmux server.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = process.env.HUD_LAUNCH_ENV_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true, mode: 0o700 });
const scripts = ['codex-hud', 'codex-hud-toggle', 'codex-hud-resize', 'codex-hud-keys', 'codex-hud-command'];
const fake = String.raw`#!/usr/bin/env bash
set -euo pipefail
kind="@@{0##*/}"
printf '%s\0' "$kind" "$@" > "$FAKE_ROOT/events/$$"
reject() { printf '%s\0' "$kind" "$@" > "$FAKE_ROOT/rejected/$$"; exit 97; }
case "$kind" in
  sleep) [[ "$*" == '0.2' ]] || reject "$@"; exit 0 ;;
  tput) case "$*" in lines) echo 40;; cols) echo 160;; *) reject "$@";; esac; exit 0 ;;
  node)
    if [[ "@@{1:-}" == '--version' ]]; then echo 'synthetic-node'; exit 0; fi
    if [[ "$#" == 4 && "$1" == '--input-type=module' && "$2" == '-e' && "$4" == "$FAKE_ROOT/install/dist/settings.js" ]]; then
      case "$3" in
        *'loadSettings().statusline'*) printf '%s' "$FAKE_STATUSLINE" ;;
        *'loadSettings().prefixKey'*) printf '%s' 'C-\' ;;
        *) reject "$@" ;;
      esac
      exit 0
    fi
    if [[ "@@{FAKE_REPLAY_PANEL:-0}" == 1 && "$#" == 1 && "$1" == "$FAKE_ROOT/install/dist/tree-page.js" ]]; then
      printf '%s\0' "@@{HUD_TREE_WIDTH-UNSET}" "@@{CODEX_HUD_TREE_WIDTH-UNSET}" "@@{CODEX_HOME-}" "@@{CODEX_HUD_TMUX_SESSION-}" > "$FAKE_ROOT/panel-env"
      exit 0
    fi
    reject "$@" ;;
  touch) : > "$FAKE_ROOT/SENTINEL"; reject "$@" ;;
  tmux) ;;
  *) reject "$@" ;;
esac
command="@@{1:-}"
shift
# A finite protocol, not a fallback to real tmux. Unrecognized operations fail.
case "$command" in
  new-session) printf '%s\0' "$@" > "$FAKE_ROOT/new-session" ;;
  show-option)
    opt="@@{!#}"; [[ "$opt" =~ ^(@codex_hud_[a-z_]+)$ ]] || reject "$command" "$@"
    [[ ! -f "$FAKE_ROOT/options/$opt" ]] || cat "$FAKE_ROOT/options/$opt"
    ;;
  set-option)
    opt=""; value=""
    for arg in "$@"; do opt="$value"; value="$arg"; done
    if [[ "$opt" == @* ]]; then
      [[ "$opt" =~ ^@codex_hud_[a-z_]+$ ]] || reject "$command" "$@"
      printf '%s' "$value" > "$FAKE_ROOT/options/$opt"
    fi
    ;;
  list-sessions) [[ ! -f "$FAKE_ROOT/sessions" ]] || cat "$FAKE_ROOT/sessions" ;;
  list-panes) printf '%%1\n%%2\n%%3\n' ;;
  display|display-message)
    format="@@{!#}"; pane=""
    while [[ "$#" -gt 0 ]]; do
      if [[ "$1" == -t ]]; then pane="$2"; shift; fi
      shift
    done
    case "$format" in
      '#{pane_id}') printf '%s\n' "$pane" ;;
      '#{pane_width}') printf '%s\n' "$FAKE_PANE_WIDTH" ;;
      '#{window_width}') printf '%s\n' "$FAKE_WINDOW_WIDTH" ;;
      '#{pane_height}') printf '%s\n' "$FAKE_PANE_HEIGHT" ;;
      '#{pane_in_mode}') printf '%s\n' "$FAKE_COPY_MODE" ;;
      '#{session_name}') echo synthetic-session ;;
      '#{session_id}') echo '$1' ;;
      *) reject "$command" "$format" ;;
    esac
    ;;
  split-window)
    case " $* " in *' -h '*) echo '%3';; *) echo '%2';; esac ;;
  source-file) [[ "$*" == '-' ]] || reject "$command" "$@"; cat >/dev/null ;;
  list-keys) : ;;
  set-environment)
    [[ "@@{1:-}" == -t && "$#" == 4 && "$3" == CODEX_HOME ]] || reject "$command" "$@"
    ;;
  set-window-option|select-pane|resize-pane|set-hook|bind-key|unbind-key|send-keys|wait-for|attach-session|has-session|kill-session|kill-pane) : ;;
  *) reject "$command" "$@" ;;
esac
`.replaceAll('@@{', '${');

// Detached group ownership is retained until direct-child exit. On a deadline
// only this owned group is signalled. Normal completion requires pipe close and
// no remaining group members, not merely a successful shell exit.
function bounded(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let exited = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let fallback;
    let forcedClose = false;
    const started = Date.now();
    const stop = () => {
      if (timedOut) return;
      timedOut = true;
      fallback = setTimeout(() => {
        forcedClose = true;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        rejectRun(new Error('Owned subprocess did not close/reap within the cleanup deadline'));
      }, 1000);
      if (!exited && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    const timer = setTimeout(stop, 8000);
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.on('data', (data) => {
        outputBytes += data.length;
        if (outputBytes > 1024 * 1024) return stop();
        if (name === 'stdout') stdout += data.toString(); else stderr += data.toString();
      });
    }
    child.once('exit', () => { exited = true; });
    child.once('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      clearTimeout(fallback);
      let groupGone = false;
      try { process.kill(-child.pid, 0); } catch (error) { if (error.code === 'ESRCH') groupGone = true; }
      const result = { status, signal, stdout, stderr, timedOut, exited, closed: !forcedClose, groupGone, ms: Date.now() - started };
      if (!exited || !groupGone || timedOut) rejectRun(new Error(`Owned subprocess cleanup/deadline failure: ${JSON.stringify(result)}`));
      else resolveRun(result);
    });
  });
}

function fixture(label, { settings = '1', options = {}, paneWidth = '70', paneHeight = '1', copyMode = '0' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hud-launch-env-synthetic-'));
  const records = [];
  for (const path of ['home', 'codex', 'hud', 'events', 'rejected', 'options', 'path', 'install/bin', 'install/src', 'install/dist', 'install/node_modules']) {
    mkdirSync(join(dir, path), { recursive: true, mode: 0o700 });
  }
  for (const script of scripts) {
    const destination = join(dir, 'install/bin', script);
    copyFileSync(join(root, 'bin', script), destination);
    assert.deepEqual(readFileSync(destination), readFileSync(join(root, 'bin', script)));
  }
  // Presence markers only. The fake node never loads these or any real module.
  for (const file of ['index.js', 'tree-page.js', 'settings.js']) {
    writeFileSync(join(dir, 'install/dist', file), 'throw new Error("synthetic marker must never execute");\n', { mode: 0o600 });
  }
  for (const name of ['bash', 'dirname', 'md5sum', 'awk', 'realpath', 'head', 'tail', 'sort', 'grep', 'tr', 'uname', 'find', 'sed', 'chmod', 'cat', 'env', 'od']) {
    const path = ['/usr/bin', '/bin'].map((parent) => join(parent, name)).find(existsSync);
    assert.ok(path, `required shell utility missing: ${name}`);
    symlinkSync(path, join(dir, 'path', name));
  }
  for (const name of ['tmux', 'node', 'npm', 'npx', 'codex', 'claude', 'pi', 'herdr', 'sudo', 'apt-get', 'brew', 'sleep', 'tput', 'touch']) {
    writeFileSync(join(dir, 'path', name), fake, { mode: 0o700 });
  }
  // Date is deterministic, but the wrapper's real PID/session hash remain real.
  writeFileSync(join(dir, 'path/date'), '#!/usr/bin/env bash\ncase "$*" in +%s) echo 1800000000;; +%Y%m%d%H%M%S) echo 20261106120000;; *) exit 97;; esac\n', { mode: 0o700 });
  const baseEnv = {
    PATH: join(dir, 'path'), HOME: join(dir, 'home'), CODEX_HOME: join(dir, 'codex'), HUD_HOME: join(dir, 'hud'),
    TMPDIR: dir, SHELL: '/bin/bash', TERM: 'xterm', LC_ALL: 'C', FAKE_ROOT: dir,
    FAKE_STATUSLINE: settings, FAKE_PANE_WIDTH: paneWidth, FAKE_WINDOW_WIDTH: '160',
    FAKE_PANE_HEIGHT: paneHeight, FAKE_COPY_MODE: copyMode,
  };
  const putOptions = (values) => {
    for (const [key, value] of Object.entries(values)) writeFileSync(join(dir, 'options', key), value, { mode: 0o600 });
  };
  putOptions(options);
  const events = () => readdirSync(join(dir, 'events')).map((file) => {
    const path = join(dir, 'events', file);
    return { time: statSync(path).mtimeMs, argv: readFileSync(path, 'utf8').split('\0').slice(0, -1) };
  }).sort((a, b) => a.time - b.time).map(({ argv }) => argv);
  async function run(script = 'codex-hud', env = {}, args = []) {
    for (const file of readdirSync(join(dir, 'events'))) rmSync(join(dir, 'events', file));
    const result = await bounded('/bin/bash', [join(dir, 'install/bin', script), ...args], { cwd: dir, env: { ...baseEnv, ...env } });
    const calls = events();
    records.push({ script, env, args, ...result, calls });
    assert.deepEqual(readdirSync(join(dir, 'rejected')), [], 'unexpected fake operation (build/provider/unsupported tmux)');
    assert.equal(existsSync(join(dir, 'SENTINEL')), false, 'shell value executed');
    return { ...result, calls };
  }
  async function replayPanel(command, env = {}) {
    const result = await bounded('/bin/bash', ['-c', command], {
      cwd: dir, env: { ...baseEnv, HUD_TREE_WIDTH: '119', CODEX_HUD_TREE_WIDTH: '118', ...env, FAKE_REPLAY_PANEL: '1' },
    });
    records.push({ script: 'generated panel command (synthetic node only)', command, ...result });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(join(dir, 'rejected')), []);
    assert.equal(existsSync(join(dir, 'SENTINEL')), false);
    return readFileSync(join(dir, 'panel-env'), 'utf8').split('\0').slice(0, -1);
  }
  return {
    dir, run, replayPanel, putOptions,
    opt: (name) => existsSync(join(dir, 'options', name)) ? readFileSync(join(dir, 'options', name), 'utf8') : '',
    close() {
      if (evidence) {
        const clean = (value) => JSON.parse(JSON.stringify(value).replaceAll(dir, '<synthetic-root>'));
        appendFileSync(join(evidence, 'fake-captures.jsonl'), JSON.stringify(clean({ label, records })) + '\n', { mode: 0o600 });
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const calls = (result, command) => result.calls.filter((args) => args[0] === 'tmux' && args[1] === command);
const split = (result, direction) => calls(result, 'split-window').find((args) => args.includes(direction));
const valueAfter = (args, flag) => args?.[args.indexOf(flag) + 1];
const pass = (result) => assert.equal(result.status, 0, result.stderr);
const baseResize = {
  '@codex_hud_pane': '%2', '@codex_hud_main_pane': '%1', '@codex_hud_base_height': '5',
  '@codex_hud_height': '5', '@codex_hud_focus_main': '0',
};
const baseToggle = {
  '@codex_hud_main_pane': '%1', '@codex_hud_pane': '%2', '@codex_hud_mode': 'single',
  '@codex_hud_cwd': '/synthetic project', '@codex_hud_codex_home': '/synthetic home',
  '@codex_hud_session_start': '1800000000',
};

const controls = [
  ['POSITION', 'top', 'bottom', 'bottom', 'nonsense', false],
  ['HEIGHT', '5', '3', '1', 'not-an-integer', true],
  ['HEIGHT_AUTO', '1', '0', '0', 'maybe', true],
  ['HEIGHT_MIN', '7', '2', '1', 'not-an-integer', false],
  ['HEIGHT_MAX', '8', '3', '12', 'not-an-integer', false],
  ['STATUSLINE', '0', '1', '1', 'maybe', true],
  ['TREE', '1', '0', '0', 'maybe', true],
  ['AUTO_ATTACH', '1', '0', '0', 'maybe', true],
  ['ALTERNATE_SCREEN', '1', '0', '0', 'maybe', true],
  ['MOUSE', '0', '1', '1', 'maybe', true],
];

function checkControl(f, result, name, expected) {
  switch (name) {
    case 'POSITION': assert.equal(split(result, '-v')?.includes('-b'), expected === 'top'); break;
    case 'HEIGHT': assert.equal(valueAfter(split(result, '-v'), '-l'), expected); break;
    case 'HEIGHT_AUTO': assert.equal(f.opt('@codex_hud_auto'), expected); break;
    case 'HEIGHT_MIN': assert.equal(f.opt('@codex_hud_height_min'), expected); break;
    case 'HEIGHT_MAX': assert.equal(f.opt('@codex_hud_height_max'), expected); break;
    case 'STATUSLINE': assert.equal(f.opt('@codex_hud_statusline'), expected); assert.equal(Boolean(split(result, '-v')), expected === '1'); break;
    case 'TREE': assert.equal(Boolean(split(result, '-h')), expected === '1'); break;
    case 'AUTO_ATTACH': assert.equal(calls(result, 'list-sessions').length > 0, expected === '1'); break;
    case 'ALTERNATE_SCREEN': assert.equal(calls(result, 'set-window-option').find((args) => args.includes('alternate-screen'))?.at(-1), expected === '1' ? 'on' : 'off'); break;
    case 'MOUSE': assert.equal(calls(result, 'set-option').find((args) => args.at(-2) === 'mouse')?.at(-1), expected === '1' ? 'on' : 'off'); break;
    default: assert.fail(name);
  }
}

for (const [name, selected, legacy, fallback, invalid, rejects] of controls) {
  test(`synthetic actual wrapper: HUD_${name} selection matrix`, { timeout: 60000 }, async () => {
    const scenarios = [
      ['neutral only', { [`HUD_${name}`]: selected }, selected],
      ['legacy only', { [`CODEX_HUD_${name}`]: selected }, selected],
      ['absent', {}, fallback],
      ['equal', { [`HUD_${name}`]: selected, [`CODEX_HUD_${name}`]: selected }, selected],
      ['conflicting', { [`HUD_${name}`]: selected, [`CODEX_HUD_${name}`]: legacy }, selected],
      ['empty masks legacy', { [`HUD_${name}`]: '', [`CODEX_HUD_${name}`]: selected }, fallback],
      ['invalid masks legacy', { [`HUD_${name}`]: invalid, [`CODEX_HUD_${name}`]: selected }, invalid],
    ];
    for (const [scenario, env, expected] of scenarios) {
      const f = fixture(`${name}: ${scenario}`);
      try {
        const result = await f.run('codex-hud', env);
        if (scenario === 'invalid masks legacy' && rejects) {
          assert.equal(result.status, 1, result.stderr);
          assert.match(result.stderr, new RegExp(`CODEX_HUD_${name}`));
        } else {
          pass(result);
          checkControl(f, result, name, expected);
          if (name === 'HEIGHT_AUTO') assert.equal(f.opt('@codex_hud_height'), expected === '1' ? '3' : '1');
        }
        assert.equal(calls(result, 'set-environment').some((args) => args.includes('-g')), false);
      } finally { f.close(); }
    }
  });
}

test('saved statusline fallback and explicit flags keep existing precedence', { timeout: 30000 }, async () => {
  for (const [env, expected] of [[{}, '0'], [{ HUD_STATUSLINE: '', CODEX_HUD_STATUSLINE: '1' }, '0'], [{ HUD_STATUSLINE: '1', CODEX_HUD_STATUSLINE: '0' }, '1']]) {
    const f = fixture('saved statusline', { settings: '0' });
    try { const result = await f.run('codex-hud', env); pass(result); checkControl(f, result, 'STATUSLINE', expected); }
    finally { f.close(); }
  }
  const scenarios = [
    [{ HUD_AUTO_ATTACH: '0' }, ['--attach'], true],
    [{ HUD_AUTO_ATTACH: '1' }, ['--new-session'], false],
    [{ HUD_AUTO_ATTACH: '1' }, ['--attach', '--new-session'], false],
    [{ HUD_AUTO_ATTACH: '1', CODEX_HUD_NO_ATTACH: '1' }, [], false],
    [{ HUD_AUTO_ATTACH: '1', HUD_NO_ATTACH: '1' }, [], true],
    [{ CODEX_HUD_NO_ATTACH: '1' }, ['--attach'], true],
    [{}, ['--', '--attach', '--new-session'], false],
  ];
  for (const [env, args, attach] of scenarios) {
    const f = fixture('attach policy');
    try {
      const result = await f.run('codex-hud', env, args); pass(result);
      assert.equal(calls(result, 'list-sessions').length > 0, attach);
      if (env.CODEX_HUD_NO_ATTACH && args.length === 0) assert.match(result.stderr, /deprecated/);
      if (args[0] === '--') assert.match(calls(result, 'send-keys')[0][4], /--attach --new-session/);
    } finally { f.close(); }
  }
});

test('width agrees at launch/toggle and generated commands beat stale neutral server values', { timeout: 60000 }, async () => {
  const cases = [
    [{}, 48, '0', ''], [{ HUD_TREE_WIDTH: '70' }, 70, '70', '70'],
    [{ CODEX_HUD_TREE_WIDTH: '70' }, 70, '70', '70'],
    [{ HUD_TREE_WIDTH: '70', CODEX_HUD_TREE_WIDTH: '70' }, 70, '70', '70'],
    [{ HUD_TREE_WIDTH: '70', CODEX_HUD_TREE_WIDTH: '40' }, 70, '70', '70'],
    [{ HUD_TREE_WIDTH: '', CODEX_HUD_TREE_WIDTH: '70' }, 48, '0', ''],
    [{ HUD_TREE_WIDTH: 'bad', CODEX_HUD_TREE_WIDTH: '70' }, 48, '0', 'bad'],
    [{ HUD_TREE_WIDTH: '0' }, 48, '0', '0'], [{ HUD_TREE_WIDTH: '1' }, 16, '1', '1'],
    [{ HUD_TREE_WIDTH: '500' }, 119, '500', '500'],
    [{ HUD_TREE_WIDTH: "a' b\n$(touch SENTINEL);\u001b", CODEX_HUD_TREE_WIDTH: '70' }, 48, '0', "a' b\n$(touch SENTINEL);\u001b"],
  ];
  for (const [env, width, requested, raw] of cases) {
    const f = fixture('width launch/toggle');
    try {
      const launch = await f.run('codex-hud', { ...env, HUD_TREE: '1' }); pass(launch);
      assert.equal(valueAfter(split(launch, '-h'), '-l'), String(width));
      const creation = calls(launch, 'new-session')[0];
      assert.ok(creation.includes(`HUD_TREE_WIDTH=${raw}`));
      assert.ok(creation.includes(`CODEX_HUD_TREE_WIDTH=${raw}`));
      assert.deepEqual((await f.replayPanel(split(launch, '-h').at(-1))).slice(0, 2), [requested, requested]);
      // Simulate tmux's new-session -e overlay over a stale server environment.
      const inherited = { HUD_TREE_WIDTH: '119', CODEX_HUD_TREE_WIDTH: '118' };
      for (let i = 0; i < creation.length; i++) {
        if (creation[i] === '-e') {
          const value = creation[++i]; const at = value.indexOf('=');
          inherited[value.slice(0, at)] = value.slice(at + 1);
        }
      }
      f.putOptions(baseToggle);
      const later = await f.run('codex-hud-toggle', inherited, ['$1']); pass(later);
      assert.equal(valueAfter(split(later, '-h'), '-l'), String(width));
      assert.deepEqual((await f.replayPanel(split(later, '-h').at(-1))).slice(0, 2), [requested, requested]);
      f.putOptions(baseToggle);
      const direct = await f.run('codex-hud-toggle', env, ['$1']); pass(direct);
      assert.equal(valueAfter(split(direct, '-h'), '-l'), String(width));
    } finally { f.close(); }
  }
});

test('resize saved policy wins; neutral fallback preserves invalid bounds and focus/drag guards', { timeout: 30000 }, async () => {
  const cases = [
    ['default', {}, {}, '5'],
    ['neutral auto', { HUD_HEIGHT_AUTO: '1', CODEX_HUD_HEIGHT_AUTO: '0' }, {}, '7'],
    ['legacy auto', { CODEX_HUD_HEIGHT_AUTO: '1' }, {}, '7'],
    ['empty auto', { HUD_HEIGHT_AUTO: '', CODEX_HUD_HEIGHT_AUTO: '1' }, {}, '5'],
    ['saved auto', { HUD_HEIGHT_AUTO: '1' }, { '@codex_hud_auto': '0' }, '5'],
    ['neutral min', { HUD_HEIGHT_AUTO: '1', HUD_HEIGHT_MIN: '9', CODEX_HUD_HEIGHT_MIN: '5' }, {}, '9'],
    ['neutral max', { HUD_HEIGHT_AUTO: '1', HUD_HEIGHT_MAX: '6', CODEX_HUD_HEIGHT_MAX: '12' }, {}, '6'],
    ['empty bounds', { HUD_HEIGHT_AUTO: '1', HUD_HEIGHT_MIN: '', CODEX_HUD_HEIGHT_MIN: '9', HUD_HEIGHT_MAX: '', CODEX_HUD_HEIGHT_MAX: '6' }, {}, '7'],
    ['invalid bounds', { HUD_HEIGHT_AUTO: '1', HUD_HEIGHT_MIN: 'bad', CODEX_HUD_HEIGHT_MIN: '9', HUD_HEIGHT_MAX: 'bad', CODEX_HUD_HEIGHT_MAX: '6' }, {}, '7'],
    ['saved bounds', { HUD_HEIGHT_AUTO: '1', HUD_HEIGHT_MIN: '10', HUD_HEIGHT_MAX: '12' }, { '@codex_hud_height_min': '8', '@codex_hud_height_max': '6' }, '6'],
    ['saved masks invalid', { HUD_HEIGHT_AUTO: 'bad', HUD_HEIGHT_MIN: 'bad', HUD_HEIGHT_MAX: 'bad' }, { '@codex_hud_auto': '1', '@codex_hud_height_min': '5', '@codex_hud_height_max': '12' }, '7'],
  ];
  for (const [label, env, saved, height] of cases) {
    const f = fixture(label, { options: { ...baseResize, ...saved }, paneHeight: '5' });
    try {
      const result = await f.run('codex-hud-resize', env, ['synthetic-session']); pass(result);
      assert.equal(f.opt('@codex_hud_height'), height);
      assert.equal(calls(result, 'select-pane').length, 0);
      assert.equal(calls(result, 'set-environment').length, 0);
    } finally { f.close(); }
  }
  for (const mode of ['invalid auto', 'copy mode', 'manual drag']) {
    const f = fixture(mode, { options: baseResize, paneHeight: '9', copyMode: mode === 'copy mode' ? '1' : '0' });
    try {
      const result = await f.run('codex-hud-resize', { HUD_HEIGHT_AUTO: mode === 'invalid auto' ? 'maybe' : '0', CODEX_HUD_HEIGHT_AUTO: '1' }, ['synthetic-session', '%2']);
      if (mode === 'invalid auto') assert.equal(result.status, 1); else pass(result);
      assert.equal(calls(result, 'select-pane').length, 0);
      assert.equal(calls(result, 'resize-pane').length, 0);
      assert.equal(f.opt('@codex_hud_base_height'), mode === 'manual drag' ? '9' : '5');
    } finally { f.close(); }
  }
});

test('shell metacharacters remain data, unknown names do not remap, help remains early', { timeout: 60000 }, async () => {
  const hostile = "a' b\n$(touch SENTINEL);`touch SENTINEL`\u001b";
  for (const [name, , , , , rejects] of controls) {
    const f = fixture(`literal ${name}`);
    try {
      const result = await f.run('codex-hud', { [`HUD_${name}`]: hostile, [`CODEX_HUD_${name}`]: '1' });
      if (rejects) assert.equal(result.status, 1); else pass(result);
      assert.equal(existsSync(join(f.dir, 'SENTINEL')), false);
    } finally { f.close(); }
  }
  const f = fixture('unknown aliases and help');
  try {
    const result = await f.run('codex-hud', { HUD_NO_ATTACH: '1', HUD_SCRIPT_DIR: '/not-real', HUD_RESIZE_HELPER: 'touch SENTINEL', HUD_WINDOWS_DEFER_ATTACH: '1' });
    pass(result); assert.equal(calls(result, 'attach-session').length, 1);
    assert.equal(calls(result, 'list-sessions').length, 0);
    const help = await f.run('codex-hud', { HUD_HEIGHT: hostile, HUD_AUTO_ATTACH: 'maybe' }, ['--help']);
    pass(help); assert.equal(help.calls.length, 0);
    assert.match(help.stdout, /HUD_HEIGHT/); assert.match(help.stdout, /HUD_NO_ATTACH is not supported/);
    assert.deepEqual(readdirSync(join(f.dir, 'home')), []);
    assert.deepEqual(readdirSync(join(f.dir, 'codex')), []);
    assert.deepEqual(readdirSync(join(f.dir, 'hud')), []);
  } finally { f.close(); }
});

test('input keys and panel control metadata are unchanged between equivalent aliases', { timeout: 30000 }, async () => {
  const f = fixture('input policy compatibility');
  try {
    const legacy = await f.run('codex-hud', { CODEX_HUD_MOUSE: '1', CODEX_HUD_TREE: '1', CODEX_HUD_TREE_WIDTH: '70' }); pass(legacy);
    const neutral = await f.run('codex-hud', { HUD_MOUSE: '1', HUD_TREE: '1', HUD_TREE_WIDTH: '70' }); pass(neutral);
    for (const command of ['bind-key', 'unbind-key', 'list-keys']) {
      assert.deepEqual(calls(neutral, command).map((args) => JSON.stringify(args)).sort(), calls(legacy, command).map((args) => JSON.stringify(args)).sort());
    }
    assert.equal(calls(neutral, 'bind-key').some((args) => valueAfter(args, '-T') === 'root'), false);
    assert.ok(calls(neutral, 'bind-key').some((args) => args.includes('F12')));
    assert.ok(calls(neutral, 'bind-key').some((args) => args.includes('WheelUpPane')));
    assert.equal(f.opt('@codex_hud_mode'), 'tree');
    f.putOptions(baseToggle);
    const toggle = await f.run('codex-hud-toggle', { HUD_TREE_WIDTH: '70' }, ['$1', '--command', 'diagnostics']); pass(toggle);
    const command = split(toggle, '-h').at(-1);
    assert.match(command, /CODEX_HUD_INITIAL_COMMAND='diagnostics'/);
    assert.match(command, /CODEX_HUD_TMUX_SESSION=synthetic-session/);
    assert.ok(calls(toggle, 'wait-for').some((args) => args.includes('-L')));
    assert.ok(calls(toggle, 'wait-for').some((args) => args.includes('-U')));
    const existing = await f.run('codex-hud-toggle', {}, ['$1', '--command', 'diagnostics']); pass(existing);
    const bytes = calls(existing, 'send-keys')[0].slice(5);
    assert.equal(Buffer.from(bytes.map((byte) => parseInt(byte, 16))).toString(), '\x1b_codex-hud:diagnostics\x1b\\');
  } finally { f.close(); }
});

test('same-directory homes and stored v2 JSON selection retain exact old behavior', { timeout: 30000 }, async () => {
  const f = fixture('home identity and v2 JSON');
  try {
    const a = await f.run(); pass(a);
    const nameA = valueAfter(calls(a, 'new-session')[0], '-s');
    const homeB = join(f.dir, 'codex-B');
    mkdirSync(homeB, { mode: 0o700 });
    const b = await f.run('codex-hud', { CODEX_HOME: homeB }); pass(b);
    const nameB = valueAfter(calls(b, 'new-session')[0], '-s');
    const prefixA = nameA.split('-').slice(0, 3).join('-');
    const prefixB = nameB.split('-').slice(0, 3).join('-');
    assert.notEqual(prefixA, prefixB);
    const latestA = `${prefixA}-20261106140000-100`;
    const latestB = `${prefixB}-20261106150000-200`;
    writeFileSync(join(f.dir, 'sessions'), `${latestB}\n${latestA}\n${nameA}\n`, { mode: 0o600 });
    const attached = await f.run('codex-hud', { HUD_AUTO_ATTACH: '1' }); pass(attached);
    assert.equal(calls(attached, 'new-session').length, 0);
    assert.equal(valueAfter(calls(attached, 'attach-session')[0], '-t'), latestA);
    // Stored session home is authoritative for the v2 snapshot, not the
    // caller's fallback home or the newest other-home session in this cwd.
    f.putOptions({ '@codex_hud_codex_home': homeB });
    mkdirSync(join(homeB, 'hud/state'), { recursive: true, mode: 0o700 });
    const snapshot = '{"version":2,"updatedAt":"2026-11-06T12:00:00Z","agents":{"nodes":[]}}\n';
    writeFileSync(join(homeB, 'hud/state', `${latestA}.json`), snapshot, { mode: 0o600 });
    const json = await f.run('codex-hud', {}, ['--json']); pass(json);
    assert.equal(json.stdout, snapshot);
    assert.ok(json.calls.every((args) => args[0] === 'tmux' && ['list-sessions', 'show-option'].includes(args[1])));
    rmSync(join(homeB, 'hud/state', `${latestA}.json`));
    const missing = await f.run('codex-hud', {}, ['--json']);
    assert.equal(missing.status, 1); assert.equal(missing.stdout, '');
    assert.equal(missing.stderr, `codex-hud: no state recorded yet for session ${latestA}\n`);
    writeFileSync(join(f.dir, 'sessions'), `${latestB}\n`, { mode: 0o600 });
    const noSession = await f.run('codex-hud', {}, ['--json']);
    assert.equal(noSession.status, 1); assert.equal(noSession.stdout, '');
    assert.equal(noSession.stderr, 'codex-hud: no session for this directory\n');
  } finally { f.close(); }
});
