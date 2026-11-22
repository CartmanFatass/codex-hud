import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { briefPrompt } from '../../dist/mcp/brief-prompt.js';
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
