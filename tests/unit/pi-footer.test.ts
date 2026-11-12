import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parityFixture } from '../fixtures/pi-footer.js';
import { HUD_STATUS_KEY } from '../../src/harness/pi/segment.js';
import { stripAnsi, visualWidth } from '../../src/render/colors.js';

function fixture(t: test.TestContext, settings?: unknown, env?: Record<string, string>) {
  const f = parityFixture({ name: 'ribbon', width: 160, settings, env });
  t.after(() => f.dispose());
  f.statuses.clear();
  return f;
}

test('editor top ribbon fits three widths, dropping whole segments from the right', (t) => {
  const f = fixture(t);
  const wide = stripAnsi(f.top(160));
  assert.match(wide, /Synthetic session title.*cache 73%.*tok 43K.*123\.4 t\/s.*TTFT 520ms.*\$0\.420.*4:02/);
  assert.ok(wide.endsWith('\ue0b0─'), 'one closing dash after the fading arrow');
  const medium = stripAnsi(f.top(80));
  assert.match(medium, /Synthetic session title.*cache 73%.*tok 43K.*123\.4 t\/s/);
  assert.doesNotMatch(medium, /\$|4:02/, 'rightmost cost and time drop first');
  assert.equal(stripAnsi(f.top(5)), '─────', 'no ribbon below its six-column minimum');
  for (const width of [0, 1, 5, 6, 7, 16, 40, 80, 160]) assert.equal(visualWidth(f.top(width)), width);
});

test('band config and commands toggle all seven fields, keeping context on the bottom', async (t) => {
  const f = fixture(t, { band: { session: false, tokens: false, cost: false } });
  assert.doesNotMatch(stripAnsi(f.top()), /Synthetic session title|tok |\$/);
  await f.controller.command('band off', f.ctx);
  assert.doesNotMatch(stripAnsi(f.top()), /\ue0b6|cache|t\/s|TTFT/);
  assert.match(stripAnsi(f.render()[0]!), /42%\/200K/);
  await f.controller.command('band on', f.ctx);
  assert.match(stripAnsi(f.top()), /Synthetic session title.*tok 43K.*\$0\.420/);
  const config = JSON.parse(readFileSync(join(f.ctx.sessionManager.getCwd(), '../../config.json'), 'utf8')).piFooter;
  assert.deepEqual(Object.keys(config.band).sort(), [
    'cache',
    'context',
    'cost',
    'session',
    'time',
    'tokens',
    'tps',
    'ttft',
  ]);
  assert.equal(config.band.context, true);
  for (const id of ['session', 'cache', 'tokens', 'tps', 'ttft', 'cost', 'time']) assert.equal(config.band[id], true);
  await f.controller.command('off context', f.ctx);
  assert.doesNotMatch(stripAnsi(f.render()[0]!), /42%/);
  await f.controller.command('on context', f.ctx);
  assert.match(stripAnsi(f.render()[0]!), /42%/);
  let listing = '';
  f.ctx.ui.notify = (text) => {
    listing = text;
  };
  await f.controller.command('list', f.ctx);
  assert.match(listing.split('\n')[0]!, /context/);
  assert.doesNotMatch(listing.split('\n')[1]!, /context/);
});

test('cost is in the ribbon only; bottom stays one shared bar with context', (t) => {
  const f = fixture(t);
  assert.match(stripAnsi(f.top()), /\$0\.420/);
  const bottom = f.render();
  assert.equal(bottom.length, 1);
  assert.match(stripAnsi(bottom[0]!), /synthetic-model.*42%\/200K.*example.*MCP 2.*skills 3/);
  assert.doesNotMatch(stripAnsi(bottom[0]!), /\$|cache |tok |t\/s|TTFT/);
});

