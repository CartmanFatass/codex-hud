import test from 'node:test';
import assert from 'node:assert/strict';
import { assessResidue } from '../integration/r6a-claude-probe.mjs';
test('observed native write set: exact orphan cache receipt only; no changed, added, missing, linked or registered residue', () => {
  const prefix = '.claude/plugins/cache/hud-rehearsal/hud/0.1.0';
  const installed = {
    [prefix]: { mode: 0o755, hash: 'directory' },
    [prefix + '/binding.json']: { mode: 0o600, hash: 'abc' },
  };
  const after = { ...installed, [prefix + '/.orphaned_at']: { mode: 0o644, hash: 'c'.repeat(64) } };
  const settings = { env: {}, enabledPlugins: {}, extraKnownMarketplaces: {} };
  const inspect = (
    residue = after,
    s = settings,
    r = { version: 2, plugins: {} },
    v = '2.1.319 (Claude Code)',
    writes = []
  ) => assessResidue(residue, installed, s, r, {}, v, '0.1.0', writes);
  assert.equal(inspect().pass, true);
  for (const changed of [
    { ...after, [prefix + '/extra']: { mode: 0o644, hash: 'new' } },
    { ...after, [prefix + '/binding.json']: { mode: 0o600, hash: 'changed' } },
    Object.fromEntries(Object.entries(after).filter(([p]) => p !== prefix + '/binding.json')),
    { ...after, [prefix + '/binding.json']: { mode: 0o600, hash: 'link:other' } },
    { ...after, unexpected: { mode: 0o600, hash: 'new' } },
    { ...after, [prefix + '/.orphaned_at']: { mode: 0o755, hash: 'directory' } },
    { ...after, [prefix + '/.orphaned_at']: { mode: 0o777, hash: 'link:other' } },
  ])
    assert.equal(inspect(changed).pass, false);
  assert.equal(inspect(after, { ...settings, enabledPlugins: { hud: true } }).pass, false);
  assert.equal(inspect(after, settings, { version: 2, plugins: { hud: [] } }).pass, false);
  for (const version of ['2.1.319 (Claude Code)', '2.1.322 (Claude Code)', 'synthetic-future (Claude Code)']) {
    const observed = inspect(after, settings, { version: 2, plugins: {} }, version);
    assert.equal(observed.pass, true);
    assert.equal(observed.cliVersion, version);
  }
  assert.equal(
    inspect(after, settings, { version: 2, plugins: {} }, '2.1.319 (Claude Code)', ['outside-allowance']).pass,
    false
  );
});
