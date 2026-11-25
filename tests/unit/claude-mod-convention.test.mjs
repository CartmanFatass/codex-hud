import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MOD_CONVENTION, slimRoster } from '../../integrations/claude-mod/hooks/short-convention.ts';
import { compactResult } from '../../dist/mcp/mcp/result-text.js';

const shipped = readFileSync(new URL('../../packages/hud-mcp/hud-convention.md', import.meta.url), 'utf8');
const path = '/hud-install/packages/hud-mcp/hud-convention.md';

test('review the short default and its hook coverage whenever the shipped convention changes', () => {
  // The short version retains judgment; mechanics omitted here are in the mod's convention tests
  // (create isolation, close approval, report reads, explicit owner_try and wait) or HUD itself
  // (placement, scout checks, batching, land ids, and the tool-specific argument descriptions).
  assert.equal(createHash('sha256').update(shipped).digest('hex'),
    '6d2f117f8eec75cea762687668d72d9ab06a7f7ae0ac77e27ecc043af5023edc',
    'Default convention changed: review MOD_CONVENTION and the convention hooks/tests before updating this digest');
  assert.ok(Buffer.byteLength(MOD_CONVENTION) <= 0.45 * Buffer.byteLength(shipped));
});

test('both shipped convention sizes teach recording owner requests with hud_objective', () => {
  for (const text of [shipped, MOD_CONVENTION]) {
    assert.match(text, /hud_objective[^\n]*op: "request"/);
    assert.match(text, /hud_objective[^\n]*op: "resolve"[^\n]*request/);
    assert.doesNotMatch(text, /Waiting for the owner|Remove the request/);
  }
});

test('only the bundled path is shortened in actual MCP compact text and JSON', () => {
  for (const format of [compactResult, JSON.stringify]) {
    const roster = { convention: { path, text: shipped, truncated: false }, hint: 'Keep working', changes: ['job settled'] };
    const shortened = slimRoster(format(roster));
    assert.equal(shortened, format({ ...roster, convention: { ...roster.convention, text: MOD_CONVENTION } }));
    for (const override of ['/project/.hud/hud-convention.md', '/project/hud-convention.md', '/hud-home/hud-convention.md'])
      assert.equal(slimRoster(format({ ...roster, convention: { ...roster.convention, path: override } })), undefined);
    assert.equal(slimRoster(format({ convention_unchanged: true })), undefined);
  }
});
