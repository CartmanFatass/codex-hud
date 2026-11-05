// This executable demo uses only the test fake and HUD's read-only JobRef identity projection.
import { FakeJevBrowser } from '../dist-test/tests/fakes/jev-browser.js';
const fake = new FakeJevBrowser();
const owner = 'synthetic-owner';
const first = { kind: 'jev', provider: 'synthetic-ask', account: 'synthetic-one', key: 'synthetic-question' };
const second = { kind: 'jev', provider: 'synthetic-ask', account: 'synthetic-two', key: 'synthetic-followup' };
for (const ref of [first, second])
  fake.enqueue({
    owner,
    browser: 'synthetic-browser',
    ref,
    requestId: `synthetic-id-${ref.key}`,
    requestFingerprint: `synthetic-request-${ref.key}`,
  });
const { generation } = fake.dispatch(owner, first, 'lost');
const show = (ref) => {
  const v = fake.view(owner, ref);
  console.log(
    `SIMULATED Jev ${ref.key} · ${v.fakeState} · holder ${v.holderLabel ?? 'none'} · HUD identity ${v.hudNode.loaded ? 'loaded' : 'unloaded'}`
  );
};
show(first);
show(second);
fake.observe(owner, first, generation, 'needs_human');
show(first);
fake.observe(owner, first, generation, 'answered');
fake.reconcile(owner, first, generation, 'answered', 'synthetic-answer');
show(first);
fake.dispatch(owner, second, 'received');
show(second);
console.log('SIMULATED only: no real browser, provider, account, network, or production capability.');
