import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parityFixture, FOOTER_NOW, type ParityRow } from '../fixtures/pi-footer.js';
const parity = JSON.parse(readFileSync(resolve('tests/fixtures/pi-footer-parity/goldens.json'), 'utf8')) as {
  owner: unknown;
  cases: ParityRow[];
};
for (const row of parity.cases) {
  test(`p10k parity: ${row.name}`, (t) => {
    t.mock.method(Date, 'now', () => FOOTER_NOW);
    const f = parityFixture(row, parity.owner);
    t.after(() => f.dispose());
    assert.deepEqual(f.render(), row.lines, 'ANSI bytes match the original p10k renderer');
    const captured = f.counts();
    f.ctx.sessionManager.getEntries = () => {
      throw Error('history_on_paint');
    };
    f.ctx.sessionManager.getBranch = () => {
      throw Error('branch_on_paint');
    };
    for (const width of [row.width, 80, 160, 32]) f.render(width);
    assert.deepEqual(f.counts(), captured, 'repaint/resize neither traverses history nor launches git');
    if (row.delegation === 'complete' || row.delegation === 'partial') {
      assert.match(f.render().join('\n'), row.delegation === 'partial' ? /Work \(partial\)/ : /Work:/);
      f.publish('unavailable');
      assert.ok(!f.render().join('\n').includes('Work'), 'no retained counts on unavailable refresh');
      assert.ok(!f.statuses.has('hud-delegation'));
    }
  });
}

test('p10k options persist only the HUD config section; lifecycle disposes listeners and restores native UI', async (t) => {
  t.mock.method(Date, 'now', () => FOOTER_NOW);
  const f = parityFixture({ name: 'options', width: 240 }, parity.owner);
  t.after(() => f.dispose());
  await f.controller.command('off path', f.ctx);
  assert.ok(!f.render().join('\n').includes('projects/example'));
  await f.controller.command('on path', f.ctx);
  assert.match(f.render().join('\n'), /projects\/example/);
  await f.controller.command('band off', f.ctx);
  assert.ok(!f.render()[0].includes('\ue0b6'));
  await f.controller.command('reset', f.ctx);
  assert.ok(f.render()[0].includes('\ue0b6'));
  assert.equal(f.bus.size, 3);
  f.controller.stop();
  assert.deepEqual(f.render(), []);
  f.controller.start(f.ctx);
  assert.match(f.render().join('\n'), /Synthetic Model/);
  f.controller.dispose();
  assert.equal(f.bus.size, 0);
});
