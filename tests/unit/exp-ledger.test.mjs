import { withState } from '../fixtures/state-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendExpEvent, readExpBalance } from '../../dist/collectors/exp-ledger.js';
import { readExpData, readExpGrantBalance, saveExpEdit } from '../../dist/collectors/exp-store.js';
import { expCycle } from '../../dist/exp-cycle.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

const account = 'openai-api';
const now = '2026-11-20T10:30:00.000Z';
const readOpenAiBalance = (home, at) => readExpGrantBalance(home, account, at);
function fixture(t, account = 'openai-api') {
  const root = fs.mkdtempSync(join(tmpdir(), 'exp-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const hud = join(root, 'hud');
  const exp = join(hud, 'exp');
  const edit = (field, value, at = now) => saveExpEdit(hud, { field, account, value }, Date.parse(at));
  edit('grant', 20_000_000);
  edit('zone', 'UTC');
  edit('grant-enabled', true);
  return { home, hud, exp, edit, path: join(exp, `ledger-${account}.jsonl`) };
}
const cost = (id, at, costMicros = 650_000) => ({
  type: 'cost',
  id,
  at,
  model: 'synthetic-oapi',
  tokens: { input: 4, output: 3, cacheRead: 2, cacheWrite: 1 },
  ...(costMicros === null ? { source: 'unpriced', costMicros } : { source: 'priced', costMicros }),
});

test('balance dedups, uses completion time against the latest calibration, keeps cycle costs and displays in 40 columns', async (t) => {
  const f = fixture(t);
  const read = () => readOpenAiBalance(f.hud, Date.parse('2026-11-20T11:00:00Z'));
  assert.equal(read().remainingMicros, null, 'first enable mid-cycle requires calibration');
  await f.edit('calibration', 13_400_000);
  const append = (event) => appendExpEvent(f.hud, account, event);
  const newer = cost('vendor-a', '2026-11-20T10:31:00.000Z');
  await append(newer);
  fs.appendFileSync(f.path, JSON.stringify(newer) + '\n'); // History from before writer-side dedup.
  const legacy = fs.readFileSync(f.path, 'utf8');
  await append(newer);
  assert.equal(fs.readFileSync(f.path, 'utf8'), legacy, 'replay does not add or rewrite a legacy line');
  const first = read();
  assert.equal(first.remainingMicros, 12_750_000);
  assert.equal(read(), first, 'unchanged ledger reuses its small snapshot');
  await append(cost('late', '2026-11-20T10:29:00.000Z', 100_000));
  await append(cost('at-calibration', now, 25_000));
  await append(cost('unknown', '2026-11-20T10:31:00.000Z', null));
  await append(cost('older-cycle', '2026-10-20T10:31:00.000Z', 3_000_000));
  assert.deepEqual(read(), {
    startDate: '2026-11-01',
    endDate: '2026-12-01',
    timeZone: 'UTC',
    remainingMicros: 12_750_000,
    billedMicros: 775_000,
    unpriced: 1,
    lastCalibration: { at: now, remainingMicros: 13_400_000 },
  });
  const data = readExpData(f.hud, { HOME: f.home }, Date.parse('2026-11-20T11:00:00Z'));
  const tree = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(0) };
  const old = setLanguage('en');
  t.after(() => setLanguage(old));
  for (const lang of ['en', 'zh'])
    for (const panelLayout of ['classic', 'split']) {
      setLanguage(lang);
      const state = withState(initialMonitorState(), { activeTab: 'exp', prefs: { panelLayout, experiments: true }, exp: { detail: account, cursor: 'calibration', scroll: 0 } });
      const frame = renderMonitor({ state, tree, expData: data, width: 40, height: 24, nowMs: Date.parse(now) });
      for (const line of frame.lines) assert.equal(visualLength(line), 40, stripAnsi(line));
      const rows = frame.lines.map((line) => stripAnsi(line).trimEnd()).join('\n');
      assert.match(rows, lang === 'en' ? /Estimated remaining\s+≈\$12\.75/ : /估算剩余\s+≈\$12\.75/);
      assert.match(rows, /2026-11-01 → 2026-12-01 · UTC/);
      assert.match(rows, lang === 'en' ? /Billed this period\s+\$0\.775/ : /本期已计费用\s+\$0\.775/);
      assert.match(rows, lang === 'en' ? /Unpriced requests\s+1/ : /未计价请求数\s+1/);
      assert.match(rows, /2026-11-20 10:30 UTC · \$13\.40/);
      if (process.env.EXP_EXAMPLES && lang === 'en' && panelLayout === 'classic') t.diagnostic(rows);
    }
  await f.edit('calibration', 1_000_000, '2026-11-20T10:45:00Z');
  await f.edit('calibration', 2_000_000, '2026-11-20T10:45:00Z');
  assert.equal(read().remainingMicros, 2_000_000, 'latest calibration wins ties in append order');
  assert.equal(read().billedMicros, 775_000, 'calibration never rewrites cycle totals');
});

test('29–31 renew at short month end in their own time zone, reset without carry-over, and apply future terms at renewal', async (t) => {
  for (const renewalDay of [29, 30, 31]) {
    const cycle = (at) => expCycle({ renewalDay, timeZone: 'America/New_York' }, Date.parse(at));
    assert.equal(cycle('2027-02-28T04:59:59.999Z').end, Date.parse('2027-02-28T05:00:00Z'));
    const feb = cycle('2027-02-28T05:00:00Z');
    assert.equal(feb.startDate, '2027-02-28');
    assert.equal(feb.end, Date.parse(`2027-03-${renewalDay}T04:00:00Z`));
  }
  assert.equal(
    expCycle({ renewalDay: 30, timeZone: 'Pacific/Apia' }, Date.parse('2011-12-30T10:00:00Z')).start,
    Date.parse('2011-12-30T10:00:00Z'),
    'a skipped civil date renews at the first representable instant'
  );
  assert.equal(
    expCycle({ renewalDay: 1, timeZone: 'America/St_Johns' }, Date.parse('2009-11-01T02:45:00Z')).start,
    Date.parse('2009-11-01T02:30:00Z'),
    'rolling back to the previous date after midnight does not reopen the prior cycle'
  );
  for (const account of ['openai-api', 'anthropic-api']) {
    const f = fixture(t, account);
    const balance = (iso) => readExpGrantBalance(f.hud, account, Date.parse(iso));
    assert.equal(balance(now).remainingMicros, null, 'first enable is uncalibrated');
    await f.edit('calibration', 13_400_000);
    f.edit('grant', 25_000_000);
    f.edit('renewal', 31);
    f.edit('zone', 'America/New_York');
    await appendExpEvent(f.hud, account, cost('pre-renewal', '2026-11-30T23:59:59.999Z'));
    await appendExpEvent(f.hud, account, cost('at-renewal', '2026-12-01T00:00:00.000Z'));
    assert.equal(balance('2026-11-30T23:59:59.999Z').remainingMicros, 12_750_000);
    assert.equal(balance('2026-11-30T23:59:59.999Z').timeZone, 'UTC');
    assert.equal(balance('2026-12-01T00:00:00Z').remainingMicros, 24_350_000);
    assert.equal(balance('2026-12-01T00:00:00Z').timeZone, 'America/New_York');
    assert.equal(balance('2027-03-01T00:00:00Z').remainingMicros, 25_000_000);
    assert.equal(balance('2027-03-01T00:00:00Z').lastCalibration.at, now);
  }
});

test('four concurrent JSONL writers persist one intact line per ID and double-count no request', async (t) => {
  const f = fixture(t);
  await f.edit('calibration', 13_400_000);
  const at = '2026-11-20T10:31:00.000Z';
  const record = cost('example', at, 10_000);
  const url = new URL('../../dist/collectors/exp-ledger.js', import.meta.url).href;
  await Promise.all(
    Array.from({ length: 4 }, (_, writer) =>
      promisify(execFile)(process.execPath, [
        '--input-type=module',
        '-e',
        `import { appendExpEvent } from ${JSON.stringify(url)};
      const record = ${JSON.stringify(record)};
      for (let i = 0; i < 75; i++) {
        await appendExpEvent(process.argv[1], 'openai-api', { ...record, id: 'shared-' + i });
        await appendExpEvent(process.argv[1], 'openai-api', { ...record, id: process.argv[2] + '-' + i });
      }`,
        f.hud,
        String(writer),
      ])
    )
  );
  const lines = fs.readFileSync(f.path, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(lines.length, 376);
  assert.equal(new Set(lines.map(({ id }) => id)).size, lines.length);
  for (const line of lines.slice(1)) assert.equal(line.costMicros, 10_000);
  assert.equal(readOpenAiBalance(f.hud, Date.parse(at)).remainingMicros, 9_650_000);
  assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.exp).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(join(f.exp, 'ledger-anthropic-api.jsonl')), false);
  assert.equal(
    readExpBalance(
      f.hud,
      'anthropic-api',
      { enabled: true, grantMicros: 0, renewalDay: 1, timeZone: 'UTC' },
      Date.parse(at)
    ).billedMicros,
    0
  );
});
