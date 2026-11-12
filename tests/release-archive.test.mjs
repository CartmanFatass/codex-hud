import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const archive = `hud-${version}.tar.gz`;
const excluded = ['tests', 'docs/reviews', 'docs/handoff', '.scratch', '.github', '.codegraph', 'cx-continue',
  '.git', 'dist', 'dist-test', 'packages/hud-mcp/dist', 'tmp', 'AGENTS.md', 'CLAUDE.md'];

// Only external client registration is simulated; archive, build, launchers and MCP are real.
const client = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.CLIENT_LOG, JSON.stringify([name, ...args]) + '\\n');
if (name === 'pi') {
  const file = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file));
  if (args[0] === 'install') settings.packages = [...new Set([...settings.packages, args[1]])];
  else if (args[0] === 'remove') settings.packages = settings.packages.filter(p => p !== args[1]);
  else process.exit(99);
  fs.writeFileSync(file, JSON.stringify(settings));
} else if (name === 'claude') {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'registrations.json');
  const settings = JSON.parse(fs.readFileSync(file));
  if (args[0] !== 'mcp') process.exit(99);
  if (args[1] === 'add') settings.hud = args.at(-1);
  else if (args[1] === 'remove') delete settings.hud;
  else process.exit(99);
  fs.writeFileSync(file, JSON.stringify(settings));
} else if (name === 'codex') {
  const file = path.join(process.env.CODEX_HOME, 'config.toml');
  let text = fs.readFileSync(file, 'utf8').replace(/^\\[mcp_servers\\.hud\\]\\n(?:(?!^\\[).*\\n)*/gm, '');
  if (args[0] !== 'mcp') process.exit(99);
  if (args[1] === 'add') text += '[mcp_servers.hud]\\ncommand = ' + JSON.stringify(args.at(-1)) + '\\n';
  else if (args[1] !== 'remove') process.exit(99);
  fs.writeFileSync(file, text);
} else process.exit(99);
`;

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

function audit(tree) {
  // Scan every byte-bearing member, including bundled dependencies, not just emitted JS.
  const broad = /\/home\/|fires|MyHUD-wt|[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\w*_API_KEY\s*=\s*\S+|sk-|\b(?:token|secret)\b/gi;
  const privateText = /\/home\/|MyHUD-wt|\bfires\b|[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\w*_API_KEY\s*=\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s'"`]+)|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})/g;
  const author = spawnSync('git', ['log', '-1', '--format=%an%n%ae', '--', 'src/roles/roster.ts'], { cwd: root, encoding: 'utf8' });
  assert.equal(author.status, 0);
  const identities = [os.userInfo().username, ...author.stdout.trim().split('\n')]
    .filter(Boolean).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const ownerText = new RegExp(`\\b(?:${identities.join('|')})\\b`, 'gi');
  const secretText = /\b\w*_API_KEY\s*=\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s'"`]+)|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})|-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
  let count = 0, firstParty = 0, broadCount = 0;
  const upstream = [];
  for (const file of files(tree)) {
    const name = path.relative(tree, file);
    const text = name + '\n' + (fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString('utf8'));
    count++;
    broadCount += [...text.matchAll(broad)].length;
    assert.deepEqual([...text.matchAll(secretText)], [], `credential-like value in ${name}`);
    const hits = [...text.matchAll(privateText)];
    if (name.startsWith('node_modules/')) {
      if (hits.length) upstream.push({ member: name, hits: hits.map(hit => hit[0]) });
      continue;
    }
    firstParty++;
    assert.deepEqual([...text.matchAll(ownerText)], [], `owner identity in ${name}`);
    assert.deepEqual(hits.map(hit => hit[0]), [], `private material in ${name}`);
    if (name.endsWith('.md')) {
      // Inline Markdown/HTML and reference-style destinations; anchors stay in their containing file.
      const links = [...text.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)|(?:href|src)=["']([^"']+)["']|^\s*\[[^\]]+\]:\s*(\S+)/gm)];
      for (const match of links) {
        const url = (match[1] ?? match[2] ?? match[3]).replace(/^<|>$/g, '');
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue;
        const target = path.resolve(path.dirname(file), decodeURIComponent(url.split(/[?#]/)[0]));
        assert.ok(target === tree || target.startsWith(tree + path.sep), `${name}: link escapes archive: ${url}`);
        assert.ok(fs.existsSync(target), `${name}: broken relative link: ${url}`);
      }
    }
  }
  console.log(`All-member audit: ${count} file/link members; ${broadCount} broad path/email/key/sk-/token/secret candidates (includes code/prose).`);
  console.log(`First-party audit: ${firstParty} members; regex=${privateText}; zero hits (also owner login and runtime git-author name/email). All first-party Markdown relative links resolve inside archive.`);
  console.log('Public upstream metadata/examples (unchanged): ' + JSON.stringify(upstream));
}

test('release archive: isolated offline install, all extensions, stdio MCP and both uninstall entries', { timeout: 60000 }, async (t) => {
  const started = Date.now();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-release-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const tools = path.join(temp, 'tools'), home = path.join(temp, 'home'), hud = path.join(temp, 'hud home');
  const bin = path.join(home, '.local/bin');
  const extraction = path.join(temp, 'extracted with spaces');
  const tree = path.join(extraction, `hud-${version}`);
  for (const dir of [tools, bin, hud, extraction]) fs.mkdirSync(dir, { recursive: true });
  for (const name of ['bash', 'sh', 'dirname', 'readlink', 'mkdir', 'ln', 'rm', 'cp', 'cat', 'basename', 'grep', 'sed', 'git', 'tar', 'gzip']) {
    fs.symlinkSync(`/usr/bin/${name}`, path.join(tools, name));
  }
  fs.symlinkSync(process.execPath, path.join(tools, 'node'));
  const npm = spawnSync('which', ['npm'], { encoding: 'utf8' });
  assert.equal(npm.status, 0);
  fs.symlinkSync(fs.realpathSync(npm.stdout.trim()), path.join(tools, 'npm'));
  const env = {
    HOME: home, HUD_HOME: hud, PATH: `${bin}:${tools}`, TZ: 'UTC',
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
    HERDR_SOCKET_PATH: path.join(temp, 'unused.sock'),
    npm_config_offline: 'true', npm_config_cache: path.join(temp, 'empty-npm-cache'),
    CLIENT_LOG: path.join(temp, 'client-argv.jsonl'),
  };
  function run(command, args = [], { cwd = tree, status = 0, input, override = {} } = {}) {
    const result = spawnSync(command, args, {
      cwd, env: { ...env, ...override }, encoding: 'utf8', input, timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    });
    console.log(`$ ${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}exit=${result.status}`);
    assert.equal(result.error, undefined);
    assert.equal(result.status, status);
    return result.stdout + result.stderr;
  }
  run('npm', ['run', 'release'], { cwd: root });
  const members = run('tar', ['-tzf', path.join(root, archive)], { cwd: root }).trim().split('\n');
  console.log(`Archive ${archive}: ${fs.statSync(path.join(root, archive)).size} bytes, ${members.length} members.`);
  for (const member of members) {
    assert.ok(member.startsWith(`hud-${version}/`), member);
    const name = member.slice(`hud-${version}/`.length).replace(/\/$/, '');
    assert.ok(!name.split('/').includes('..') && !path.isAbsolute(name), member);
    for (const excludedPath of excluded) assert.ok(name !== excludedPath && !name.startsWith(excludedPath + '/'), member);
    assert.ok(!member.endsWith('/CLAUDE.md'), member);
  }
  for (const required of ['install', 'install.d/pi.sh', 'bin/hud', 'packages/hud-mcp/src/thin-main.ts',
    'packages/hud-mcp/bin/hud-watch.mjs', 'packages/hud-mcp/bin/hud-jev.mjs', 'packages/hud-mcp/hud-convention.md',
    'packages/hud-mcp/roles/imp.json', 'integrations/skills/hud-delegate/SKILL.md',
    'node_modules/typescript/bin/tsc', 'node_modules/@iarna/toml/LICENSE', 'package-lock.json', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(members.includes(`hud-${version}/${required}`), `missing ${required}`);
  }
  run('tar', ['-xzf', path.join(root, archive), '-C', extraction], { cwd: root });
  audit(tree);
  assert.equal(fs.existsSync(path.join(tree, 'dist')), false);
  assert.equal(fs.existsSync(path.join(tree, 'packages/hud-mcp/dist')), false);
  assert.ok(fs.statSync(path.join(tree, 'install')).mode & 0o111);
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'rehearsal requires supported Node');
  for (const metadata of ['package.json', 'packages/hud-mcp/package.json']) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(tree, metadata))).engines.node, '>=24.0.0');
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(tree, 'package-lock.json'))).packages[''].engines.node, '>=24.0.0');

  const keep = new Map([
    [path.join(hud, 'credentials.env'), 'ARCHIVE_SENTINEL=synthetic-not-a-credential\n'],
    [path.join(hud, 'jobs/synthetic/report.md'), 'Synthetic retained report.\n'],
    [path.join(hud, 'config.json'), '{"unrelated":true}\n'],
    [path.join(env.CODEX_HOME, 'auth.json'), '{"synthetic":"not-a-credential"}\n'],
    [path.join(env.CLAUDE_CONFIG_DIR, 'unrelated.txt'), 'Synthetic unrelated data.\n'],
    [path.join(env.PI_CODING_AGENT_DIR, 'auth.json'), '{"synthetic":"not-a-credential"}\n'],
    [path.join(env.PI_CODING_AGENT_DIR, 'sessions/synthetic/session.jsonl'), '{"synthetic":"session"}\n'],
    [path.join(env.PI_CODING_AGENT_DIR, 'extensions/private.ts'), '// Synthetic private extension.\n'],
    [path.join(bin, 'unrelated-command'), 'Synthetic owner command.\n'],
  ]);
  for (const [file, text] of keep) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  }
  const claudeSettings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  const claudeRegistrations = path.join(env.CLAUDE_CONFIG_DIR, 'registrations.json');
  const piSettings = path.join(env.PI_CODING_AGENT_DIR, 'settings.json');
  const codexConfig = path.join(env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(claudeSettings, '{"unrelated":true}\n');
  fs.writeFileSync(claudeRegistrations, '{"keep":"synthetic"}\n');
  fs.writeFileSync(piSettings, '{"packages":["npm:synthetic"],"extensions":["private.ts"],"theme":"synthetic"}\n');
  const codexOriginal = '# Synthetic config\nmodel = "synthetic"\n[mcp_servers.keep]\ncommand = "keep"\n';
  fs.writeFileSync(codexConfig, codexOriginal);
  const json = (file) => JSON.parse(fs.readFileSync(file));

  // README core command, with an empty npm cache and no build output: no --skip-build.
  console.log('Offline build: npm_config_offline=true; empty npm cache; PATH contains only temporary bin/tools.');
  assert.match(run('./install'), /Dependencies already present/);
  assert.ok(fs.statSync(path.join(tree, 'dist/cli/hud.js')).isFile());
  assert.ok(fs.statSync(path.join(tree, 'packages/hud-mcp/dist/packages/hud-mcp/src/thin-main.js')).isFile());
  assert.match(run('hud', ['--help']), /Usage: hud/);
  for (const name of ['claude', 'pi', 'codex']) fs.writeFileSync(path.join(tools, name), client, { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'herdr'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLIENT_LOG, JSON.stringify(['herdr', ...args]) + '\\n');
if (args[0] !== 'pane' || !['current', 'split', 'rename', 'run'].includes(args[1])) process.exit(99);
console.log(JSON.stringify({ result: args[1] === 'split' ? { pane: { pane_id: 'synthetic-panel' } } : {} }));
`, { mode: 0o755 });
  for (const name of ['google-chrome', 'jev-ask', 'jev-aistudio', 'jev-flow']) {
    fs.writeFileSync(path.join(tools, name), '#!/bin/bash\necho "Prerequisite stand-in must not be executed" >&2\nexit 99\n', { mode: 0o755 });
  }
  const extensions = 'claude,pi,codex,browser,herdr';
  // The README's --with command selecting every extension, again without --skip-build.
  run('./install', ['--with', extensions]);
  const mcpCommand = path.join(bin, 'hud-mcp');
  assert.equal(json(claudeRegistrations).hud, mcpCommand);
  assert.equal(json(claudeSettings).statusLine.command, path.join(bin, 'hud-statusline'));
  assert.match(fs.readFileSync(codexConfig, 'utf8'), /\[mcp_servers\.hud\]/);
  assert.ok(fs.readFileSync(codexConfig, 'utf8').includes(JSON.stringify(mcpCommand)));
  const packages = ['pi-package', 'pi-display'].map(name => path.join(hud, name));
  assert.deepEqual(json(piSettings).packages, ['npm:synthetic', ...packages]);
  assert.ok(json(piSettings).extensions.includes('-extensions/p10k-footer.ts'));
  for (const pkg of packages) {
    const { loadBinding } = await import(pathToFileURL(path.join(pkg, 'binding.mjs')));
    assert.equal(loadBinding(pathToFileURL(path.join(pkg, 'binding.json'))).release, tree);
    const manifest = json(path.join(pkg, 'package.json'));
    for (const entry of [...manifest.pi.extensions, ...(manifest.pi.skills ?? [])]) assert.ok(fs.existsSync(path.join(pkg, entry)));
  }
  for (const file of files(home)) if (fs.lstatSync(file).isSymbolicLink()) assert.ok(fs.existsSync(file), `dangling installed link: ${file}`);
  assert.equal(run('hud', ['panel'], { override: { HERDR_PANE_ID: 'synthetic-caller', COLUMNS: '120' } }).trim(), 'synthetic-panel');
  const panelCalls = fs.readFileSync(env.CLIENT_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(panelCalls.some(call => call[0] === 'herdr' && call[2] === 'run' && call[3] === 'synthetic-panel' &&
    call[4].includes(path.join(tree, 'bin/hud')) && call[4].includes("'panel' '--here'")));
  run('hud', ['statusline', '--help']);
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'archive-rehearsal', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hud_roster', arguments: {} } },
  ];
  const replies = run('hud-mcp', [], { input: requests.map(request => JSON.stringify(request)).join('\n') + '\n' })
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 3);
  assert.equal(replies.find(reply => reply.id === 1).result.serverInfo.name, 'hud-mcp-thin');
  assert.deepEqual(replies.find(reply => reply.id === 2).result.tools.map(tool => tool.name),
    ['hud_roster', 'hud_create', 'hud_read', 'hud_send', 'hud_respond', 'hud_close']);
  const roster = JSON.parse(replies.find(reply => reply.id === 3).result.content[0].text);
  assert.deepEqual(roster.roles.map(role => role.role).sort(),
    fs.readdirSync(path.join(tree, 'packages/hud-mcp/roles')).map(name => name.replace('.json', '')).sort());
  assert.equal(roster.convention.path, path.join(tree, 'packages/hud-mcp/hud-convention.md'));
  assert.ok(roster.convention.text.length > 100);

  function removed() {
    for (const name of ['hud', 'hud-mcp', 'hud-statusline']) assert.equal(fs.lstatSync(path.join(bin, name), { throwIfNoEntry: false }), undefined);
    assert.deepEqual(json(claudeRegistrations), { keep: 'synthetic' });
    assert.deepEqual(json(claudeSettings), { unrelated: true });
    assert.equal(fs.readFileSync(codexConfig, 'utf8'), codexOriginal);
    assert.deepEqual(json(piSettings), { packages: ['npm:synthetic'], extensions: ['private.ts'], theme: 'synthetic' });
    for (const file of [...packages, path.join(env.CLAUDE_CONFIG_DIR, 'skills/hud-delegate'),
      path.join(env.CLAUDE_CONFIG_DIR, 'commands/hud.md'), path.join(env.CODEX_HOME, 'skills/hud-delegate')]) {
      assert.equal(fs.lstatSync(file, { throwIfNoEntry: false }), undefined, file);
    }
    for (const [file, text] of keep) assert.equal(fs.readFileSync(file, 'utf8'), text, `retained: ${file}`);
    const calls = fs.readFileSync(env.CLIENT_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    for (const name of ['claude', 'codex']) assert.ok(calls.some(call => call[0] === name && call[1] === 'mcp' && call[2] === 'remove'));
    for (const pkg of packages) assert.ok(calls.some(call => call[0] === 'pi' && call[1] === 'remove' && call[2] === pkg));
    console.log('Owned commands/registrations removed; HUD reports/config/keys, unrelated client config/auth and pi sessions/extensions preserved.');
  }
  run('./install', ['--uninstall']);
  removed();
  run('./install', ['--skip-build', '--with', extensions]);
  run('hud', ['uninstall']);
  removed();
  console.log(`Rehearsal elapsed: ${Date.now() - started} ms.`);
});
