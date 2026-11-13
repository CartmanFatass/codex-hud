// Synthetic HOME and HUD_HOME only. Never touches a real trust file.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../../src/cli/hud.js';

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-trust-')));
  const home = join(root, 'home');
  const hud = join(root, 'hud');
  const project = join(root, 'a\\b"c');
  fs.mkdirSync(home);
  fs.mkdirSync(hud, { mode: 0o700 });
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let stdout = '';
  let stderr = '';
  const io = {
    env: { HOME: home, HUD_HOME: hud } as NodeJS.ProcessEnv,
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  };
  return {
    root,
    home,
    hud,
    project,
    io,
    out: () => stdout,
    err: () => stderr,
    reset: () => {
      stdout = '';
      stderr = '';
    },
  };
}

function tree(dir: string): string {
  if (!fs.existsSync(dir)) return '';
  const parts: string[] = [];
  const walk = (path: string) => {
    for (const name of fs.readdirSync(path).sort()) {
      const file = join(path, name);
      const stat = fs.lstatSync(file);
      parts.push(file, String(stat.mode));
      if (stat.isDirectory()) walk(file);
      else if (stat.isSymbolicLink()) parts.push(fs.readlinkSync(file));
      else parts.push(fs.readFileSync(file).toString('hex'));
    }
  };
  walk(dir);
  return parts.join('\n');
}

