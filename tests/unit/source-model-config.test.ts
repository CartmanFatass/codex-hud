import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { captureSource, parseSourceModelConfig } from '../../src/core/materials/source-config.js';
import { buildMaterials, fingerprint } from '../../src/core/materials/index.js';
import { digestFixture } from '../fixtures/delegated-digest.js';

test('strict source schema rejects omission, wildcard, future field, duplicate scope and wrong full identity', async () => {
  const f = await digestFixture();
  try {
    for (const mutate of [
      (c: any) => {
        delete c.delegatedDigest.enabled;
      },
      (c: any) => {
        c.unknown = true;
      },
      (c: any) => {
        c.revision = 0;
      },
      (c: any) => {
        c.sourceId = 'b'.repeat(64);
      },
      (c: any) => {
        c.schemaVersion = 2;
      },
      (c: any) => {
        c.connection.key = 'forbidden';
      },
      (c: any) => {
        c.connection.keyEnv = null;
      },
      (c: any) => {
        c.materials.push(c.materials[0]);
      },
      (c: any) => {
        c.materials[0].ref.sessionId = '*';
      },
      (c: any) => {
        c.materials[0].ref.extra = 1;
      },
      (c: any) => {
        c.materials[0].origin = 'native';
      },
      (c: any) => {
        c.materials[0].purpose = 'brief';
      },
      (c: any) => {
        c.materials[0].fields = ['report'];
      },
      (c: any) => {
        c.materials = Array(257).fill(c.materials[0]);
      },
    ]) {
      const copy = structuredClone(f.config);
      mutate(copy);
      assert.throws(() => parseSourceModelConfig(copy, f.ref.sourceId));
    }
  } finally {
    f.cleanup();
  }
});

test('actual generic boundary exact permission matrix rejects before evaluating material', async () => {
  const f = await digestFixture();
  try {
    const source = captureSource(f.home, f.ref.sourceId, f.env, () => true);
    for (const patch of [
      { ref: { ...f.ref, sourceId: 'b'.repeat(64) } },
      { ref: { ...f.ref, threadId: 'other' } },
      { ref: { ...f.ref, harness: 'pi' as const } },
      { origin: 'native' as const },
      { field: 'report' },
      { field: 'task' },
      { kind: 'unknown' as const },
    ]) {
      let reads = 0;
      const result = buildMaterials({
        purpose: 'digest',
        resolvedRecipient: source.recipient,
        authority: source.authority,
        limits: { maxBytes: 32768 },
        subjects: [
          {
            ref: f.ref,
            origin: 'delegated',
            field: 'result',
            kind: 'public_text',
            recordFingerprint: fingerprint(['synthetic']),
            read() {
              reads++;
              return 'DENIED_SENTINEL';
            },
            ...patch,
          },
        ],
      });
      assert.ok('denied' in result);
      assert.equal(reads, 0);
    }
    let recipientReads = 0;
    const wrongRecipient = buildMaterials({
      purpose: 'digest',
      resolvedRecipient: { recipientId: '0'.repeat(64), model: 'synthetic-model' },
      authority: source.authority,
      limits: { maxBytes: 32768 },
      subjects: [
        {
          ref: f.ref,
          origin: 'delegated',
          field: 'result',
          kind: 'public_text',
          recordFingerprint: fingerprint(['synthetic']),
          read() {
            recipientReads++;
            return 'DENIED_SENTINEL';
          },
        },
      ],
    });
    assert.ok('denied' in wrongRecipient);
    assert.equal(recipientReads, 0);
    for (const purpose of ['brief', 'routing'] as const) {
      let reads = 0;
      const result = buildMaterials({
        purpose,
        resolvedRecipient: source.recipient,
        authority: source.authority,
        limits: { maxBytes: 32768 },
        subjects: [
          {
            ref: f.ref,
            origin: 'delegated',
            field: 'result',
            kind: 'public_text',
            recordFingerprint: fingerprint(['synthetic']),
            read() {
              reads++;
              return 'DENIED_SENTINEL';
            },
          },
        ],
      });
      assert.ok('denied' in result);
      assert.equal(reads, 0);
    }
    assert.equal(source.api?.model, 'synthetic-model');
    assert.equal(source.api?.key, 'synthetic-key');
    f.env.SYNTHETIC_DIGEST_KEY = 'changed';
    assert.equal(source.current(), false);
    f.env.SYNTHETIC_DIGEST_KEY = 'synthetic-key';
    assert.equal(source.current(), false);
  } finally {
    f.cleanup();
  }
});

