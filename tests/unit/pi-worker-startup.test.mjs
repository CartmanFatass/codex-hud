import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { briefPrompt } from '../../dist/mcp/brief-prompt.js';
import { cliWorkerStartup } from '../../dist/mcp/cli-worker-startup.js';
import { piMcpConfigEmpty } from '../../dist/mcp/pi-mcp-config.js';

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

test('adapter emptiness checks user and cwd configs, not other projects or cached server names', t => {
  const root = temp(t), home = join(root, 'home'), project = join(root, 'project');
  for (const [key, value] of Object.entries({ HOME: home, PI_CODING_AGENT_DIR: '~/custom-agent', PI_PACKAGE_DIR: '', PI_MCP_CONFIG_MODE: '' })) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  const agent = join(home, 'custom-agent');
  const empty = () => piMcpConfigEmpty(project);
  const server = '{"mcpServers":{"example":{"command":"unused"}}}';
  put(join(root, '.mcp.json'), server);
  put(join(agent, 'mcp-cache.json'), server);
  for (const file of [join(home, '.config/mcp/mcp.json'), join(home, '.agents/mcp.json'), join(home, '.agents/mcp/mcp.json'),
    join(agent, 'mcp.json'), join(agent, 'mcp-adapter.json'), join(project, '.mcp.json'), join(project, '.pi/mcp.json'), join(project, '.pi/mcp-adapter.json')]) {
    put(file, '{ // a commented file\n "mcpServers": {},\n}');
    assert.equal(empty(), true, file);
    put(file, server);
    assert.equal(empty(), false, file);
    fs.unlinkSync(file);
  }
  const adapter = join(agent, 'mcp-adapter.json');
  for (const text of ['{', 'null', '{"mcpServers":[]}', '{"imports":["cursor"]}', '{"settings":{"ancestorConfigRoots":["~/work"]}}']) {
    put(adapter, text);
    assert.equal(empty(), false, text);
  }
  fs.unlinkSync(adapter);
  fs.symlinkSync('missing', adapter);
  assert.equal(empty(), false, 'unreadable file');
  fs.unlinkSync(adapter);
  assert.equal(piMcpConfigEmpty(project, ['--mcp-config', 'other.json']), false);

  // A package in either settings.json can supply servers, independently of the eight config files.
  for (const dir of [agent, join(project, '.pi')]) {
    const settings = join(dir, 'settings.json');
    put(settings, '{"packages":[{"source":"npm:@example/tools@1"}]}');
    const manifest = join(dir, 'npm/node_modules/@example/tools/package.json');
    assert.equal(empty(), false, 'unresolved package');
    put(manifest, '{"name":"synthetic"}');
    assert.equal(empty(), true, 'plain package');
    put(manifest, '{"name":"synthetic","pi":{"mcp":"servers.json"}}');
    assert.equal(empty(), false, 'package MCP declaration');
    fs.unlinkSync(settings);
  }
  put(join(project, '.mcp.json'), server);
  process.env.PI_MCP_CONFIG_MODE = 'exclusive';
  assert.equal(empty(), true);
  put(adapter, server);
  assert.equal(empty(), false);
});
