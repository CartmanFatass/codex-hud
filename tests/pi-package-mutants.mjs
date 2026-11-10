/** Disposable emitted-module negative controls. Never mutates the working tree. */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const dir = fs.mkdtempSync(join(tmpdir(), 'hud-a5-mutants-'));
const variants = [
  [
    'stale-result-adoption',
    'harness/pi/package-entry.js',
    (s) =>
      s.replace(
        'const receipt = result.receipt;',
        'const receipt = result.receipt; if (receipt) s.generation = receipt.generation;'
      ),
    'queued old closes',
  ],
  [
    'tree-without-live-proof',
    'harness/pi/package-entry.js',
    (s) => s.replace('marker?.confirmed === true', 'marker !== undefined'),
    'tree continuity pane-closed',
  ],
  [
    'tree-ignores-auto-off',
    'harness/pi/package-entry.js',
    (s) => s.replace(/&&\s*autoOpenEnabled\(env\)/g, '&& true'),
    'tree continuity auto-off',
  ],
  [
    'footer-ownership',
    'harness/pi/package-entry.js',
    (s) =>
      s.replace(
        'const env =',
        "pi.on('session_start', (_e, ctx) => { ctx.ui.setFooter(undefined); });\n    const env ="
      ),
    'REAL package entry',
  ],
  [
    'all-status-cleanup',
    'harness/pi/segment.js',
    (s) => s.replace('old.ctx.ui.setStatus(HUD_STATUS_KEY, undefined)', "old.ctx.ui.setStatus('other', undefined)"),
    'REAL package entry',
  ],
  [
    'wrong-root-cache',
    'harness/pi/segment.js',
    (s) => s.replace('state.root,', "'another-source/another-session',"),
    'exact-root refresh',
  ],
  [
    'non-tui-timer',
    'harness/pi/segment.js',
    (s) =>
      s
        .replace('if (!isPiTui(ctx))', 'if (false)')
        .replace('if (!isPiTui(state.ctx) || !state.isCurrent())', 'if (!state.isCurrent())'),
    'print:|rpc:',
  ],
  [
    'unfenced-panel-close',
    'harness/pi/package-entry.js',
    (s) =>
      s
        .replace('import { displayTarget } from', 'import { displayTarget, PanelStore, panelKey } from')
        .replace(
          'generation: s.generation,',
          'generation: new PanelStore(env).read(panelKey(captured.context))?.generation,'
        ),
    'old-generation shutdown refuses',
  ],
  [
    'model-routed-command',
    'harness/pi/package-entry.js',
    (s) => s.replace('async handler(args, ctx) {', "async handler(args, ctx) { pi.sendUserMessage('/hud ' + args);"),
    'REAL package entry',
  ],
];
try {
  for (const [name, file, change, pattern] of variants) {
    const out = join(dir, name);
    fs.cpSync(resolve('dist'), out, { recursive: true });
    fs.writeFileSync(join(out, 'package.json'), '{"type":"module"}');
    fs.symlinkSync(resolve('node_modules'), join(out, 'node_modules'), 'dir');
    const source = fs.readFileSync(join(out, file), 'utf8'),
      mutated = change(source);
    assert.notEqual(mutated, source, 'mutation anchor ' + name);
    fs.writeFileSync(join(out, file), mutated);
    const r = spawnSync(
      process.execPath,
      ['--test', '--test-name-pattern', pattern, resolve('tests/unit/pi-package.test.mjs')],
      { env: { ...process.env, R6A_PI_EMITTED_ROOT: out }, encoding: 'utf8', timeout: 120000 }
    );
    assert.notEqual(r.status, 0, 'SURVIVED ' + name + '\n' + r.stdout + r.stderr);
    assert.ok(
      r.stdout.includes('AssertionError') || r.stdout.includes('provider_path_forbidden'),
      'not an assertion failure: ' + name + '\n' + r.stdout + r.stderr
    );
    console.log('KILLED ' + name);
  }
  console.log(`${variants.length}/${variants.length} mutants killed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