for (const mutation of [
  'missing',
  'corrupt',
  'oversize',
  'public-file',
  'symlink',
  'hardlink',
  'public-dir',
  'symlink-dir',
]) {
  test(`source private read fails closed without repair: ${mutation}`, async () => {
    const f = await digestFixture();
    const file = join(f.dir, 'model.json');
    try {
      if (mutation === 'missing') fs.unlinkSync(file);
      if (mutation === 'corrupt') fs.writeFileSync(file, '{');
      if (mutation === 'oversize') fs.writeFileSync(file, ' '.repeat(65537));
      if (mutation === 'public-file') fs.chmodSync(file, 0o644);
      if (mutation === 'symlink') {
        fs.renameSync(file, file + '.original');
        fs.symlinkSync(file + '.original', file);
      }
      if (mutation === 'hardlink') fs.linkSync(file, file + '.link');
      if (mutation === 'public-dir') fs.chmodSync(f.dir, 0o755);
      if (mutation === 'symlink-dir') {
        fs.renameSync(f.dir, f.dir + '.original');
        fs.symlinkSync(f.dir + '.original', f.dir);
      }
      assert.throws(() => captureSource(f.home, f.ref.sourceId, f.env, () => true));
      assert.equal(fs.existsSync(join(f.dir, 'model-runtime-v1')), false);
    } finally {
      f.cleanup();
    }
  });
}

test('same-source scope and outbound edits latch invalidation; explicit accountless is separate', async () => {
  const f = await digestFixture();
  try {
    const source = captureSource(f.home, f.ref.sourceId, f.env, () => true);
    f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
    assert.equal(source.current(), false);
    f.write('outbound.json', f.policy);
    assert.equal(source.current(), false);
    const second = captureSource(f.home, f.ref.sourceId, f.env, () => true);
    f.write('model.json', { ...f.config, materials: [] });
    assert.equal(second.current(), false);
    f.write('model.json', f.config);
    assert.equal(second.current(), false);
    delete f.env.SYNTHETIC_DIGEST_KEY;
    assert.throws(() => captureSource(f.home, f.ref.sourceId, f.env, () => true), /credential_unavailable/);
    f.write('model.json', {
      ...f.config,
      connection: { ...f.config.connection, keyEnv: null, account: 'accountless' },
    });
    const accountless = captureSource(f.home, f.ref.sourceId, f.env, () => true);
    assert.equal(accountless.api?.key, '');
    assert.notEqual(accountless.recipient?.recipientId, f.recipient.recipientId);
    assert.equal(accountless.readiness(f.ref), 'outbound_denied');
  } finally {
    f.cleanup();
  }
});

test('language is an exact string enum, never a coerced JSON value', async () => {
  const f = await digestFixture();
  try {
    for (const language of [
      ['en'],
      ['zh'],
      [],
      ['en', 'zh'],
      null,
      true,
      false,
      0,
      1,
      {},
      { language: 'en' },
      'EN',
      '',
    ]) {
      const config = { ...f.config, delegatedDigest: { ...f.config.delegatedDigest, language } };
      assert.throws(() => parseSourceModelConfig(config, f.ref.sourceId), /source_configuration_invalid/);
    }
    for (const language of ['en', 'zh'] as const) {
      const config = { ...f.config, delegatedDigest: { ...f.config.delegatedDigest, language } };
      assert.equal(parseSourceModelConfig(config, f.ref.sourceId).delegatedDigest.language, language);
    }
  } finally {
    f.cleanup();
  }
});
