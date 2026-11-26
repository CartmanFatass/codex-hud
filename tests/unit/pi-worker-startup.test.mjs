import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { briefPrompt } from '../../dist/mcp/brief-prompt.js';
import { cliWorkerStartup } from '../../dist/mcp/cli-worker-startup.js';

function temp(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(file, content) {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('inline limit is strictly below 16 KiB of assembled UTF-8, without truncating or removing the file', t => {
  const path = join(temp(t), 'brief.md');
  const under = 'é'.repeat(8191) + '\n';
  put(path, under);
  assert.equal(briefPrompt(path), `Carry out this brief:\n\n${under}`);
  fs.appendFileSync(path, 'x');
  const fallback = `Read ${path} and do exactly what it asks.`;
  assert.equal(briefPrompt(path), fallback);
  assert.equal(fs.readFileSync(path, 'utf8'), under + 'x');
  put(path, 'A NUL\0cannot travel in argv');
  assert.equal(briefPrompt(path), fallback);
});

test('cliWorkerStartup for agy inlines role and standing brief under 16 KiB and falls back at the bound or on NUL', t => {
  const root = temp(t);
  const dir = join(root, 'job');
  const instructions = join(root, 'role.md');
  const standing = join(root, 'standing.md');
  const briefPath = join(dir, 'brief.md');
  const place = { harness: 'cli', agent: 'agy' };
  const ref = `Read the project standing brief: ${JSON.stringify(standing)}.`;
  const run = () => cliWorkerStartup(place, root, dir, instructions, 'entry.mjs', [], { path: standing, label: standing });

  put(instructions, '# Synthetic role\nFollow rules.\n');
  put(standing, '# Synthetic standing\nProject rules.\n');
  put(briefPath, `Synthetic task.\n\n${ref}\n\n`);
  const inlined = run();
  assert.deepEqual(inlined.args, []);
  assert.equal(
    inlined.prompt,
    `# Synthetic role\nFollow rules.\n\nProject standing brief (${JSON.stringify(standing)}):\n\n# Synthetic standing\nProject rules.\n\nCarry out this brief:\n\nSynthetic task.\n\n`
  );
  assert.ok(fs.readFileSync(briefPath, 'utf8').includes(ref));

  put(instructions, 'é'.repeat(8192));
  const bigRole = run();
  assert.ok(bigRole.prompt.startsWith(`Read ${instructions} for your role instructions.\n\nProject standing brief (`));
  assert.equal(bigRole.prompt.includes(ref), false);

  put(instructions, 'Role with\0NUL');
  assert.ok(run().prompt.startsWith(`Read ${instructions} for your role instructions.\n\n`));

  put(instructions, '# Synthetic role\n');
  put(standing, 'é'.repeat(8192));
  const bigStanding = run();
  assert.equal(bigStanding.prompt, `# Synthetic role\n\nCarry out this brief:\n\nSynthetic task.\n\n${ref}\n\n`);

  put(standing, 'Standing\0NUL');
  assert.equal(run().prompt, `# Synthetic role\n\nCarry out this brief:\n\nSynthetic task.\n\n${ref}\n\n`);

  put(standing, '# Synthetic standing\n');
  put(briefPath, 'x'.repeat(16 * 1024));
  assert.equal(
    run().prompt,
    `# Synthetic role\n\nProject standing brief (${JSON.stringify(standing)}):\n\n# Synthetic standing\n\nRead ${briefPath} and do exactly what it asks.`
  );

  put(standing, 'x'.repeat(16 * 1024));
  assert.equal(
    run().prompt,
    `# Synthetic role\n\n${ref}\n\nRead ${briefPath} and do exactly what it asks.`
  );
});

test('CLI role startup keeps system instructions when possible and keeps controls out of agent argv', t => {
  const root = temp(t);
  const dir = join(root, 'job');
  const instructions = join(root, 'role.md');
  const brief = 'Carry out this brief:\n\nSynthetic task.';
  const run = (agent, file = instructions) =>
    cliWorkerStartup({ harness: 'cli', agent }, root, dir, file, 'entry.mjs', []);
  put(join(dir, 'brief.md'), 'Synthetic task.');

  const oneLine = `Synthetic rôle: say 'hello'!`;
  put(instructions, oneLine);
  assert.deepEqual(run('grok'), { args: ['--rules', oneLine], prompt: brief });

  for (const char of ['\n', '\r', '\t', '\u007f', '\u0085']) {
    const role = `Synthetic role${char}Follow rules.`;
    put(instructions, role);
    assert.deepEqual(run('grok'), { args: [], prompt: `${role}\n\n${brief}` });
    const codex = run('codex');
    assert.equal(codex.warning, undefined);
    assert.ok(codex.args.every((arg) => !/\p{Cc}/u.test(arg)));
    assert.equal(JSON.parse(codex.args[1].slice('developer_instructions='.length)), role);
  }

  const role = '# Synthetic role\nFollow rules.\n';
  put(instructions, role);
  const mcp = ['--strict-mcp-config', '--mcp-config', join(dir, 'worker-mcp.json')];
  assert.deepEqual(run('claude'), { args: [...mcp, '--append-system-prompt-file', instructions], prompt: brief });
  const unsafePath = join(root, 'role\nname.md');
  put(unsafePath, role);
  assert.deepEqual(run('claude', unsafePath), { args: mcp, prompt: `${role.trimEnd()}\n\n${brief}` });
});
