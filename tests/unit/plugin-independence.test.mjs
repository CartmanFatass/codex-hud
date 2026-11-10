import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import http from 'node:http';
import test from 'node:test';
import { getHudHome, getHudDisplayHome } from '../../dist/hud-home.js';
import { loadJevConfig, readHudCredentials } from '../../dist/jev/ask/config.js';
import { JevRuntime, RuntimeChrome } from '../../dist/jev/runtime/executor.js';
import { connectJevExecutor } from '../../dist/jev/runtime/client.js';
import { Browser } from '../../dist/jev/browser.js';
import { ModelProbe, apiSettings } from '../../dist/collectors/model-probe.js';
import { defaultSettings } from '../../dist/settings.js';
import { SyntheticModel } from '../../dist-test/tests/unit/b17-fixture.test.js';
import { main as hudMain } from '../../dist/cli/hud.js';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'hud-independent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function tree(root) {
  const result = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name),
        s = fs.lstatSync(file);
      result.push([path.relative(root, file), s.mode, s.size, s.mtimeMs]);
      if (s.isDirectory()) walk(file);
      else result.push(fs.readFileSync(file).toString('base64'));
    }
  }
  walk(root);
  return JSON.stringify(result);
}
test('legacy jev.env never supplies runtime credentials', (t) => {
  const root = fixture(t);
  fs.writeFileSync(
    path.join(root, 'jev.env'),
    'TYPESAFE_API_KEY=must-not-read\nOPENAI_API_KEY=must-not-read\nMISTRAL_API_KEY=must-not-read\n',
    { mode: 0o600 }
  );
  assert.deepEqual(readHudCredentials({ HOME: root, HUD_HOME: root }), { textModel: {} });
});
test('real import preview never prints source values and does not write', async (t) => {
  const root = fixture(t),
    home = path.join(root, 'hud');
  fs.mkdirSync(home);
  let output = '';
  fs.writeFileSync(path.join(home, 'jev.env'), 'OPENAI_API_KEY=unique-preview-secret-884\n', { mode: 0o600 });
  const before = tree(root);
  assert.equal(
    await hudMain(['import', 'preview'], {
      env: { HOME: root, HUD_HOME: home },
      stdout: (s) => {
        output += s;
      },
      stderr: (s) => {
        output += s;
      },
    }),
    0
  );
  assert.match(output, /OPENAI_API_KEY/);
  assert.ok(!output.includes('unique-preview-secret-884'));
  assert.equal(tree(root), before);
});
async function waitFor(fn, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(message());
}
for (const explicit of [true, false])
  test(`full bar and panel runs + settings save leave CODEX_HOME unchanged (${explicit ? 'explicit' : 'default'} HUD home)`, async (t) => {
    const root = fixture(t),
      home = path.join(root, 'home'),
      codex = path.join(root, 'codex'),
      hud = explicit ? path.join(root, 'hud') : path.join(home, '.hud');
    fs.mkdirSync(home);
    fs.mkdirSync(codex);
    fs.mkdirSync(hud, { recursive: true });
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd);
    const now = new Date();
    // SessionFinder walks local-calendar day directories. UTC can already be
    // tomorrow on this host, which would put the fixture outside its search.
    const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0'));
    const sessions = path.join(codex, 'sessions', ...day);
    fs.mkdirSync(sessions, { recursive: true });
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const rollout = path.join(sessions, `rollout-${now.toISOString().slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`);
    fs.writeFileSync(
      rollout,
      JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd, timestamp: now.toISOString(), source: 'cli' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_complete', last_agent_message: 'Synthetic complete' },
        }) +
        '\n'
    );
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codex,
      CODEX_HUD_CWD: cwd,
      CODEX_HUD_TMUX_SESSION: 'synthetic-home',
      CODEX_HUD_TMUX_BIN: '/bin/false',
      CODEX_HUD_PROFILE: '1',
      NO_COLOR: '1',
    };
    delete env.HUD_HOME;
    delete env.HUD_SETTINGS_PATH;
    delete env.CODEX_HUD_SETTINGS_PATH;
    if (explicit) env.HUD_HOME = hud;
    assert.equal(getHudHome(env), hud);
    assert.equal('defaultHudHome' in (await import('../../dist/jev/ask/config.js')), false);
    assert.equal(getHudDisplayHome(env), path.join(hud, 'display'));
    const before = tree(codex);
    // The actual settings save path, in a fresh process with no inherited path override.
    const save = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {saveSettings} from './dist/settings.js';saveSettings({language:'en',theme:'none',refreshMs:100});`,
      ],
      { env, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    await once(save, 'exit');
    assert.equal(save.exitCode, 0);
    assert.ok(fs.existsSync(path.join(hud, 'hud-settings.json')));
    for (const entry of ['dist/index.js', 'dist/tree-page.js']) {
      const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '',
        stderr = '';
      child.stdout.on('data', (b) => {
        output = (output + b).slice(-40000);
      });
      child.stderr.on('data', (b) => {
        stderr = (stderr + b).slice(-40000);
      });
      const exited = once(child, 'exit');
      t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      });
      try {
        await waitFor(
          () => output.includes('synthetic-home') || output.includes('Home') || output.includes('workspace'),
          () => `${entry} rendered nothing: ${stderr} ${output}`
        );
        const snapshotFile = path.join(hud, 'display', 'state', 'synthetic-home.json');
        // Await the discovered transcript contract, not merely file creation.
        await waitFor(
          () => fs.existsSync(snapshotFile) && JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).session?.id === id,
          () => `${entry} did not persist a discovered transcript in HUD snapshot: ${stderr} ${output}`
        );
        const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
        assert.equal(snapshot.session?.id, id, 'transcript still discovered from CODEX_HOME/sessions');
      } finally {
        child.kill('SIGTERM');
        await exited;
      }
      assert.equal(tree(codex), before, entry + ' wrote into transcript home');
    }
    assert.ok(fs.existsSync(path.join(hud, 'display')));
    assert.equal(tree(codex), before);
  });
test('repository source/bin paths contain no Codex-home HUD joins or hardcoded CDP endpoint', () => {
  const forbidden = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (/\.(?:ts|mjs|ps1)$/.test(name) || dir === 'bin') {
        const body = fs.readFileSync(file, 'utf8');
        if (
          /(?:join|resolve)\([^\n]*(?:codexHome|getCodexHome\(\))[^\n]*['"](?:hud|hud-settings\.json)['"]/.test(body) ||
          /\$CODEX_HOME\/(?:hud\/|hud-settings\.json)/.test(body) ||
          /(?:127\.0\.0\.1|localhost):9222/.test(body)
        )
          forbidden.push(file);
      }
    }
  }
  walk('src');
  walk('bin');
  assert.deepEqual(forbidden, []);
});
test('all missing Jev location keys fail pre_send before any probe/CDP; Browser has no endpoint default', async (t) => {
  const root = fixture(t);
  let connections = 0;
  const listener = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${listener.address().port}`;
  const complete = { cdpUrl: url, chrome: '/synthetic/chrome', profile: root, stateDir: root };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ jev: complete }));
  let probes = 0;
  const chrome = new RuntimeChrome(
    async () => {
      probes++;
      throw new Error('unexpected start');
    },
    async () => {
      probes++;
      return { webSocketDebuggerUrl: 'synthetic' };
    }
  );
  for (const key of ['cdpUrl', 'chrome', 'profile', 'stateDir']) {
    const config = { ...complete };
    delete config[key];
    assert.throws(
      () => loadJevConfig({ configJson: { jev: config } }),
      (e) => e.code === 'pre_send' && e.message.includes(`jev.${key}`) && e.message.includes('hud import')
    );
    await assert.rejects(
      chrome.ensure(config, url),
      (e) => e.code === 'pre_send' && e.message.includes(key) && e.message.includes('hud import')
    );
    // Three explicit values cannot borrow the fourth from an otherwise valid HUD JSON.
    await assert.rejects(
      new JevRuntime({ hudHome: root, ...config }).start(),
      (e) => e.code === 'pre_send' && e.message.includes(`jev.${key}`) && e.message.includes('hud import')
    );
    await assert.rejects(
      connectJevExecutor(root, config),
      (e) => e.code === 'pre_send' && e.message.includes(`jev.${key}`) && e.message.includes('hud import')
    );
  }
  for (const call of [
    () => Browser.open('https://example.invalid'),
    () => Browser.attach('synthetic'),
    () => Browser.targets(),
  ])
    await assert.rejects(
      call(),
      (e) => e.code === 'pre_send' && e.message.includes('jev.cdpUrl') && e.message.includes('hud import')
    );
  assert.equal(connections, 0);
  assert.equal(probes, 0);
});
test('real panel default requests reach a local capture server with none/low/high; no key means no request', async (t) => {
  const root = fixture(t);
  const bodies = [],
    auth = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    bodies.push(JSON.parse(body));
    auth.push(req.headers.authorization);
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const fetcher = (url, options) => {
    assert.equal(url, 'https://api.mistral.ai/v1/chat/completions');
    return fetch(`http://127.0.0.1:${server.address().port}`, options);
  };
  const settings = { ...defaultSettings(), briefing: 'api' };
  assert.equal(Object.hasOwn(apiSettings(settings), 'sourceCredential'), false);
  const probe = new ModelProbe({
    env: { HOME: root, HUD_HOME: root, MISTRAL_API_KEY: 'synthetic-panel-key' },
    fetch: fetcher,
  });
  await probe.run(settings);
  assert.deepEqual(
    bodies.map((b) => b.model),
    Array(3).fill('deepseek-v4-1-flash-1017')
  );
  assert.deepEqual(
    bodies.map((b) => b.reasoning_effort),
    ['none', 'low', 'high']
  );
  assert.deepEqual(auth, Array(3).fill('Bearer synthetic-panel-key'));
  const off = new ModelProbe({
    env: { HOME: root, HUD_HOME: root, CODEX_HUD_BRIEF_API_KEY: 'ignored' },
    fetch: fetcher,
  });
  await off.run(settings);
  assert.equal(bodies.length, 3);
  assert.ok(off.current().rows.every((row) => row.status === 'failed'));
  // Approved B17 test-only accountless source binding still exercises the real transport without auth.
  const model = new SyntheticModel({ env: { HOME: root, HUD_HOME: root } });
  model.configure({
    backend: 'api',
    api: { base: `http://127.0.0.1:${server.address().port}`, model: 'synthetic-model' },
  });
  await model.submit({ feature: 'labels', system: 'synthetic', prompt: 'synthetic' }).result;
  assert.equal(bodies.length, 4);
  assert.equal(auth[3], undefined);
});
