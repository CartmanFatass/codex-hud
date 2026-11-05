import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createClaudeReader } from '../../src/harness/claude/reader.js';

const simulator = resolve('tests/fixtures/claude-contract-2026-11-05/simulator.mjs');
const sessionId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function utf8Collector() {
  const decoder = new StringDecoder('utf8');
  let text = '';
  return {
    push(bytes: Buffer) {
      text += decoder.write(bytes);
    },
    finish() {
      return text + decoder.end();
    },
  };
}

async function run(bare: boolean, explicitMcp = false) {
  const root = mkdtempSync(join(tmpdir(), 'm2-claude-contract-'));
  const hooksPath = join(root, 'hooks.jsonl');
  const discoveryPath = join(root, 'discovery.json');
  const child = spawn(
    process.execPath,
    [simulator, ...(bare ? ['--bare'] : []), ...(explicitMcp ? ['--mcp-config', 'synthetic.json'] : [])],
    {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        HUD_HOME: join(root, 'hud'),
        SYNTHETIC_HOOK_OUTPUT: hooksPath,
        SYNTHETIC_DISCOVERY_OUTPUT: discoveryPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const collector = utf8Collector();
  let stderr = '';
  child.stdout.on('data', (bytes: Buffer) => {
    collector.push(bytes);
  });
  child.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString('utf8');
  });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  const stdout = collector.finish();
  assert.equal(code, 0, stderr);
  const hooksText = readFileSync(hooksPath, 'utf8');
  return {
    root,
    stdout,
    discovery: JSON.parse(readFileSync(discoveryPath, 'utf8')),
    hooks: hooksText.trim()
      ? hooksText
          .trim()
          .split('\n')
          .map((s) => JSON.parse(s))
      : [],
  };
}

test('UTF-8 decoder buffers a deterministically split multibyte character', () => {
  const bytes = Buffer.from('Synthetic 中文');
  const cut = bytes.indexOf(Buffer.from('中')) + 1;
  assert.ok(cut > 0);
  const collector = utf8Collector();
  collector.push(bytes.subarray(0, cut));
  collector.push(bytes.subarray(cut));
  assert.equal(collector.finish(), 'Synthetic 中文');
  assert.notEqual(bytes.subarray(0, cut).toString('utf8') + bytes.subarray(cut).toString('utf8'), 'Synthetic 中文');
});

test('document snapshot: normal print mode exposes synthetic hook inputs separately from stream-json', async () => {
  const f = await run(false);
  try {
    const stream = f.stdout
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    assert.deepEqual(f.discovery, { projectHooks: true, projectMcp: true, explicitMcp: false });
    assert.equal(stream[0].event.delta.text, 'Synthetic 中文');
    assert.equal(stream.at(-1).type, 'result');
    assert.equal(stream.at(-1).session_id, sessionId);
    assert.ok(stream.every((item) => !('hook_event_name' in item)));
    assert.deepEqual(
      f.hooks.map((h: { hook_event_name: string }) => h.hook_event_name),
      ['SessionStart', 'SubagentStart', 'SubagentStop', 'SubagentStart', 'SubagentStop']
    );
    assert.equal(f.hooks[1].agent_type, 'general-purpose');
    assert.equal(f.hooks[1].agent_id, f.hooks[3].agent_id);
    assert.notEqual(f.hooks[2].agent_transcript_path, f.hooks[2].transcript_path);
    assert.equal(f.hooks[4].agent_type, '');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('document snapshot: bare mode skips the simulated auto-discovered hooks', async () => {
  const f = await run(true, true);
  try {
    assert.deepEqual(f.hooks, []);
    assert.deepEqual(f.discovery, { projectHooks: false, projectMcp: false, explicitMcp: true });
    assert.equal(JSON.parse(f.stdout.trim().split('\n').at(-1)!).type, 'result');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('HUD transcript reader does not promote these partial/result and hook fixtures to delegation evidence', async () => {
  const f = await run(false);
  try {
    const path = join(f.root, 'not-a-transcript.jsonl');
    writeFileSync(path, f.stdout);
    const reader = createClaudeReader({
      ref: { harness: 'claude', sourceId: 'e'.repeat(64), sessionId, threadId: null },
      resolveFile: () => path,
      serverNames: ['hud'],
    });
    const result = await reader.read({ maxBytes: 1024 * 1024, maxRecords: 100, budgetMs: 1000 });
    assert.deepEqual(result.evidence.linkEvidence, []);
    assert.deepEqual(result.evidence.native, []);
    assert.deepEqual(result.evidence.reports, []);
    assert.equal(result.evidence.action, undefined);
    // Hook payloads are another distinct channel, not transcript records.
    writeFileSync(path, f.hooks.map((hook: unknown) => JSON.stringify(hook)).join('\n') + '\n');
    const hookResult = await createClaudeReader({
      ref: { harness: 'claude', sourceId: 'e'.repeat(64), sessionId, threadId: null },
      resolveFile: () => path,
      serverNames: ['hud'],
    }).read({ maxBytes: 1024 * 1024, maxRecords: 100, budgetMs: 1000 });
    assert.deepEqual(hookResult.evidence.linkEvidence, []);
    assert.deepEqual(hookResult.evidence.native, []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
