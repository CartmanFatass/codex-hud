/**
 * A model's reply in another language than asked is a failure, never cached
 * and never shown as if it obeyed: Japanese for Chinese, Chinese for
 * English, English for Chinese. Quoting a name or a short line passes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrongLanguage, replyWords } from '../../src/collectors/reply-language.js';
import { SmallModel, type ModelApi } from '../../src/collectors/small-model.js';

test('the language test: by share, on the words a person reads', () => {
  // Chinese asked.
  assert.equal(wrongLanguage('{"conclusion":"缓存竞争已定位","basis":"读了 cache.ts","caveats":"未运行"}', 'zh'), false);
  assert.equal(wrongLanguage('{"conclusion":"キャッシュの競合を特定しました","basis":"cache.ts を読みました"}', 'zh'), true, 'Japanese');
  assert.equal(wrongLanguage('最新の変更をプルして再ビルドします。', 'zh'), true, 'plain Japanese prose');
  assert.equal(wrongLanguage('{"summary":"The cache race was found in the loader and fixed"}', 'zh'), true, 'English for Chinese');
  assert.equal(wrongLanguage('已更新日文 README 的标题「HUD に何が表示される？」，其余内容不变，测试全部通过。', 'zh'), false, 'a short Japanese quote');
  assert.equal(wrongLanguage('{"items":[{"agent":"パーサー修正","note":"正在重写恢复路径并补充测试"}]}', 'zh'), false, 'an echoed Japanese agent name is not its words');
  assert.equal(wrongLanguage('{"label":""}', 'zh'), false, 'nothing to judge');
  assert.equal(wrongLanguage('通过 `npm test`', 'zh'), false);
  // English asked.
  assert.equal(wrongLanguage('{"summary":"Rewrote the recovery path and added tests."}', 'en'), false);
  assert.equal(wrongLanguage('{"summary":"重写了恢复路径并补充了测试"}', 'en'), true, 'Chinese for English');
  assert.equal(wrongLanguage('{"summary":"キャッシュの競合を特定しました"}', 'en'), true, 'Japanese for English');
  assert.equal(wrongLanguage('Renamed the 布局修复 card and reran the whole suite; all green.', 'en'), false, 'a Chinese name in English');
  assert.equal(wrongLanguage('{"items":[{"agent":"布局修复 0","note":"Fixing the layout"}]}', 'en'), false);
  // Code, paths and URLs are not words; fenced JSON is read.
  assert.equal(replyWords('```json\n{"note":"已完成"}\n```').trim(), '已完成');
  assert.equal(replyWords('see docs/ja/README.ja.md and https://example.invalid/パス').replace(/\s+/g, ' ').trim(), 'see and');
});

const api: ModelApi = { base: 'http://synthetic.invalid/v1', model: '', key: '' };
const reply = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));

test('a reply in another language fails as an invalid response, is not cached, and a cached one is dropped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-reply-language-'));
  try {
    let answer = '{"note":"キャッシュの競合を特定しました"}';
    let calls = 0;
    const fetcher = (async () => { calls++; return reply(answer); }) as typeof fetch;
    const model = new SmallModel({ dir, env: {}, fetch: fetcher });
    model.configure({ backend: 'api', api, hourlyCap: 100 });
    const request = { feature: 'progress', system: 's', prompt: 'p', cacheKey: 'synthetic', language: 'zh' as const };
    const wrong = await model.submit(request).result;
    assert.ok(!wrong.ok && wrong.classification === 'invalid-response' && /panel language/.test(wrong.error), JSON.stringify(wrong));
    assert.equal(model.diagnostics().lastFailure?.classification, 'invalid-response');
    // Not cached: the next ask calls again, and a reply in Chinese lands.
    answer = '{"note":"已定位缓存竞争"}';
    assert.deepEqual(await model.submit(request).result, { ok: true, text: answer });
    assert.equal(calls, 2);
    assert.deepEqual(await model.submit(request).result, { ok: true, text: answer, cached: true });
    // No language named: the old behaviour, whatever comes back.
    answer = '{"note":"キャッシュ"}';
    assert.equal((await model.submit({ feature: 'probe', system: 's', prompt: 'other' }).result).ok, true);
    // An answer cached before the check, in the wrong language, is dropped and asked again.
    const cacheFile = path.join(dir, 'cache.json');
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Record<string, { text: string; at: number }>;
    for (const entry of Object.values(cached)) entry.text = '{"note":"最新の変更をプルしました"}';
    fs.writeFileSync(cacheFile, JSON.stringify(cached), { mode: 0o600 });
    answer = '{"note":"已拉取最新改动"}';
    const restarted = new SmallModel({ dir, env: {}, fetch: fetcher });
    restarted.configure({ backend: 'api', api, hourlyCap: 100 });
    const before = calls;
    assert.deepEqual(await restarted.submit(request).result, { ok: true, text: answer }, 'asked afresh');
    assert.equal(calls, before + 1);
    assert.deepEqual(await restarted.submit(request).result, { ok: true, text: answer, cached: true }, 'and the good answer is the one kept');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
