import test from 'node:test';
import assert from 'node:assert/strict';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { stripAnsi, visualWidth } from '../../src/render/colors.js';
import { parityFixture, FOOTER_NOW } from '../fixtures/pi-footer.js';

test('pi footer: one line at 120 columns, in the Codex bar grammar (shared order and separators)', (t) => {
  t.mock.method(Date, 'now', () => FOOTER_NOW);
  const previous = setDisplayConfig({ theme: 'none' });
  t.after(() => setDisplayConfig(previous));
  const f = parityFixture({ name: 'main', width: 120, delegation: 'complete' });
  t.after(() => f.dispose());
  const rows = f.render();
  assert.equal(rows.length, 1, 'the footer is exactly one row');
  assert.ok(visualWidth(rows[0]) <= 120, 'and fits the width');
  assert.match(
    stripAnsi(rows[0]),
    /^Synthetic Model high │ ━+─* 42%\/200K │ example synthetic-main \+1 \*1 \?1 │ 123 tok\/s │ \$0\.420 │ Work: 2 needs you$/
  );
  // With room, every segment comes in the shared order: the leading cluster, then the right cluster at the last column.
  assert.match(
    stripAnsi(f.render(240)[0]),
    /^Synthetic Model high │ ━+─* 42%\/200K │ example synthetic-main \+1 \*1 \?1 │ 123 tok\/s │ cache 73% │ ttft 520ms │ \$0\.420 │ active 4:02 │ Work: 2 needs you · 3 running │ other status {3,}Tokens 43K {2}Synthetic session title$/
  );
  // History and git are read on lifecycle events only; repainting and resizing launch neither.
  const captured = f.counts();
  f.ctx.sessionManager.getEntries = f.ctx.sessionManager.getBranch = () => {
    throw Error('history_on_paint');
  };
  for (const width of [40, 80, 160]) assert.equal(f.render(width).length, 1);
  assert.deepEqual(f.counts(), captured);
  // A narrow pane drops whole segments, lowest priority first; it never wraps or cuts a word.
  const narrow = stripAnsi(f.render(60)[0]);
  assert.ok(visualWidth(narrow) <= 60 && narrow.startsWith('Synthetic Model'), narrow);
  f.publish('unavailable');
  assert.ok(!f.render().join('').includes('Work'), 'no retained counts once the jobs are gone');
});

test('pi footer options persist only the HUD config section; lifecycle disposes listeners and restores the native footer', async (t) => {
  t.mock.method(Date, 'now', () => FOOTER_NOW);
  const f = parityFixture({ name: 'options', width: 240 });
  t.after(() => f.dispose());
  await f.controller.command('off path', f.ctx);
  assert.ok(!f.render().join('\n').includes('example'));
  await f.controller.command('on path', f.ctx);
  assert.match(f.render().join('\n'), /example/);
  await f.controller.command('band off', f.ctx);
  assert.ok(!f.render().join('\n').includes('cache'));
  await f.controller.command('reset', f.ctx);
  assert.match(f.render().join('\n'), /cache/);
  assert.equal(f.bus.size, 3);
  f.controller.stop();
  assert.deepEqual(f.render(), []);
  f.controller.start(f.ctx);
  assert.match(f.render().join('\n'), /Synthetic Model/);
  f.controller.dispose();
  assert.equal(f.bus.size, 0);
});
