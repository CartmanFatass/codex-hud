import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SmallModel, modelHttpRequest } from '../../src/collectors/small-model.js';
import { resolveRecipient } from '../../src/core/materials/recipient.js';
import { defaultSettings } from '../../src/settings.js';
import { renderSettingsPage, SETTING_ROWS } from '../../src/render/settings-page.js';
import { stripAnsi } from '../../src/render/colors.js';
const api = { base: 'https://api.mistral.ai/v1', model: 'synthetic-model' };
const request = { feature: 'job_card', system: '', prompt: '' };
function make(env: NodeJS.ProcessEnv, account?: string) {
  const model = new SmallModel({
    dir: null,
    env,
    account,
    fetch: async () => {
      throw new Error('no provider call permitted');
    },
  });
  model.configure({ backend: 'api', api });
  return model;
}
test('P3b recipient selection is nonsecret, changes with origin/name/source, not key value across restart', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p3b-recipient-'));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const secret = 'synthetic-secret-never-log';
  const env = { HOME: home, HUD_HOME: home, MISTRAL_API_KEY: secret };
  const model = make(env);
  t.after(() => model.cancelAll());
  const recipient = model.jobCardRecipient()!;
  assert.ok(recipient);
  assert.deepEqual(Object.keys(recipient).sort(), ['model', 'recipientId']);
  assert.deepEqual(
    recipient,
    resolveRecipient(
      { backend: 'api', endpoint: api.base + '/chat/completions', model: api.model },
      'https://api.mistral.ai · MISTRAL_API_KEY from environment'
    )
  );
  assert.equal(
    model.jobCardRecipientLabel(),
    'https://api.mistral.ai · MISTRAL_API_KEY from environment · synthetic-model'
  );
  env.MISTRAL_API_KEY = 'synthetic-rotated-secret';
  assert.equal(model.jobCardRecipient(), null, 'live credential baseline fences rotation');
  assert.deepEqual(
    make(env).jobCardRecipient(),
    recipient,
    'restart rotation is the same explicit key selection, never secret-derived'
  );
  const file = path.join(home, 'credentials.env');
  fs.writeFileSync(file, `MISTRAL_API_KEY=${secret}\nOPENAI_API_KEY=${secret}\n`, { mode: 0o600 });
  const fromFile = make({ HOME: home, HUD_HOME: home });
  assert.notEqual(fromFile.jobCardRecipient()?.recipientId, recipient.recipientId);
  assert.match(fromFile.jobCardRecipientLabel()!, /MISTRAL_API_KEY from credentials.env/);
  const openai = make({ HOME: home, HUD_HOME: home, OPENAI_API_KEY: secret });
  openai.configure({ backend: 'api', api: { ...api, base: 'https://api.openai.com/v1' } });
  assert.notEqual(openai.jobCardRecipient()?.recipientId, recipient.recipientId);
  const noKey = make({ HOME: home, HUD_HOME: path.join(home, 'empty') });
  assert.ok(noKey.jobCardRecipient());
  assert.match(noKey.jobCardRecipientLabel()!, /accountless/);
  assert.notEqual(noKey.jobCardRecipient()?.recipientId, recipient.recipientId);
  const state = {
    draft: defaultSettings(),
    selected: SETTING_ROWS.findIndex((r) => r.key === 'jobMaterialConsent'),
    offset: 0,
    message: '',
    jobConsent: 'granted' as const,
    jobRecipient: model.jobCardRecipientLabel() ?? fromFile.jobCardRecipientLabel()!,
  };
  const frame = renderSettingsPage(state, 110, 30).lines.map(stripAnsi).join('\n');
  assert.ok(!frame.includes(secret));
  assert.ok(!frame.includes(recipient.recipientId));
  assert.match(frame, /credentials.env/);
  model.configure({ backend: 'off' });
  assert.equal(model.jobCardRecipient(), null);
});
test('P3b explicit account resolver and ordinary modelHttpRequest bytes retain original semantics', () => {
  const env = { MISTRAL_API_KEY: 'synthetic-explicit-key' };
  const recipient = make(env, 'explicit-account').jobCardRecipient();
  assert.deepEqual(
    recipient,
    resolveRecipient({ backend: 'api', endpoint: api.base + '/chat/completions', model: api.model }, 'explicit-account')
  );
  const ordinary = modelHttpRequest(api, { ...request, feature: 'brief' }, env);
  assert.ok(!('error' in ordinary));
  assert.deepEqual(Object.keys(ordinary).sort(), ['body', 'headers', 'model', 'url']);
  const job = modelHttpRequest(api, request, env);
  assert.ok(!('error' in job));
  const { accountSelection, ...transport } = job;
  assert.equal(accountSelection, 'https://api.mistral.ai · MISTRAL_API_KEY from environment');
  assert.equal(ordinary.url, transport.url);
  assert.deepEqual(ordinary.headers, transport.headers);
  assert.equal(ordinary.body, transport.body);
});
