/** One opt-in real pack shared by all artifact smoke paths; no harness/provider login. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import {
  buildRuntime,
  productionEnvironment,
  validateDependencyEntrypoints,
  dependencyMetadataPath,
} from '../../scripts/pack-runtime.mjs';
import { DEPENDENCIES, verifyBundle, REQUIRED } from '../../scripts/runtime-package/manifest.mjs';
import { planInstall, executeInstall } from '../../scripts/runtime-package/installer.mjs';
import { planActivation, restoreActivation } from '../../scripts/runtime-package/activation.mjs';
import { relative, runtime, digest, MAX_FILE, MAX_TOTAL, MAX_ENTRIES } from '../../scripts/runtime-package/safety.mjs';
import { LICENSE_SUPPLEMENT, licenseSupplement } from '../../scripts/runtime-package/license-supplements.mjs';

test('release inventory still refuses dot-prefixed client metadata', () => {
  for (const name of ['integrations/claude/.claude-plugin/plugin.json', 'integrations/pi/.mcp.json'])
    assert.throws(() => relative(name), /unsafe_relative_path/);
  for (const name of [
    'activate-runtime.mjs',
    'runtime-package/activation.mjs',
    'runtime-package/activation-cli.mjs',
    'dist/cli/install.js',
    'integrations/skills/hud-delegate/SKILL.md',
    'integrations/claude/README.md',
    'integrations/pi/package/README.md',
  ])
    assert.ok(REQUIRED.includes(name), name);
});
test('production child environment inherits only standard proxy variables plus isolated values', () => {
  const isolated = {
    HOME: '/tmp/synthetic-home',
    HUD_HOME: '/tmp/synthetic-home/hud',
    PATH: '/usr/bin',
    npm_config_cache: '/tmp/synthetic-cache',
  };
  const names = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ];
  const proxy = Object.fromEntries(names.map((name) => [name, 'synthetic-proxy-value']));
  assert.deepEqual(
    productionEnvironment(isolated, {
      ...proxy,
      SECRET_KEY: 'must-not-leak',
      NODE_OPTIONS: '--require foreign',
      npm_config_userconfig: 'foreign',
      npm_config_proxy: 'foreign',
    }),
    { ...isolated, ...proxy }
  );
  assert.deepEqual(productionEnvironment(isolated, {}), isolated);
});
test('dependency dot-metadata is omitted only when not declared as an entrypoint', () => {
  for (const name of ['.github', '.eslintrc', '.keep']) assert.equal(dependencyMetadataPath(name), true);
  for (const name of ['index.js', 'LICENSE', 'package.json', 'dist']) assert.equal(dependencyMetadataPath(name), false);
  for (const key of ['main', 'module', 'exports', 'imports', 'bin']) {
    assert.throws(
      () => validateDependencyEntrypoints({ [key]: { nested: { node: './lib/.required.js' } } }),
      /dot_prefixed_dependency_entrypoint/
    );
    validateDependencyEntrypoints({ [key]: { nested: { node: './lib/required.js' } } });
  }
});
test('single read-only installed closure inventory reports every copier/license/safety blocker', () => {
  const lock = JSON.parse(fs.readFileSync('package-lock.json'));
  const blockers = [];
  let count = 0,
    total = 0,
    omitted = 0,
    sharedLinks = 0;
  for (const name of Object.keys(DEPENDENCIES)) {
    const root = path.resolve('node_modules', name);
    let hasLicense = false;
    try {
      validateDependencyEntrypoints(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))));
    } catch (e) {
      blockers.push(`${name}: ${e.message}`);
    }
    function walk(dir, prefix = '') {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        if (dependencyMetadataPath(entry.name)) {
          omitted++;
          continue;
        }
        const rel = prefix + entry.name;
        const file = path.join(dir, entry.name);
        const stat = fs.lstatSync(file);
        if (stat.isDirectory()) walk(file, rel + '/');
        else if (!stat.isFile() || stat.isSymbolicLink()) blockers.push(`special/link: ${name}/${rel}`);
        else {
          // Development worktrees share hardlinks; the isolated npm-ci tree does not.
          if (stat.nlink > 1) sharedLinks++;
          count++;
          total += stat.size;
          if (stat.size > MAX_FILE) blockers.push(`oversize: ${name}/${rel}`);
          try {
            relative(`node_modules/${name}/${rel}`);
          } catch (e) {
            blockers.push(`${name}/${rel}: ${e.message}`);
          }
          if (/^licen[sc]e(?:\..*)?$/i.test(rel)) hasLicense = true;
        }
      }
    }
    walk(root);
    if (!hasLicense) {
      const supplement = licenseSupplement(name, lock.packages[`node_modules/${name}`]);
      if (!supplement || digest(fs.readFileSync(supplement.source)) !== supplement.sha256)
        blockers.push(`missing license: ${name}`);
    }
  }
  if (count > MAX_ENTRIES || total > MAX_TOTAL) blockers.push(`closure bounds: ${count}/${total}`);
  console.log(
    `DEPENDENCY_INVENTORY files=${count} bytes=${total} omittedDotRoots=${omitted} developmentSharedLinks=${sharedLinks}; ALL_BLOCKERS=${JSON.stringify(blockers)}`
  );
  assert.deepEqual(blockers, []);
});
test('license supplement is pinned to exact name version integrity and upstream bytes', () => {
  const s = LICENSE_SUPPLEMENT;
  assert.equal(digest(fs.readFileSync(s.source)), s.sha256);
  assert.equal(licenseSupplement(s.name, { version: s.version, integrity: s.integrity }), s);
  assert.equal(licenseSupplement(s.name, { version: '1.1.2', integrity: s.integrity }), null);
  assert.equal(licenseSupplement(s.name, { version: s.version, integrity: 'changed' }), null);
  assert.equal(licenseSupplement('other', { version: s.version, integrity: s.integrity }), null);
});
test('unsupported Node and platform are clearly refused before writes', () => {
  const node = Object.getOwnPropertyDescriptor(process.versions, 'node');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process.versions, 'node', { value: '23.0.0', configurable: true });
    assert.throws(runtime, /requires_linux_node_22_13_or_24/);
    Object.defineProperty(process.versions, 'node', node);
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    assert.throws(runtime, /requires_linux_node_22_13_or_24/);
  } finally {
    Object.defineProperty(process.versions, 'node', node);
    Object.defineProperty(process, 'platform', platform);
  }
});
async function mcp(entry, env) {
  const child = spawn(process.execPath, [entry], {
    env: { ...env, HUD_MCP_SURFACE: 'roles' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '',
    errors = '';
  child.stdout.on('data', (b) => {
    output += b;
  });
  child.stderr.on('data', (b) => {
    errors += b;
  });
  const done = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'synthetic-artifact-smoke', version: '1' },
        },
      }) + '\n'
    );
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    const deadline = Date.now() + 8000;
    while (!output.split('\n').some((line) => line.includes('"id":2')) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    child.stdin.end();
    assert.equal(await done, 0, errors);
    const messages = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(messages.find((m) => m.id === 1)?.result);
    const tools = messages.find((m) => m.id === 2)?.result?.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'hud_close',
      'hud_create',
      'hud_read',
      'hud_respond',
      'hud_roster',
      'hud_send',
    ]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await done;
    }
  }
}
test(
  'real pack, real stage installer and activation run standalone in paths with spaces; stale working dist excluded',
  {
    skip: process.env.R6A_REAL_PACK !== '1' ? 'opt-in: R6A_REAL_PACK=1 (one shared clean pack)' : false,
    timeout: 240000,
  },
  async () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'hud real release '));
    const sentinel = path.resolve('dist/r6a-stale-output.js');
    assert.equal(fs.existsSync(sentinel), false, 'never overwrite a working artifact');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, 'throw Error("STALE");\n', { mode: 0o600 });
    let report, buildDirectory;
    try {
      try {
        report = await buildRuntime();
        buildDirectory = path.dirname(report.bundle);
      } catch (error) {
        buildDirectory = error.runtimeBuildDirectory;
        throw error;
      }
      assert.equal(report.status, 'PASS');
      assert.ok(report.dependencyOmissions.count > 0);
      const bundle = verifyBundle(report.bundle);
      try {
        assert.equal(
          bundle.manifest.entries.some((e) => e.path.endsWith('r6a-stale-output.js')),
          false
        );
        assert.match(bundle.manifest.provenance, /Omitted [1-9][0-9]* dot-prefixed dependency metadata/);
        for (const name of ['package.json', 'packages/hud-mcp/package.json'])
          assert.equal(JSON.parse(bundle.directory.read(name).data).version, bundle.manifest.releaseVersion);
        assert.deepEqual(
          bundle.directory.read('integrations/skills/hud-delegate/SKILL.md').data,
          fs.readFileSync('integrations/skills/hud-delegate/SKILL.md')
        );
      } finally {
        bundle.directory.close();
      }
      const prefix = path.join(root, 'runtime prefix');
      const home = path.join(root, 'temporary home');
      for (const dir of [prefix, home]) fs.mkdirSync(dir, { mode: 0o700 });
      const env = {
        HOME: home,
        HUD_HOME: path.join(home, 'hud home'),
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      };
      const p = planInstall(report.bundle, prefix, undefined, false, true);
      const staged = executeInstall(report.bundle, prefix, p.planDigest, undefined, { stageOnly: true });
      assert.equal(staged.status, 'STAGED');
      assert.equal(fs.existsSync(path.join(prefix, 'current')), false);
      const options = {
        prefix,
        hudHome: env.HUD_HOME,
        shimDir: path.join(home, 'public bin'),
        release: p.bundleDigest,
        path: env.PATH,
      };
      const preview = planActivation(options);
      const activated = spawnSync(
        process.execPath,
        [
          path.join(report.bundle, 'activate-runtime.mjs'),
          'install',
          'apply',
          '--prefix',
          prefix,
          '--release',
          p.bundleDigest,
          '--hud-home',
          options.hudHome,
          '--shim-dir',
          options.shimDir,
          '--plan',
          preview.planId,
        ],
        { env, cwd: home, encoding: 'utf8', timeout: 20000 }
      );
      assert.equal(activated.status, 0, activated.stderr);
      const active = JSON.parse(activated.stdout);
      const release = path.join(prefix, 'releases', p.bundleDigest);
      for (const command of [path.join(release, 'bin/hud'), path.join(options.shimDir, 'hud')]) {
        const help = spawnSync(process.execPath, [command, '--help'], {
          env,
          cwd: home,
          encoding: 'utf8',
          timeout: 10000,
        });
        assert.equal(help.status, 0, help.stderr);
        assert.match(help.stdout, /hud/);
        const installHelp = spawnSync(process.execPath, [command, 'install', '--help'], {
          env,
          cwd: home,
          encoding: 'utf8',
          timeout: 10000,
        });
        assert.equal(installHelp.status, 0, installHelp.stderr);
        assert.match(installHelp.stdout, /Reversible activation/);
      }
      const status = spawnSync(process.execPath, [path.join(options.shimDir, 'hud-statusline')], {
        env,
        cwd: home,
        input: '{}',
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(status.status, 0, status.stderr);
      await mcp(path.join(release, 'packages/hud-mcp/bin/hud-mcp.mjs'), env);
      await mcp(path.join(options.shimDir, 'hud-mcp'), env);
      const publicHud = path.join(options.shimDir, 'hud');
      const original = fs.readFileSync(publicHud);
      fs.appendFileSync(publicHud, '// synthetic owner edit\n');
      const conflict = spawnSync(
        process.execPath,
        [path.join(report.bundle, 'activate-runtime.mjs'), 'install', 'restore', '--receipt', active.receipt],
        { env, cwd: home, encoding: 'utf8', timeout: 10000 }
      );
      assert.equal(conflict.status, 4, conflict.stderr);
      assert.equal(JSON.parse(conflict.stdout).status, 'CONFLICT');
      fs.writeFileSync(publicHud, original);
      assert.equal(restoreActivation(active.receipt).status, 'deactivated; release retained');
      console.log(
        `REAL_PACK_PASS entries=${report.entries} bytes=${report.bytes} releaseVersion=${report.releaseVersion} digest=${report.manifestDigest}; packed hud/help, install/help, statusline/stdin, MCP initialize+six tools (release and public shim); full packs=1`
      );
    } finally {
      fs.unlinkSync(sentinel);
      if (buildDirectory) {
        const out = buildDirectory;
        if (process.env.R6A_EVIDENCE_DIR) {
          fs.mkdirSync(process.env.R6A_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
          for (const name of fs
            .readdirSync(out)
            .filter((n) => n.endsWith('.log') || n.endsWith('.receipt.json') || n === 'runtime-build.json'))
            fs.copyFileSync(path.join(out, name), path.join(process.env.R6A_EVIDENCE_DIR, name));
        }
        fs.rmSync(out, { recursive: true, force: true });
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
