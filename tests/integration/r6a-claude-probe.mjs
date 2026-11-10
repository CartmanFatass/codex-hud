#!/usr/bin/env node
/** Real CLI proof, always fresh private HOME/HUD_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR + local fake. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const sha = (b) => createHash('sha256').update(b).digest('hex');
export function assessResidue(
  residue,
  installed,
  settings,
  registry,
  marketplaces,
  cliVersion,
  releaseVersion,
  allWritten = []
) {
  const cache = `.claude/plugins/cache/hud-rehearsal/hud/${releaseVersion}`;
  const fixed = new Set([
    '.claude',
    '.claude/.claude.json',
    '.claude/backups',
    '.claude/plugins',
    '.claude/plugins/cache',
    '.claude/plugins/cache/hud-rehearsal',
    '.claude/plugins/cache/hud-rehearsal/hud',
    '.claude/plugins/installed_plugins.json',
    '.claude/plugins/known_marketplaces.json',
    '.claude/plugins/marketplaces',
    '.claude/settings.json',
    'hud',
    'codex',
  ]);
  const unexpected = [...new Set([...Object.keys(residue), ...allWritten])].filter(
    (p) =>
      !fixed.has(p) &&
      !p.startsWith(cache + '/') &&
      p !== cache &&
      !/^\.claude\/backups\/\.claude\.json\.backup\.\d+$/.test(p)
  );
  const originals = Object.keys(installed).filter((p) => p === cache || p.startsWith(cache + '/'));
  const retained = Object.keys(residue).filter((p) => p === cache || p.startsWith(cache + '/'));
  const cacheChanged =
    originals.length === 0 ||
    originals.some((p) => JSON.stringify(installed[p]) !== JSON.stringify(residue[p])) ||
    retained.some((p) => p !== cache + '/.orphaned_at' && !originals.includes(p)) ||
    !/^[a-f0-9]{64}$/.test(residue[cache + '/.orphaned_at']?.hash ?? ''); // Only regular files receive a SHA-256 snapshot.
  const links = Object.keys(residue).filter((p) => residue[p].hash.startsWith('link:'));
  const noRegistration =
    JSON.stringify(settings) === '{"env":{},"enabledPlugins":{},"extraKnownMarketplaces":{}}' &&
    registry.version === 2 &&
    Object.keys(registry.plugins ?? {}).length === 0 &&
    Object.keys(marketplaces).length === 0;
  return {
    pass:
      cliVersion === '2.1.319 (Claude Code)' &&
      noRegistration &&
      !cacheChanged &&
      unexpected.length === 0 &&
      links.length === 0,
    unexpected,
    cacheChanged,
    links,
    noRegistration,
    cachePolicy: `Claude keeps the plugin cache after uninstall; you can delete it by hand if wanted: ${cache}. HUD never deletes or restores it.`,
  };
}
export async function probeClaude(plugin, claude, mode = 'smoke', failure = null) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'hud-claude-probe-'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  for (const dir of [home, cwd, path.join(home, '.claude'), path.join(home, 'hud'), path.join(home, 'codex')])
    fs.mkdirSync(dir, { mode: 0o700 });
  const copied = path.join(root, 'cached plugin with spaces');
  fs.cpSync(plugin, copied, { recursive: true });
  let binding;
  try {
    binding = JSON.parse(fs.readFileSync(path.join(copied, 'binding.json')));
  } catch {
    throw Error('invalid_probe_plugin');
  }
  binding.hudHome = path.join(home, 'hud');
  binding.parityInventory = null;
  fs.writeFileSync(path.join(copied, 'binding.json'), JSON.stringify(binding), { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ env: {} }), { mode: 0o600 });
  if (failure === 'missingBinding') fs.unlinkSync(path.join(copied, 'scripts/binding.mjs'));
  if (failure === 'missingModule') fs.unlinkSync(path.join(copied, 'scripts/hook.mjs'));
  if (failure === 'nonzero')
    fs.writeFileSync(
      path.join(copied, 'scripts/hook.mjs'),
      'process.stdout.write("discard this output");process.exit(7);'
    );
  if (failure === 'missingNode' || failure === 'externalTimeout') {
    const file = path.join(copied, 'hooks/hooks.json'),
      hooks = JSON.parse(fs.readFileSync(file));
    const hook = hooks.hooks.UserPromptExpansion[0].hooks[0];
    if (failure === 'missingNode') {
      const quoted = "'" + binding.node.replace(/'/g, "'\\''") + "'";
      if (!hook.command.startsWith(quoted)) throw Error('probe_node_anchor_missing');
      hook.command = "'" + path.join(root, 'missing-node') + "'" + hook.command.slice(quoted.length);
    } else {
      hook.timeout = 0.05;
      fs.writeFileSync(path.join(copied, 'scripts/hook.mjs'), 'await new Promise(resolve=>setTimeout(resolve,500));');
    }
    fs.writeFileSync(file, JSON.stringify(hooks));
  }
  const requests = [];
  const server = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (b) => (bytes += b.length));
    req.on('end', () => {
      requests.push({ path: req.url, bytes });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Synthetic recording provider; no model execution.' },
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    HUD_HOME: binding.hudHome,
    CODEX_HOME: path.join(home, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_API_KEY: 'synthetic-dummy',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CI: '1',
  };
  async function run(args, timeout = 20000) {
    const started = performance.now();
    const child = spawn(claude, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += b;
    });
    child.stderr.on('data', (b) => {
      if (stderr.length < 2 * 1024 * 1024) stderr += b;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    const code = await new Promise((resolve) => {
      child.once('error', () => resolve(null));
      child.once('close', resolve);
    });
    clearTimeout(timer);
    return { args, code, timedOut, ms: performance.now() - started, stdout, stderr };
  }
  function snapshot(outside = false) {
    const base = outside ? root : home;
    const entries = {};
    function walk(dir) {
      for (const name of fs.readdirSync(dir).sort()) {
        const file = path.join(dir, name),
          s = fs.lstatSync(file),
          rel = path.relative(base, file);
        if (outside && file === home) continue;
        entries[rel] = {
          mode: s.mode & 0o777,
          hash: s.isFile()
            ? sha(fs.readFileSync(file))
            : s.isSymbolicLink()
              ? 'link:' + fs.readlinkSync(file)
              : 'directory',
        };
        if (s.isDirectory()) walk(file);
      }
    }
    walk(base);
    return entries;
  }
  function difference(before, after) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .filter((p) => JSON.stringify(before[p]) !== JSON.stringify(after[p]))
      .map((p) => ({ path: p, before: before[p] ?? null, after: after[p] ?? null }));
  }
  const initial = snapshot();
  const initialOutside = snapshot(true);
  const report = {
    root,
    mode,
    failure,
    cli: await run(['--version']),
    validation: await run(['plugin', 'validate', copied]),
    results: [],
    commands: {},
    ordinaryRequests: 0,
    status: 'NOT_VERIFIED',
  };
  report.incidentalStartupWriteSet = difference(initial, snapshot());
  report.incidentalOutsideWriteSet = difference(initialOutside, snapshot(true));
  try {
    if (mode === 'writes') {
      const market = path.join(root, 'marketplace');
      fs.mkdirSync(path.join(market, '.claude-plugin'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(market, 'plugins'), { mode: 0o700 });
      fs.cpSync(copied, path.join(market, 'plugins/hud'), { recursive: true });
      fs.writeFileSync(
        path.join(market, '.claude-plugin/marketplace.json'),
        JSON.stringify({
          name: 'hud-rehearsal',
          owner: { name: 'Synthetic' },
          plugins: [{ name: 'hud', source: './plugins/hud', version: binding.releaseVersion }],
        })
      );
      let before = snapshot();
      let outsideBefore = snapshot(true);
      let installed = {};
      for (const args of [
        ['plugin', 'marketplace', 'add', market, '--scope', 'user'],
        ['plugin', 'install', 'hud@hud-rehearsal', '--scope', 'user'],
        ['plugin', 'uninstall', 'hud@hud-rehearsal', '--scope', 'user'],
        ['plugin', 'marketplace', 'remove', 'hud-rehearsal'],
      ]) {
        const result = await run(args);
        const after = snapshot();
        if (args[1] === 'install') installed = after;
        const outsideAfter = snapshot(true);
        report.results.push({
          ...result,
          writeSet: difference(before, after),
          outsideWriteSet: difference(outsideBefore, outsideAfter),
        });
        before = after;
        outsideBefore = outsideAfter;
        if (result.code !== 0 || result.timedOut) break;
      }
      report.residue = snapshot();
      // No automatic cleanup/restoration of client-owned bytes: report exact residue for the owner.
      const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json')));
      const registry = JSON.parse(fs.readFileSync(path.join(home, '.claude/plugins/installed_plugins.json')));
      const marketplaces = JSON.parse(fs.readFileSync(path.join(home, '.claude/plugins/known_marketplaces.json')));
      report.residueCheck = assessResidue(
        report.residue,
        installed,
        settings,
        registry,
        marketplaces,
        report.cli.stdout.trim(),
        binding.releaseVersion,
        [...report.incidentalStartupWriteSet, ...report.results.flatMap((r) => r.writeSet)].map((entry) => entry.path)
      );
      report.uninstallVerified =
        report.residueCheck.pass &&
        report.incidentalOutsideWriteSet.length === 0 &&
        report.results.every((r) => r.outsideWriteSet.length === 0);
      report.status =
        report.results.length === 4 && report.results.every((r) => r.code === 0) && report.uninstallVerified
          ? 'PASS'
          : 'NOT_VERIFIED';
    } else {
      fs.mkdirSync(path.join(home, '.claude/commands'), { mode: 0o700 });
      fs.copyFileSync(path.join(copied, 'commands/hud.md'), path.join(home, '.claude/commands/hud.md'));
      for (const [name, prompt] of [
        ['canonical', '/hud:hud status'],
        ['alias', '/hud status'],
        ['setup', '/hud:setup preview'],
        ['ordinary', 'Ordinary synthetic probe.'],
      ]) {
        const before = requests.length;
        const result = await run([
          '--plugin-dir',
          copied,
          '--setting-sources',
          'user',
          '--no-session-persistence',
          '-p',
          prompt,
          '--output-format',
          'json',
          '--max-turns',
          '1',
          '--model',
          'claude-sonnet-4-6',
        ]);
        const count = requests.length - before;
        report.results.push({ ...result, name, requests: count });
        if (name === 'ordinary') report.ordinaryRequests = count;
        else report.commands[name] = count;
      }
      const controls = report.results.filter((r) => r.name !== 'ordinary');
      report.status =
        report.validation.code === 0 &&
        controls.every((r) => r.requests === 0 && !r.timedOut && /HUD:/.test(r.stdout + r.stderr)) &&
        report.ordinaryRequests > 0
          ? 'PASS'
          : 'NOT_VERIFIED';
      report.aliasReady = report.status === 'PASS';
      if (!failure) {
        report.failureProofs = {};
        for (const name of ['missingBinding', 'missingModule', 'nonzero', 'missingNode'])
          report.failureProofs[name] = await probeClaude(plugin, claude, 'smoke', name);
        report.negativeControls = Object.fromEntries(
          Object.entries(report.failureProofs).map(([name, p]) => [name, p.status === 'PASS'])
        );
        report.externalTimeout = await probeClaude(plugin, claude, 'smoke', 'externalTimeout');
        if (!Object.values(report.negativeControls).every(Boolean)) report.status = 'NOT_VERIFIED';
        report.aliasReady = report.status === 'PASS';
      }
    }
    report.providerRequests = requests;
    report.plugin = plugin;
    report.pluginHashes = Object.fromEntries(
      [
        '.claude-plugin/plugin.json',
        'hooks/hooks.json',
        'commands/hud.md',
        'scripts/hook.mjs',
        'scripts/binding.mjs',
        'scripts/mcp.mjs',
        '.mcp.json',
      ].map((p) => [p, sha(fs.readFileSync(path.join(plugin, p)))])
    );
    return report;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, plugin, claude] = process.argv.slice(2);
  if (!['smoke', 'writes'].includes(mode) || !path.isAbsolute(plugin ?? '') || !path.isAbsolute(claude ?? ''))
    throw Error('usage: node tests/integration/r6a-claude-probe.mjs smoke|writes ABS_PLUGIN ABS_CLAUDE');
  const report = await probeClaude(plugin, claude, mode);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'PASS' ? 0 : 2;
}