test('other extension statuses survive at 100 columns alongside lens, MCP and skills', async (t) => {
  const f = fixture(t);
  f.ctx.model!.id = 'gemini-x';
  f.controller.update();
  f.bus.get('pi-lens/analysis-complete')?.({ filePath: 'synthetic.ts', diagnostics: [] });
  f.statuses.set('antigravity-model', 'ag gemini-x');
  f.statuses.set('antigravity-retry', 'antigravity: retry 2/5 · waiting');
  for (const key of ['mcp', 'lens', 'pi-lens', 'pi-lens-lsp', HUD_STATUS_KEY]) f.statuses.set(key, 'DUPLICATE');
  const top = stripAnsi(f.top(100));
  const bottom = stripAnsi(f.render(100)[0]!);
  assert.match(top, /ag gemini-x.*antigravity: retry 2\/5 · waiting/);
  assert.match(bottom, /lens ✓.*MCP 2.*skills 3/);
  assert.doesNotMatch(top + bottom, /DUPLICATE/);
  assert.equal(visualWidth(top), 100);
  assert.ok(visualWidth(bottom) <= 100);
  assert.match(stripAnsi(f.top(20)), /ag gemini-x/, 'statuses get the space before the ribbon');
  await f.controller.command('band off', f.ctx);
  assert.match(stripAnsi(f.top(100)), /ag gemini-x/);
  await f.controller.command('off statuses', f.ctx);
  assert.doesNotMatch(stripAnsi(f.top(100)), /ag gemini-x/);
});

test('native working indicator and scroll hint keep their places; resizing does not scan history', (t) => {
  const f = fixture(t);
  const editor = f.editor() as unknown as {
    setWorkingStatusIndicator(value: { renderInBorder(width: number): string }): void;
  };
  editor.setWorkingStatusIndicator({ renderInBorder: () => '⠋ Working…' });
  const before = f.counts();
  const top = stripAnsi(f.top(160, 8));
  assert.ok(top.startsWith('── ⠋ Working… '));
  assert.match(top, /↑ 8 more.*\ue0b6/);
  for (const width of [20, 80, 120, 160]) {
    assert.equal(visualWidth(f.top(width)), width);
    f.render(width);
  }
  assert.deepEqual(f.counts(), before);
});

test('rates come from the active branch, preserve last valid measurements, and have placeholders', (t) => {
  const f = fixture(t);
  f.ctx.sessionManager.getLeafId = () => 'new-leaf';
  f.ctx.sessionManager.getBranch = () => [
    { type: 'custom', customType: 'tps', data: { tps: 50, timing: { ttftMs: 1500 } } },
    { type: 'custom', customType: 'tps', data: { tps: null, timing: { ttftMs: null } } },
  ];
  f.controller.update();
  assert.match(stripAnsi(f.top()), /50\.0 t\/s.*TTFT 1\.5s/);
  f.ctx.sessionManager.getLeafId = () => 'empty-branch';
  f.ctx.sessionManager.getBranch = () => [];
  f.controller.update();
  assert.match(stripAnsi(f.top()), /- t\/s.*TTFT -/);
});

test('ribbon uses terminal palette transitions and respects NO_COLOR', (t) => {
  const f = fixture(t);
  const top = f.top();
  if (!process.env.NO_COLOR) {
    assert.ok(top.includes('\x1b[48;5;183m\x1b[38;5;235m Synthetic session title '));
    assert.ok(top.includes('\x1b[48;5;152m\x1b[38;5;183m\ue0b0'), 'previous foreground on next background');
    assert.ok(top.includes('\x1b[0m\x1b[38;5;187m\ue0b0\x1b[0m'), 'last arrow on terminal background');
  }
  const plain = fixture(t, undefined, { NO_COLOR: '1' });
  assert.doesNotMatch(plain.top(), /\x1b/);
  assert.match(plain.top(), /cache 73%.*123\.4 t\/s/);
});

test('stopping the footer restores both native components', (t) => {
  const f = fixture(t);
  assert.ok(f.editor());
  assert.equal(f.render().length, 1);
  f.controller.stop();
  assert.equal(f.editor(), undefined);
  assert.deepEqual(f.render(), []);
  f.controller.start(f.ctx);
  assert.match(stripAnsi(f.top()), /cache/);
});
