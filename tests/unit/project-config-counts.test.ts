/**
 * What the bar's right cluster counts: the skills and hooks Codex reads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { countHooks, countSkills } from '../../src/collectors/project.js';

function skill(root: string, name: string): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), `# ${name}\n`);
}

test('skills are counted once by name across home, bundled, user and repository folders', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-skills-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codexHome = path.join(dir, 'codex');
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'work', 'repo');
  const cwd = path.join(repo, 'src');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(cwd, { recursive: true });

  assert.equal(countSkills(cwd, codexHome, home), null, 'no skills folder at all: unread, not zero');

  skill(path.join(codexHome, 'skills'), 'teaming');
  skill(path.join(codexHome, 'skills', '.system'), 'imagegen');
  skill(path.join(home, '.agents', 'skills'), 'teaming');
  skill(path.join(home, '.agents', 'skills'), 'jev-ask');
  skill(path.join(repo, '.agents', 'skills'), 'release');
  fs.mkdirSync(path.join(codexHome, 'skills', 'not-a-skill'), { recursive: true });
  // Above the repository's root is not the repository's.
  skill(path.join(dir, 'work', '.agents', 'skills'), 'outside');

  assert.equal(countSkills(cwd, codexHome, home), 4);
});

test('hooks count the handlers in each hooks.json, and an unreadable file says nothing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-hooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codexHome = path.join(dir, 'codex');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(codexHome, { recursive: true });

  assert.equal(countHooks(repo, codexHome), null);
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), '{ not json');
  assert.equal(countHooks(repo, codexHome), null);

  fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'a' }] }],
    PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: 'b' }, { type: 'command', command: 'c' }] }],
  } }));
  assert.equal(countHooks(repo, codexHome), 3);
  fs.mkdirSync(path.join(repo, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'd' }] }] } }));
  assert.equal(countHooks(repo, codexHome), 4);
});
