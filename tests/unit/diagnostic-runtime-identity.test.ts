import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { captureRuntimeIdentity, sanitizeRuntimeIdentity } from '../../src/diagnostics/runtime-identity.js';
import { createDiagnosticExportPreview } from '../../src/diagnostics/diagnostic-export.js';

const nowMs = Date.parse('2026-10-25T12:00:00Z');
const SECRET = 'SYNTHETIC_RUNTIME_SECRET';

test('startup receipt retains the first entry hash after files are replaced and contains no source path or text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hud-runtime-${SECRET}-`));
  const entry = path.join(dir, 'entry.js'); const manifest = path.join(dir, 'package.json');
  try {
    fs.writeFileSync(entry, `// ${SECRET} original startup bytes\n`);
    fs.writeFileSync(manifest, JSON.stringify({ version: '1.2.3-preview.4+local', key: SECRET, endpoint: `https://invalid/${SECRET}` }));
    const hash = createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
    const identity = captureRuntimeIdentity({ entryFile: pathToFileURL(entry).href, packageFile: manifest, nowMs });
    assert.ok(Object.isFrozen(identity)); assert.equal(identity.entrySha256, hash);
    assert.equal(identity.appVersion, '1.2.3-preview.4+local'); assert.equal(identity.scope, 'entry-file-at-start');
    assert.equal(identity.nodeVersion, process.versions.node); assert.equal(identity.platform, process.platform);
    assert.equal(identity.capturedAt, '2026-10-25T12:00:00.000Z');
    fs.writeFileSync(entry, 'synthetic replacement bytes'); fs.writeFileSync(manifest, '{"version":"9.9.9"}');
    const preview = createDiagnosticExportPreview({ nowMs: nowMs + 5000, runtimeIdentity: identity });
    assert.equal(JSON.parse(preview.json).runtimeIdentity.entrySha256, hash);
    assert.equal(JSON.parse(preview.json).runtimeIdentity.appVersion, '1.2.3-preview.4+local');
    assert.ok(!preview.json.includes(SECRET)); assert.ok(!preview.json.includes(dir));
    assert.ok(!preview.json.includes('replacement bytes')); assert.ok(!preview.json.includes('startup bytes'));
    assert.ok(!('pid' in JSON.parse(preview.json).runtimeIdentity));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runtime identity whitelists versions, platform, hash and time and leaves unavailable values null', () => {
  const unknown = sanitizeRuntimeIdentity(undefined);
  assert.deepEqual(unknown, { scope: 'entry-file-at-start', appVersion: null, nodeVersion: null,
    platform: null, entrySha256: null, capturedAt: null });
  const injected = sanitizeRuntimeIdentity({ scope: SECRET, appVersion: SECRET, nodeVersion: `${SECRET}/v1.2.3`, platform: SECRET,
    entrySha256: `https://invalid/${SECRET}`, capturedAt: `2026-10-25T12:00:00.000Z?token=${SECRET}`, nested: { key: SECRET } });
  assert.deepEqual(injected, unknown);
  const preview = createDiagnosticExportPreview({ nowMs, runtimeIdentity: injected });
  assert.ok(!preview.json.includes(SECRET));
  const missing = captureRuntimeIdentity({ entryFile: '/synthetic-missing-entry', packageFile: '/synthetic-missing-package', nowMs });
  assert.equal(missing.appVersion, null); assert.equal(missing.entrySha256, null);
});
