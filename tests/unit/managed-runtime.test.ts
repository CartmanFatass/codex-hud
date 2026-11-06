import test from 'node:test';
import assert from 'node:assert/strict';
import { runNativeScenario } from '../fixtures/managed-native-runner.js';
import { simulatedCell } from '../fixtures/managed-native-scenario.js';
import {
  parseCapabilityManifest,
  matchesCapability,
  type CapabilityExpectation,
} from '../../src/core/capability-manifest.js';
const expected: CapabilityExpectation = {
  key: {
    harness: 'codex',
    profileDigest: 'a'.repeat(64),
    hostKind: 'none',
    layout: 'none',
    mode: 'headless',
    operation: 'spawn',
  },
  sourceId: 'b'.repeat(64),
  profileFingerprint: 'c'.repeat(64),
  topology: 'codex-direct-stdio/headless-argv-v1',
  versions: {
    hudRevision: 'sha256:' + 'd'.repeat(64),
    harness: '0.166.0',
    host: 'none',
    shell: 'none',
    node: '24.22.1',
    platform: 'linux',
    kernel: 'SIMULATED-linux',
    mcpClient: '0.166.0',
  },
};
test('strict manifest rejects malformed envelopes, duplicate JSON/key, bad sibling and wrong topology', () => {
  const cell = simulatedCell(expected);
  const base = { version: 1, hudRevision: expected.versions.hudRevision, cells: [cell] };
  const parse = (v: unknown) => parseCapabilityManifest(Buffer.from(JSON.stringify(v)));
  assert.equal(matchesCapability(parse(base), expected), true);
  for (const bad of [
    { ...base, extra: 1 },
    { ...base, version: 2 },
    { ...base, cells: [cell, cell] },
    { ...base, cells: [cell, {}] },
    {
      ...base,
      cells: [
        cell,
        { ...cell, key: { ...cell.key, operation: 'resume', resumeFrom: 'headless' }, incomplete: ['missing'] },
      ],
    },
    { ...base, cells: [{ ...cell, topology: 'other' }] },
    { ...base, cells: [{ ...cell, evidence: { ...cell.evidence, reviewStatus: 'pending' } }] },
    { ...base, cells: [{ ...cell, results: { ...cell.results, receipt: 'unverified' } }] },
  ])
    assert.equal(matchesCapability(parse(bad), expected), false);
  assert.equal(
    parseCapabilityManifest(Buffer.from(JSON.stringify(base).replace('"version":1', '"version":1,"version":1'))),
    null
  );
  assert.equal(parseCapabilityManifest(Buffer.alloc(262145, 32)), null);
  for (const name of Object.keys(expected.versions))
    assert.equal(
      matchesCapability(parse(base), { ...expected, versions: { ...expected.versions, [name]: 'changed' } }),
      false
    );
});
test(
  'SIMULATED owned native parent, independently observed target and exact startup composition',
  { timeout: 50000, skip: process.platform !== 'linux' },
  async (t) => {
    t.diagnostic(JSON.stringify(await runNativeScenario(false)));
  }
);

test(
  'SIMULATED native parent 0.165.0 cannot borrow independently observed target 0.166.0',
  { timeout: 50000, skip: process.platform !== 'linux' },
  async (t) => {
    const result = await runNativeScenario(false, '0.165.0');
    assert.equal(result.startup.parentObserved, false);
    assert.equal(result.dispatches, 0);
    t.diagnostic(JSON.stringify(result));
  }
);

import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readProcess } from '../../src/core/run/process.js';
for (const kind of [
  'managed-missing',
  'codex-missing',
  'managed-malformed',
  'codex-malformed',
  'both-missing',
] as const)
  test(`new-process default verifier and CLI help preserve refusal with ${kind}`, { timeout: 20000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'managed-native-loader-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    cpSync(resolve('dist'), join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    cpSync(resolve('bin/hud'), join(root, 'bin/hud'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}', { mode: 0o600 });
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
    for (const name of ['managed', 'codex'])
      if (kind.startsWith(name) || kind === 'both-missing') {
        const file = join(root, `dist/core/launch/${name}-cells.json`);
        if (kind.endsWith('missing')) rmSync(file);
        else writeFileSync(file, '{malformed');
      }
    const moduleUrl = pathToFileURL(join(root, 'dist/core/launch/capability.js')).href;
    const script = `import assert from 'node:assert/strict';
      const m = await import(${JSON.stringify(moduleUrl)});
      const options = {hudRevision:'SIMULATED',versions:{hudRevision:'SIMULATED',harness:'0.166.0',host:'none',shell:'none',node:process.versions.node,platform:process.platform,kernel:'SIMULATED',mcpClient:'0.166.0'}};
      const request = {key:{harness:'codex',profileDigest:'a'.repeat(64),hostKind:'none',layout:'none',mode:'headless',operation:'spawn'},sourceId:'b'.repeat(64),profileFingerprint:'c'.repeat(64),executableIdentity:{path:'/SIMULATED/codex',version:'0.166.0'}};
      for(const factory of [m.createShippedManagedCapabilityVerifier,m.createShippedCodexCapabilityVerifier]) assert.deepEqual(factory(options).verify(request),{ok:false,reason:'capability_unverified'});
      console.log('SIMULATED default-path refusal');`;
    for (const args of [
      ['--input-type=module', '--eval', script],
      [join(root, 'bin/hud'), '--help'],
      [join(root, 'bin/hud'), 'run', '--help'],
    ]) {
      const child = spawn(process.execPath, args, {
        cwd: root,
        env: { HOME: root, HUD_HOME: join(root, 'missing'), PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stamp = child.pid ? readProcess(child.pid)?.stamp : null;
      const deadlineAt = Date.now() + 5000;
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (b) => (stdout += b));
      child.stderr.on('data', (b) => (stderr += b));
      const timer = setTimeout(() => {
        if (child.pid && readProcess(child.pid)?.stamp.proc_start === stamp?.proc_start) child.kill('SIGTERM');
      }, 5000);
      try {
        const end = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res, rej) => {
          child.once('error', rej);
          child.once('close', (code, signal) => res({ code, signal }));
        });
        assert.equal(end.code, 0, JSON.stringify({ kind, stdout, stderr, end }));
        assert.ok(stdout.length > 0);
        assert.equal(child.pid ? readProcess(child.pid) : null, null);
        t.diagnostic(
          JSON.stringify({
            synthetic: true,
            kind,
            purpose: args[0] === '--input-type=module' ? 'default-verifier' : args.slice(1).join(' '),
            pid: child.pid,
            start: stamp,
            deadlineAt,
            end,
            alive: false,
          })
        );
      } finally {
        clearTimeout(timer);
      }
    }
  });

test(
  'SIMULATED native target 0.165.0 cannot borrow parent client 0.166.0',
  { timeout: 50000, skip: process.platform !== 'linux' },
  async (t) => {
    const result = await runNativeScenario(false, '0.166.0', '0.165.0');
    assert.equal(result.startup.parentObserved, true);
    assert.equal(result.dispatches, 0);
    t.diagnostic(JSON.stringify(result));
  }
);
