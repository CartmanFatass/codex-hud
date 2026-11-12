import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selectDecisionProvider } from '../../dist/jev/decide.js';
import { loadSettings } from '../../dist/settings.js';
import { renderSettingsPage } from '../../dist/render/settings-page.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-extensions-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'checkout with spaces'), home = path.join(temp, 'home');
  const hud = path.join(temp, 'hud home'), bin = path.join(temp, 'bin');
  fs.mkdirSync(path.join(repo, 'install.d'), { recursive: true });
  fs.mkdirSync(bin);
  for (const file of ['install', 'install.d/browser.sh', 'install.d/herdr.sh']) fs.copyFileSync(path.join(root, file), path.join(repo, file));
  // An isolated PATH cannot accidentally discover the owner's real external CLIs.
  for (const name of ['bash', 'dirname', 'readlink', 'mkdir', 'ln', 'rm']) fs.symlinkSync(`/usr/bin/${name}`, path.join(bin, name));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = { ...process.env, HOME: home, HUD_HOME: hud, PATH: bin,
    CODEX_HOME: path.join(temp, 'codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'claude'), PI_CODING_AGENT_DIR: path.join(temp, 'pi') };
  const fake = (name) => fs.writeFileSync(path.join(bin, name), '#!/bin/bash\necho "must not execute external tool" >&2\nexit 99\n', { mode: 0o755 });
  const run = (extension, uninstall = false, status = 0) => {
    const args = ['--skip-build', '--with', extension, ...(uninstall ? ['--uninstall'] : [])];
    const result = spawnSync('./install', args, { cwd: repo, env, encoding: 'utf8' });
    console.log(`$ ./install ${args.join(' ')}\n${result.stdout}${result.stderr}exit=${result.status}`);
    assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
    return result.stdout + result.stderr;
  };
  return { repo, home, hud, bin, env, fake, run, config: path.join(hud, 'config.json') };
}
const board = { revision: '', lanes: [], workers: [], decisions: [], coverage: {} };
const browserAvailable = async (f) => (await new ProjectCollector(f.repo, f.hud, f.env, f.home).collect(true, board, Date.now())).browser;

test('herdr preflight reports every installed command and source; uninstall is a no-op', (t) => {
  const f = fixture(t);
  for (const name of ['herdr', 'pi-role', 'pi-role-reap', 'pi-dispatch', 'pi']) f.fake(name);
  const text = f.run('herdr');
  for (const name of ['herdr', 'pi-role', 'pi-role-reap', 'pi-dispatch', 'pi']) assert.ok(text.includes(`Present: ${name} (${path.join(f.bin, name)})`));
  assert.match(text, /from herdr/);
  assert.match(text, /from the locally installed pi-roles bundle/);
  assert.match(text, /from the pi coding-agent CLI/);
  assert.equal(fs.existsSync(f.config), false);
  for (const name of ['pi-role', 'pi-role-reap', 'pi-dispatch', 'pi']) fs.unlinkSync(path.join(f.bin, name));
  assert.match(f.run('herdr'), /Missing: pi-role/);
  fs.unlinkSync(path.join(f.bin, 'herdr'));
  assert.match(f.run('herdr', true), /no-op; nothing to uninstall/);
});

test('missing herdr fails clearly before any home, command, config or build change', (t) => {
  const f = fixture(t);
  assert.match(f.run('herdr', false, 1), /herdr is required/);
  assert.equal(fs.existsSync(f.home), false);
  assert.equal(fs.existsSync(f.hud), false);
  fs.mkdirSync(f.hud);
  fs.writeFileSync(f.config, '{"owner":"keep"}\n');
  assert.match(f.run('herdr', false, 1), /Missing: herdr/);
  assert.equal(fs.readFileSync(f.config, 'utf8'), '{"owner":"keep"}\n');
  assert.deepEqual(fs.readdirSync(f.hud), ['config.json']);
  assert.equal(fs.existsSync(f.home), false);
});

test('browser only reports PATH tools; repeat install and no-op uninstall leave HUD config/data alone', async (t) => {
  const f = fixture(t);
  for (const name of ['google-chrome', 'jev-ask', 'jev-aistudio', 'jev-flow']) f.fake(name);
  const text = f.run('browser');
  for (const name of ['google-chrome', 'jev-ask', 'jev-aistudio', 'jev-flow']) assert.ok(text.includes(`Present: ${name} (${path.join(f.bin, name)})`));
  assert.match(text, /from Google Chrome/);
  assert.match(text, /from the external Jev CLIs/);
  assert.match(text, /checks only; configure Chrome and Jev CLIs separately/);
  assert.deepEqual(fs.readdirSync(f.hud), []);
  assert.equal(await browserAvailable(f), true, 'Project readiness needs no owned runtime or config');
  fs.writeFileSync(f.config, '{ "jev": { "chrome": "/synthetic/ignored" }, "owner": true }\n');
  const before = fs.readFileSync(f.config, 'utf8'), stamp = fs.statSync(f.config).mtimeMs;
  for (const name of ['jev-aistudio', 'jev-flow']) fs.unlinkSync(path.join(f.bin, name));
  const repeated = f.run('browser');
  for (const name of ['jev-aistudio', 'jev-flow']) assert.match(repeated, new RegExp(`Missing: ${name}`));
  assert.equal(await browserAvailable(f), true, 'optional CLIs are not required by Project');
  for (const name of ['google-chrome', 'jev-ask']) fs.unlinkSync(path.join(f.bin, name));
  assert.match(f.run('browser', true), /browser extension: no-op; nothing to uninstall/);
  assert.equal(fs.readFileSync(f.config, 'utf8'), before);
  assert.equal(fs.statSync(f.config).mtimeMs, stamp);
  assert.deepEqual(fs.readdirSync(f.hud), ['config.json']);
});

for (const missing of [['google-chrome'], ['jev-ask'], ['google-chrome', 'jev-ask']]) test(`browser preflight refuses missing ${missing.join(' + ')} without changes; Project agrees`, async (t) => {
  const f = fixture(t);
  for (const name of ['google-chrome', 'jev-ask', 'jev-aistudio', 'jev-flow']) if (!missing.includes(name)) f.fake(name);
  const text = f.run('browser', false, 1);
  for (const name of missing) assert.match(text, new RegExp(`Missing: ${name}`));
  assert.match(text, /Chrome \(google-chrome\) and jev-ask are required/);
  assert.equal(fs.existsSync(f.home), false);
  assert.equal(fs.existsSync(f.hud), false);
  assert.equal(await browserAvailable(f), false);
  // An old owned-runtime record and a jev.chrome value must not authorize readiness.
  fs.mkdirSync(path.join(f.hud, 'jev-runtime'), { recursive: true });
  fs.writeFileSync(path.join(f.hud, 'jev-runtime/runtime.json'), '{}');
  const before = '{"jev":{"chrome":"/synthetic/chrome"},"owner":"keep"}\n';
  fs.writeFileSync(f.config, before);
  f.run('browser', false, 1);
  assert.equal(await browserAvailable(f), false);
  assert.equal(fs.readFileSync(f.config, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.hud).sort(), ['config.json', 'jev-runtime']);
  assert.equal(fs.readFileSync(path.join(f.hud, 'jev-runtime/runtime.json'), 'utf8'), '{}');
  assert.equal(fs.existsSync(f.home), false);
});

test('browser checks reject non-executable PATH tools, and Project refresh notices availability changes', async (t) => {
  const f = fixture(t);
  f.fake('google-chrome'); f.fake('jev-ask');
  const collector = new ProjectCollector(f.repo, f.hud, f.env, f.home);
  assert.equal((await collector.collect(true, board, 0)).browser, true);
  fs.chmodSync(path.join(f.bin, 'google-chrome'), 0o600);
  assert.match(f.run('browser', false, 1), /Missing: google-chrome/);
  assert.equal((await collector.collect(true, board, 1)).browser, false);
  fs.chmodSync(path.join(f.bin, 'google-chrome'), 0o755);
  fs.chmodSync(path.join(f.bin, 'jev-ask'), 0o600);
  assert.match(f.run('browser', false, 1), /Missing: jev-ask/);
  assert.equal((await collector.collect(true, board, 2)).browser, false);
  assert.equal(fs.existsSync(f.home), false);
  assert.equal(fs.existsSync(f.hud), false);
});

for (const config of [undefined, {}, { decisions: { primary: 'openai' }, owner: true }]) test(`Decision API and panel without jev (${JSON.stringify(config) ?? 'no config file'})`, async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.hud);
  if (config !== undefined) fs.writeFileSync(f.config, JSON.stringify(config));
  // Explicit synthetic credentials and injected HTTP exercise the real selector/provider, with no network.
  const env = { HOME: f.home, HUD_HOME: f.hud, OPENAI_API_KEY: 'synthetic-not-a-real-key', PATH: f.bin };
  let calls = 0;
  const provider = await selectDecisionProvider(undefined, env, async () => {
    calls++;
    return Response.json({ answers: [{ name: 'pick', type: 'choice', choice: 'YES', probabilities: { YES: 1, NO: 0 }, confidence: 1 }] });
  });
  const result = await provider.decide({ page: { url: 'https://example.invalid', title: 'Synthetic', text: 'Ready' }, elements: [], recentActions: [], goal: 'Is it ready?', questions: [{ name: 'pick', rules: ['Use the facts'], choices: [{ value: 'YES', description: 'Ready' }, { value: 'NO', description: 'Not ready' }] }] }, { cacheKey: 'synthetic' });
  assert.equal(result.provider, 'openai');
  assert.equal(result.answers[0].choice, 'YES');
  assert.equal(calls, 1);
  const settings = loadSettings(env);
  assert.equal(settings.decisionApi, 'openai');
  const frame = renderSettingsPage({ draft: settings, original: settings, selected: 0, offset: 0, message: '' }, 80, 40);
  assert.ok(frame.lines.length > 0);
  const collector = new ProjectCollector(f.repo, f.hud, env, f.home);
  const project = await collector.collect(true, board, Date.now());
  assert.equal(project.browser, false);
  assert.ok(project.control.length > 0);
  assert.equal(fs.existsSync(path.join(f.hud, 'browser')), false);
});