test('adds each agent, keeps grok bytes, agy indent and claude keys, backs up, skips codex', async (t) => {
  const f = fixture(t);
  const grok = join(f.home, '.grok', 'trusted_folders.toml');
  const agy = join(f.home, '.gemini', 'antigravity-cli', 'settings.json');
  const claude = join(f.home, '.claude.json');
  const codex = join(f.home, '.codex', 'config.toml');
  fs.mkdirSync(join(f.home, '.grok'));
  fs.mkdirSync(join(f.home, '.gemini', 'antigravity-cli'), { recursive: true });
  fs.mkdirSync(join(f.home, '.codex'));
  const grokBefore = 'keep-me\n[folders."/other"]\ntrusted = true\n';
  fs.writeFileSync(grok, grokBefore);
  fs.chmodSync(grok, 0o640);
  fs.writeFileSync(agy, '{\n    "theme": "kept"\n}\n');
  fs.writeFileSync(
    claude,
    JSON.stringify({
      numStartups: 3,
      projects: { '/elsewhere': { hasTrustDialogAccepted: false, allowedTools: [] } },
    }) + '\n'
  );
  fs.writeFileSync(codex, 'untouched\n');
  const codexBefore = tree(join(f.home, '.codex'));

  assert.equal(await main(['trust', f.project], f.io), 0);
  assert.equal(
    f.out(),
    'grok: trusted\nagy: trusted\nclaude: trusted\ncodex: skipped (worker bypass flag shows no trust dialog)\n'
  );
  const grokAfter = fs.readFileSync(grok, 'utf8');
  assert.equal(grokAfter.slice(0, grokBefore.length), grokBefore);
  const header = `[folders."${f.project.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  assert.equal(grokAfter.slice(grokBefore.length, grokBefore.length + 1 + header.length), '\n' + header);
  assert.match(grokAfter.slice(grokBefore.length + 1 + header.length), /^\ntrusted = true\ndecided_at = \d+\n$/);
  assert.equal(fs.statSync(grok).mode & 0o777, 0o640);

  const agyAfter = fs.readFileSync(agy, 'utf8');
  assert.equal(agyAfter, JSON.stringify(JSON.parse(agyAfter), null, 4) + '\n');
  assert.equal(JSON.parse(agyAfter).theme, 'kept');
  assert.deepEqual(JSON.parse(agyAfter).trustedWorkspaces, [f.project]);

  const claudeAfter = JSON.parse(fs.readFileSync(claude, 'utf8'));
  assert.equal(claudeAfter.numStartups, 3);
  assert.deepEqual(claudeAfter.projects['/elsewhere'], { hasTrustDialogAccepted: false, allowedTools: [] });
  assert.deepEqual(claudeAfter.projects[f.project], { hasTrustDialogAccepted: true });
  assert.equal(tree(join(f.home, '.codex')), codexBefore);

  const backups = fs.readdirSync(join(f.hud, 'backups', 'trust'));
  assert.equal(backups.length, 3);
  assert.equal(fs.statSync(join(f.hud, 'backups', 'trust')).mode & 0o777, 0o700);
  for (const name of backups) assert.equal(fs.statSync(join(f.hud, 'backups', 'trust', name)).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(
      join(
        f.hud,
        'backups',
        'trust',
        backups.find((name) => name.startsWith('grok-'))!
      ),
      'utf8'
    ),
    grokBefore
  );

  f.reset();
  const after = fs.readFileSync(grok);
  assert.equal(await main(['trust', f.project], f.io), 0);
  assert.match(f.out(), /^grok: already trusted\nagy: already trusted\nclaude: already trusted\ncodex: skipped /);
  assert.deepEqual(fs.readFileSync(grok), after);
  assert.equal(fs.readdirSync(join(f.hud, 'backups', 'trust')).length, 3);
});

test('a missing trust file is not installed and is not created', async (t) => {
  const f = fixture(t);
  const codex = join(f.home, '.codex');
  fs.mkdirSync(codex);
  fs.writeFileSync(join(codex, 'config.toml'), 'stay\n');
  const before = tree(codex);
  assert.equal(await main(['trust', f.project], f.io), 0);
  assert.match(f.out(), /^grok: not installed\nagy: not installed\nclaude: not installed\ncodex: skipped /);
  assert.equal(fs.existsSync(join(f.home, '.grok')), false);
  assert.equal(fs.existsSync(join(f.home, '.gemini')), false);
  assert.equal(fs.existsSync(join(f.home, '.claude.json')), false);
  assert.equal(tree(codex), before);
  assert.equal(fs.existsSync(join(f.hud, 'backups')), false);
});

test('claude honours CLAUDE_CONFIG_DIR and keeps the home file', async (t) => {
  const f = fixture(t);
  const cfg = join(f.root, 'claude-cfg');
  fs.mkdirSync(cfg);
  const cfgFile = join(cfg, '.claude.json');
  const homeFile = join(f.home, '.claude.json');
  fs.writeFileSync(cfgFile, '{"projects":{"/elsewhere":{"hasTrustDialogAccepted":false,"kept":1}}}\n');
  fs.writeFileSync(homeFile, '{"from":"home"}\n');
  f.io.env.CLAUDE_CONFIG_DIR = cfg;
  assert.equal(await main(['trust', f.project], f.io), 0);
  assert.match(f.out(), /claude: trusted/);
  assert.equal(fs.readFileSync(homeFile, 'utf8'), '{"from":"home"}\n');
  const got = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.equal(got.projects['/elsewhere'].kept, 1);
  assert.deepEqual(got.projects[f.project], { hasTrustDialogAccepted: true });
});

test('a bad directory exits 2; help lists trust', async (t) => {
  const f = fixture(t);
  assert.equal(await main(['trust'], f.io), 2);
  assert.match(f.err(), /usage: hud trust <dir>/);
  f.reset();
  assert.equal(await main(['trust', join(f.root, 'missing')], f.io), 2);
  assert.match(f.err(), /not a directory/);
  const file = join(f.root, 'file');
  fs.writeFileSync(file, 'x');
  f.reset();
  assert.equal(await main(['trust', file], f.io), 2);
  assert.match(f.err(), /not a directory/);
  f.reset();
  assert.equal(await main(['--help'], f.io), 0);
  assert.match(f.out(), /hud trust <dir>/);
  f.reset();
  assert.equal(await main(['nope'], f.io), 2);
  assert.match(f.err(), /invalid_command:.*\btrust\b/);
});

test('a symlink or unparseable JSON fails that agent and writes nothing', async (t) => {
  const f = fixture(t);
  const agyDir = join(f.home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(agyDir, { recursive: true });
  const real = join(f.root, 'real-settings.json');
  fs.writeFileSync(real, '{"theme":"keep"}\n');
  fs.symlinkSync(real, join(agyDir, 'settings.json'));
  const claude = join(f.home, '.claude.json');
  fs.writeFileSync(claude, '{');
  const grok = join(f.home, '.grok', 'trusted_folders.toml');
  fs.mkdirSync(join(f.home, '.grok'));
  fs.writeFileSync(grok, 'keep\n');
  assert.equal(await main(['trust', f.project], f.io), 1);
  assert.match(
    f.out(),
    /grok: trusted\nagy: failed \(symlinked target\)\nclaude: failed \(unparseable JSON\)\ncodex: skipped /
  );
  assert.equal(fs.readFileSync(real, 'utf8'), '{"theme":"keep"}\n');
  assert.ok(fs.lstatSync(join(agyDir, 'settings.json')).isSymbolicLink());
  assert.equal(fs.readFileSync(claude, 'utf8'), '{');
  const backups = fs.readdirSync(join(f.hud, 'backups', 'trust'));
  assert.deepEqual(
    backups.map((name) => name.split('-')[0]),
    ['grok']
  );
});
