import assert from 'node:assert/strict';
import { test } from 'node:test';

import { maskAccount, maskLabel, publicResult } from '../../src/jev/ask/mask.js';

test('labels and account fragments match the Python masks', () => {
  assert.equal(maskLabel(null), null);
  assert.equal(maskLabel(undefined), null);
  assert.equal(maskLabel(''), '');
  assert.equal(maskLabel('review-v2'), 'review-v2');
  assert.equal(maskLabel('person@example.com'), '<account>');

  assert.equal(maskAccount('person@example.com'), '<account>');
  assert.equal(maskAccount('see person@example.com now'), 'see <account> now');
  assert.equal(maskAccount('a@b.c, d@e.f'), '<account>, <account>');
  assert.equal(maskAccount('(@hidden@example.com)'), '(<account>)');
  assert.equal(maskAccount('a@b@c'), '<account>');
  assert.equal(maskAccount('a@b,c'), '<account>,c');
  assert.equal(maskAccount('left\u0085person@example.com'), 'left\u0085<account>');
  assert.equal(maskAccount('left\ufeffperson@example.com'), '<account>');
  assert.deepEqual(maskAccount(['keep', 'person@example.com']), ['keep', '<account>']);
  assert.deepEqual(maskAccount({ name: 'person@example.com', n: 1 }), { name: '<account>', n: 1 });
});

test('public results hide addresses unless show-url is set', () => {
  const url = 'https://example.invalid/c/synthetic';
  const hidden = publicResult({ conversation_url: url, account: 'person@example.com', steps: 2 }, false) as Record<
    string,
    unknown
  >;
  assert.equal(hidden.conversation_url, 'recorded locally');
  assert.equal(hidden.account, '<account>');
  assert.equal(hidden.steps, 2);
  assert.equal(JSON.stringify(hidden).includes('example.invalid'), false);
  assert.equal(JSON.stringify(hidden).includes('person@example.com'), false);

  const shown = publicResult({ conversation_url: url, account: 'person@example.com' }, true) as Record<string, unknown>;
  assert.equal(shown.conversation_url, url);
  assert.equal(shown.account, '<account>');

  assert.equal(
    (publicResult({ sidebar_before: ['digest'] }, false) as Record<string, unknown>).sidebar_before,
    'recorded locally'
  );
  assert.equal((publicResult({ sidebar_before: '' }, false) as Record<string, unknown>).sidebar_before, '');
  assert.deepEqual((publicResult({ sidebar_before: [] }, false) as Record<string, unknown>).sidebar_before, []);
  assert.equal(publicResult('see person@example.com', false), 'see <account>');
});
