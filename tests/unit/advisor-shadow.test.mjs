import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  ADVISOR_DEDUPE_MS,
  ADVISOR_NOTICE_MS,
  adviseOnMessage,
  advisorIndexPath,
  advisorStatePath,
  clearAdvisorIndexMemory,
  getSkillIndex,
  messageNamesSkillPath,
  parseSkillFrontmatter,
  readAdvisorNotice,
  readAdvisorRecommendations,
  scrubSecrets,
} from '../../dist/collectors/advisor-shadow.js';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { panelActionLine, PANEL_ACTIONS_FILE } from '../../dist/collectors/panel-actions.js';
import { adviseCommand } from '../../dist/cli/advise.js';
import { installPiPackage } from '../../dist/harness/pi/package-entry.js';
import { createPanelActions } from '../../dist/panel/actions.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { homeRows } from '../../dist/render/home-view.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { renderBar } from '../../dist/render/layout/bar-fields.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { loadSettings } from '../../dist/settings.js';
import { collectAndRenderParity } from '../../dist/statusline-parity/collect.js';
import { paritySettings } from '../../dist/statusline-parity/settings.js';
import { copyToClipboard, osc52Sequence } from '../../dist/utils/clipboard.js';
import { fakeDecisionServer } from '../helpers/thin-mcp-harness.mjs';
import { registerAdvisor } from '../../integrations/claude-mod/hooks/advisor.ts';

function setupEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-advisor-'));
  t.after(() => {
    clearAdvisorIndexMemory();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  const hudHome = path.join(home, '.hud');
  const skillsDir = path.join(root, 'skills');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(hudHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    HUD_HOME: hudHome,
    HUD_SETTINGS_PATH: path.join(hudHome, 'hud-settings.json'),
  };
  delete env.HUD_JOB_DIR;
  return { root, home, hudHome, skillsDir, projectRoot, env };
}

function writeSkill(skillsDir, folder, name, description) {
  const dir = path.join(skillsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nBody not sent.\n`);
  return fs.realpathSync(file);
}

function configureStubDecision(env, hudHome, baseUrl) {
  fs.writeFileSync(
    path.join(hudHome, 'credentials.env'),
    `OPENAI_API_KEY=synthetic-test-key\nOPENAI_BASE_URL=${baseUrl}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(hudHome, 'config.json'),
    JSON.stringify({
      decisions: { primary: 'openai', openai: { baseUrl } },
    }) + '\n',
    { mode: 0o600 }
  );
  env.OPENAI_API_KEY = 'synthetic-test-key';
  env.OPENAI_BASE_URL = baseUrl;
}

function choiceResponse(body, picked) {
  return {
    answers: body.questions.map(({ name, choices }) => ({
      name,
      type: 'choice',
      choice: picked,
      confidence: 0.95,
      probabilities: choices.map(({ value }) => ({ value, probability: value === picked ? 0.95 : 0.05 / Math.max(1, choices.length - 1) })),
    })),
  };
}

test('switch off makes no Decision API call and builds no index', async (t) => {
  const f = setupEnv(t);
  writeSkill(f.skillsDir, 'tdd', 'tdd', 'Test-driven development red-green loop.');
  const api = await fakeDecisionServer(t, (body) => choiceResponse(body, 'tdd'));
  configureStubDecision(f.env, f.hudHome, api.baseUrl);
  fs.writeFileSync(
    f.env.HUD_SETTINGS_PATH,
    JSON.stringify({ advisorShadow: false, advisorSkillDirs: [f.skillsDir] })
  );

  assert.equal(loadSettings(f.env).advisorShadow, false);
  const res = await adviseOnMessage(
    f.hudHome,
    { session: 'sess-off', projectRoot: f.projectRoot, message: 'Write unit tests first for billing.' },
    { env: f.env }
  );
  assert.equal(res, undefined);
  assert.equal(api.requests.length, 0);
  assert.equal(fs.existsSync(advisorIndexPath(f.hudHome)), false);
  assert.equal(fs.existsSync(advisorStatePath(f.hudHome)), false);
  assert.equal(fs.existsSync(path.join(f.hudHome, 'events')), false);
});

test('skill indexer enforces 300-byte fields, 200 skills / 64 KiB cap, and mtime caching', (t) => {
  const f = setupEnv(t);
  const longName = 'é'.repeat(200);
  const longDesc = 'desc-'.repeat(100);
  const parsed = parseSkillFrontmatter(`---\nname: ${longName}\ndescription: >-\n  ${longDesc}\n---\n`);
  assert.ok(parsed);
  assert.ok(Buffer.byteLength(parsed.name, 'utf8') <= 300);
  assert.ok(Buffer.byteLength(parsed.description, 'utf8') <= 300);
  assert.doesNotMatch(parsed.name, /\uFFFD/);

  // Create 210 skills to verify the 200-skill cap and 64 KiB cap.
  for (let i = 0; i < 210; i++) {
    const id = `skill-${String(i).padStart(3, '0')}`;
    writeSkill(f.skillsDir, id, id, `Synthetic description for ${id} `.padEnd(280, 'a'));
  }
  const index = getSkillIndex(f.hudHome, [f.skillsDir]);
  assert.ok(index.length <= 200 && index.length > 0);
  const payloadBytes = Buffer.byteLength(JSON.stringify(index.map(({ name, description }) => ({ name, description }))));
  assert.ok(payloadBytes <= 64 * 1024);

  // Modify a skill file in place without changing the root directory mtime -> cache is reused.
  const firstFile = path.join(f.skillsDir, 'skill-000', 'SKILL.md');
  fs.writeFileSync(firstFile, '---\nname: skill-000\ndescription: Updated without dir mtime change\n---\n');
  const cached = getSkillIndex(f.hudHome, [f.skillsDir]);
  assert.equal(cached[0].description, index[0].description);

  // Bump the configured skill directory's mtime -> index rebuilds.
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(f.skillsDir, future, future);
  const rebuilt = getSkillIndex(f.hudHome, [f.skillsDir]);
  assert.equal(rebuilt[0].description, 'Updated without dir mtime change');
});

test('recommendation renders in bar notice zone (Text + Nerd, after quota, 10m) and panel; NONE shows nothing', async (t) => {
  const f = setupEnv(t);
  const tddPath = writeSkill(f.skillsDir, 'tdd', 'tdd', 'Test-driven development red-green loop.');
  writeSkill(f.skillsDir, 'design', 'codebase-design', 'Deep modules and seam design.');

  let nextPick = 'tdd';
  const api = await fakeDecisionServer(t, (body) => choiceResponse(body, nextPick));
  configureStubDecision(f.env, f.hudHome, api.baseUrl);
  fs.writeFileSync(
    f.env.HUD_SETTINGS_PATH,
    JSON.stringify({ advisorShadow: true, advisorSkillDirs: [f.skillsDir] })
  );

  const now = Date.parse('2026-11-24T20:00:00.000Z');
  const rawMessage = `Help me write tests first. Token sk-proj-abcdefghijklmnopqrstuvwxyz123456 Bearer secret_token_value_1234567890 ${'x'.repeat(2500)}`;
  const rawReply = `Sure, API_KEY=supersecretvalue99999 ${'y'.repeat(2500)}`;

  const rec = await adviseOnMessage(
    f.hudHome,
    { session: 'sess-1', projectRoot: f.projectRoot, message: rawMessage, previousReply: rawReply, messageId: 'm1' },
    { env: f.env, now }
  );
  assert.ok(rec);
  assert.equal(rec.skill, 'tdd');
  assert.equal(rec.path, tddPath);
  assert.equal(api.requests.length, 1);

  // Verify outbound discipline: scrubbed secrets, <=2000 chars, fixed choices + NONE, untrusted data, no file paths.
  const reqBody = api.requests[0];
  assert.equal(reqBody.prompt_cache_key, 'advisor-shadow');
  const serialized = JSON.stringify(reqBody);
  assert.doesNotMatch(serialized, /sk-proj-abcdefghijklmnopqrstuvwxyz|secret_token_value|supersecretvalue99999/);
  assert.doesNotMatch(serialized, new RegExp(tddPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(serialized, /Body not sent/);
  const data = reqBody.input[0].content.filter((item) => item.type === 'input_json').map((item) => item.data);
  assert.ok(data[0].page.text.length <= 2000);
  assert.ok(data[1].facts.previous_assistant_reply.length <= 2000);
  assert.match(reqBody.questions[0].instructions, /NONE is the default/i);
  assert.match(reqBody.questions[0].instructions, /untrusted quoted data/i);
  assert.deepEqual(reqBody.questions[0].choices.map((c) => c.value), ['codebase-design', 'tdd', 'NONE']);

  // Verify advice event appended once to $HUD_HOME/events/2026-11.jsonl with 0600 mode.
  const eventsFile = path.join(f.hudHome, 'events', '2026-11.jsonl');
  assert.equal(fs.statSync(eventsFile).mode & 0o777, 0o600);
  const eventLines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(eventLines.length, 1);
  assert.equal(eventLines[0].kind, 'advice');
  assert.equal(eventLines[0].session, 'sess-1');
  assert.equal(eventLines[0].skill, 'tdd');
  assert.equal(eventLines[0].at, new Date(now).toISOString());
  assert.ok(Number.isInteger(eventLines[0].ms) && eventLines[0].ms >= 0);

  // Bar notice zone: Text and Nerd icon sets, positioned after quota notices, visible for 10m.
  const notice = readAdvisorNotice(f.hudHome, { session: 'sess-1', projectRoot: f.projectRoot }, now + 5_000, f.env);
  assert.deepEqual(notice, { skill: 'tdd', path: tddPath, at: now });
  const baseFacts = {
    model: { name: 'opus' },
    context: { percent: 40, shown: '40%', window: 200000 },
    evenQuota: [{ role: 'imp', preset: 'deep', until: now + 60_000 }],
    advisor: notice,
  };
  setDisplayConfig({ theme: 'none', barStyle: 'line', icons: 'text' });
  const textBar = stripAnsi(renderBar(baseFacts, 140, now + 5_000).line);
  assert.match(textBar, /imp deep: quota.*skill: tdd/);
  assert.doesNotMatch(textBar, /\uf0eb/);

  setDisplayConfig({ theme: 'none', barStyle: 'line', icons: 'nerd' });
  const nerdBar = stripAnsi(renderBar(baseFacts, 140, now + 5_000).line);
  assert.match(nerdBar, /imp deep: quota.*\uf0eb skill: tdd/);

  // After 10 minutes, bar notice disappears.
  const expiredBar = stripAnsi(renderBar(baseFacts, 140, now + ADVISOR_NOTICE_MS).line);
  assert.doesNotMatch(expiredBar, /skill: tdd/);
  assert.equal(readAdvisorNotice(f.hudHome, { session: 'sess-1' }, now + ADVISOR_NOTICE_MS, f.env), undefined);

  // Panel Home view shows `<name> — <absolute SKILL.md path>` under the session's project.
  const collector = new HomePortfolioCollector(f.hudHome);
  const prevHud = process.env.HUD_HOME;
  const prevSettings = process.env.HUD_SETTINGS_PATH;
  process.env.HUD_HOME = f.hudHome;
  process.env.HUD_SETTINGS_PATH = f.env.HUD_SETTINGS_PATH;
  let portfolio;
  try {
    portfolio = await collector.read(
      [{ root: fs.realpathSync(f.projectRoot), name: 'project', unavailable: false, registrationIndex: 0 }],
      { workers: [], activeCount: 0, waitingCount: 0, failedCount: 0 },
      now + 5_000
    );
  } finally {
    process.env.HUD_HOME = prevHud;
    process.env.HUD_SETTINGS_PATH = prevSettings;
  }
  assert.equal(portfolio.projects[0].advisor?.skill, 'tdd');
  const rows = homeRows(portfolio, 120, now + 5_000, 20, false, undefined, { sorted: [], overdue: 0, today: 0 });
  const advRow = rows.find((r) => r.advisorCopy);
  assert.ok(advRow);
  const plainRow = stripAnsi(advRow.text);
  assert.match(plainRow, new RegExp(`tdd — ${tddPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(visualLength(advRow.text), 120);

  // NONE shows nothing and logs no event.
  nextPick = 'NONE';
  const noneRes = await adviseOnMessage(
    f.hudHome,
    { session: 'sess-none', projectRoot: f.projectRoot, message: 'Just saying hello!', messageId: 'm-none' },
    { env: f.env, now: now + 10_000 }
  );
  assert.equal(noneRes, undefined);
  assert.equal(readAdvisorNotice(f.hudHome, { session: 'sess-none' }, now + 10_000, f.env), undefined);
  assert.equal(fs.readFileSync(eventsFile, 'utf8').trim().split('\n').length, 1);
});

test('panel Enter and click emit copy-advisor, write OSC 52 (+ WSL clip.exe), and log panel action', (t) => {
  const f = setupEnv(t);
  const tddPath = writeSkill(f.skillsDir, 'tdd', 'tdd', 'TDD skill.');
  const projectRoot = fs.realpathSync(f.projectRoot);
  const now = Date.parse('2026-11-24T20:00:00.000Z');
  const portfolio = {
    requests: [],
    projects: [
      {
        root: projectRoot,
        name: 'project',
        unavailable: false,
        registrationIndex: 0,
        activeToday: true,
        advisor: { skill: 'tdd', path: tddPath, session: 'sess-copy', at: now },
      },
    ],
  };
  setDisplayConfig({ theme: 'none', barStyle: 'line', icons: 'text' });
  const state = initialMonitorState();
  state.home.cursor = `home:advisor:${projectRoot}`;
  const frame = renderMonitor({
    state,
    homePortfolio: portfolio,
    width: 100,
    height: 20,
    nowMs: now,
  });

  // Press Enter on the advisor row.
  const enterOut = handleMonitorInput(frame.state, { type: 'key', key: 'enter' }, { frame });
  assert.deepEqual(enterOut.action, {
    type: 'copy-advisor',
    root: projectRoot,
    session: 'sess-copy',
    skill: 'tdd',
    path: tddPath,
  });

  // Left-click the advisor row.
  const pane = frame.panes[0];
  const rowIndex = pane.rows.findIndex((r) => r.item === `home:advisor:${projectRoot}`);
  assert.ok(rowIndex >= 0);
  const clickOut = handleMonitorInput(
    frame.state,
    { type: 'mouse', button: 'left', x: pane.x + 4, y: pane.y + rowIndex },
    { frame }
  );
  assert.deepEqual(clickOut.action, enterOut.action);

  // Execute action: verify OSC 52 sequence, WSL clip.exe fallback, and panel-actions.jsonl entry.
  const written = [];
  const clipped = [];
  const notices = [];
  const actions = createPanelActions(f.hudHome, projectRoot, null, {
    get state() { return frame.state; },
    set state(_value) {},
    isClosed: () => false,
    shownRoot: () => projectRoot,
    projectDisplayRoot: () => projectRoot,
    reloadExp() {},
    collect() {},
    repaint() {},
    notice(msg) { notices.push(msg); },
    boardNotice() {},
    error() {},
    boardInput: () => ({ workboard: undefined }),
    refreshModels() {},
    openSettings() {},
    copyClipboard: (text) =>
      copyToClipboard(text, {
        env: {},
        wsl: true,
        write: (seq) => written.push(seq),
        runClip: (cmd, value) => {
          clipped.push({ cmd, value });
          return true;
        },
      }),
  });
  actions.execute(enterOut.action, frame.state);

  const expectedOsc = `\x1b]52;c;${Buffer.from(tddPath, 'utf8').toString('base64')}\x07`;
  assert.deepEqual(written, [expectedOsc]);
  assert.equal(clipped.length, 1);
  assert.equal(clipped[0].value, tddPath);
  assert.match(clipped[0].cmd, /clip\.exe$/);
  assert.equal(
    osc52Sequence(tddPath, { tmux: true }),
    `\x1bPtmux;\x1b\x1b]52;c;${Buffer.from(tddPath, 'utf8').toString('base64')}\x07\x1b\\`
  );
  assert.ok(notices.some((n) => n.includes('tdd')));

  const actionLog = fs.readFileSync(path.join(f.hudHome, PANEL_ACTIONS_FILE), 'utf8').trim().split('\n');
  assert.equal(actionLog.length, 1);
  const logged = JSON.parse(actionLog[0]);
  assert.equal(logged.type, 'advice-copy');
  assert.equal(logged.session, 'sess-copy');
  assert.equal(logged.skill, 'tdd');
  assert.equal(logged.path, tddPath);
  // Panel copy log must never surface into hud watch / MCP changes.
  assert.equal(panelActionLine(actionLog[0], () => true, projectRoot), undefined);
});

test('skip and dedupe rules hold (skill path skip, 1 per message, 30-min same-session skill dedupe)', async (t) => {
  const f = setupEnv(t);
  const tddPath = writeSkill(f.skillsDir, 'tdd', 'tdd', 'TDD skill.');
  writeSkill(f.skillsDir, 'design', 'codebase-design', 'Deep module design.');
  const api = await fakeDecisionServer(t, (body) => choiceResponse(body, 'tdd'));
  configureStubDecision(f.env, f.hudHome, api.baseUrl);
  fs.writeFileSync(
    f.env.HUD_SETTINGS_PATH,
    JSON.stringify({ advisorShadow: true, advisorSkillDirs: [f.skillsDir] })
  );

  assert.equal(messageNamesSkillPath(`Please follow ${tddPath}`, [f.skillsDir]), true);
  assert.equal(messageNamesSkillPath('Use skills/tdd/SKILL.md for this slice', []), true);
  assert.equal(messageNamesSkillPath('Write tests first for this module', [f.skillsDir]), false);

  const t0 = Date.parse('2026-11-24T20:00:00.000Z');
  // 1) Message naming a skill path skips the Decision API.
  const skipped = await adviseOnMessage(
    f.hudHome,
    { session: 'sess-d', projectRoot: f.projectRoot, message: `Read ${tddPath} and proceed`, messageId: 'm-skip' },
    { env: f.env, now: t0 }
  );
  assert.equal(skipped, undefined);
  assert.equal(api.requests.length, 0);

  // 2) First valid message recommends tdd.
  const first = await adviseOnMessage(
    f.hudHome,
    { session: 'sess-d', projectRoot: f.projectRoot, message: 'Write tests first', messageId: 'm1' },
    { env: f.env, now: t0 }
  );
  assert.equal(first?.skill, 'tdd');
  assert.equal(api.requests.length, 1);

  // 3) Same owner message again -> at most one recommendation per owner message (no second API call).
  const dupMsg = await adviseOnMessage(
    f.hudHome,
    { session: 'sess-d', projectRoot: f.projectRoot, message: 'Write tests first', messageId: 'm1' },
    { env: f.env, now: t0 + 1000 }
  );
  assert.equal(dupMsg, undefined);
  assert.equal(api.requests.length, 1);

  // 4) New message within 30 minutes picking the same skill -> suppressed, no duplicate event.
  const within30 = await adviseOnMessage(
    f.hudHome,
    { session: 'sess-d', projectRoot: f.projectRoot, message: 'Add another test case red-green', messageId: 'm2' },
    { env: f.env, now: t0 + 15 * 60_000 }
  );
  assert.equal(within30, undefined);

  // 5) Different session within 30 minutes -> allowed.
  const otherSession = await adviseOnMessage(
    f.hudHome,
    { session: 'sess-other', projectRoot: f.projectRoot, message: 'Add another test case red-green', messageId: 'm3' },
    { env: f.env, now: t0 + 16 * 60_000 }
  );
  assert.equal(otherSession?.skill, 'tdd');

  // 6) Same session after 30 minutes -> allowed again.
  const after30 = await adviseOnMessage(
    f.hudHome,
    { session: 'sess-d', projectRoot: f.projectRoot, message: 'Back to writing tests first', messageId: 'm4' },
    { env: f.env, now: t0 + ADVISOR_DEDUPE_MS + 1000 }
  );
  assert.equal(after30?.skill, 'tdd');

  const eventsFile = path.join(f.hudHome, 'events', '2026-11.jsonl');
  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.length, 3);
});

test('no session transcript, hook output, or prompt receives advisor text (Claude hook + pi extension + CLI)', async (t) => {
  const f = setupEnv(t);
  writeSkill(f.skillsDir, 'tdd', 'tdd', 'Test-driven development red-green loop.');
  const api = await fakeDecisionServer(t, (body) => choiceResponse(body, 'tdd'));
  configureStubDecision(f.env, f.hudHome, api.baseUrl);
  fs.writeFileSync(
    f.env.HUD_SETTINGS_PATH,
    JSON.stringify({ advisorShadow: true, advisorSkillDirs: [f.skillsDir] })
  );

  // 1) Pi extension: firing input produces recommendation without returning transform/handled or calling sendMessage/notify.
  const handlers = new Map();
  const sentMessages = [];
  const notifications = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage(msg, opts) {
      sentMessages.push({ msg, opts });
    },
    registerCommand() {},
    registerTool() {},
  };
  const sessionFile = path.join(f.home, 'pi-session.jsonl');
  const initialTranscript = JSON.stringify({ type: 'session', version: 3, id: 'pi-main-1', cwd: f.projectRoot }) + '\n';
  fs.writeFileSync(sessionFile, initialTranscript);
  const ctx = {
    mode: 'tui',
    hasUI: true,
    cwd: f.projectRoot,
    ui: { notify: (m) => notifications.push(m) },
    getContextUsage: () => undefined,
    sessionManager: {
      getSessionId: () => 'pi-main-1',
      getSessionDir: () => f.home,
      getSessionFile: () => sessionFile,
      getCwd: () => f.projectRoot,
      getLeafId: () => 'leaf',
      getEntries: () => [],
      getBranch: () => [],
      getHeader: () => ({ type: 'session', id: 'pi-main-1', cwd: f.projectRoot }),
    },
  };
  installPiPackage(pi, { release: process.cwd(), node: process.execPath, hudHome: f.hudHome }, { env: f.env }, 'delegate');
  for (const h of handlers.get('message_end') ?? []) {
    await h({ message: { role: 'assistant', content: [{ type: 'text', text: 'What should we test next?' }] } }, ctx);
  }
  const inputResults = [];
  for (const h of handlers.get('input') ?? []) {
    inputResults.push(await h({ type: 'input', text: 'Let us write red-green tests first.', source: 'interactive' }, ctx));
  }
  // Wait briefly for fire-and-forget Decision API call to settle.
  for (let i = 0; i < 40 && api.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(api.requests.length, 1);
  assert.ok(inputResults.every((r) => r === undefined));
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(notifications, []);
  assert.equal(fs.readFileSync(sessionFile, 'utf8'), initialTranscript);
  const piNotice = readAdvisorNotice(f.hudHome, { session: 'pi-main-1' }, Date.now(), f.env);
  assert.equal(piNotice?.skill, 'tdd');

  // 2) Claude mod hook: turn.start returns next(e) unchanged, never appends or submits prompt, spawns hud advise silently.
  const claudeHandlers = new Map();
  registerAdvisor((event, handler) => {
    claudeHandlers.set(event, handler);
  });
  const spawned = [];
  const appended = [];
  const submitted = [];
  const fakeEngine = {
    env: { get: async (k) => f.env[k] },
    fs: { read: async (p) => fs.readFileSync(p, 'utf8') },
    session: {
      cwd: async () => f.projectRoot,
      root: async () => f.projectRoot,
      append: async (x) => { appended.push(x); return {}; },
    },
    prompt: { submit: async (x) => { submitted.push(x); return {}; } },
    process: {
      run: async (argv, opts) => {
        spawned.push({ argv, opts });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  };
  await claudeHandlers.get('session.start')(fakeEngine, { cwd: f.projectRoot, isInteractive: true }, async (e) => e);
  await claudeHandlers.get('turn.complete')(fakeEngine, { turnId: 't0', answer: 'Ready to implement.' }, async (e) => e);
  const turnEvent = { turnId: 't1', text: 'Write tests first for the parser.' };
  const hookReturn = await claudeHandlers.get('turn.start')(fakeEngine, turnEvent, async (e) => ({ passedThrough: e }));
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(hookReturn, { passedThrough: turnEvent });
  assert.deepEqual(appended, []);
  assert.deepEqual(submitted, []);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].argv[0], 'hud');
  assert.equal(spawned[0].argv[1], 'advise');
  assert.doesNotMatch(JSON.stringify(hookReturn), /tdd|skill:|SKILL\.md|advisor/i);

  // 3) `hud advise` CLI emits zero bytes to stdout/stderr.
  const cliOut = [];
  const cliErr = [];
  const exitCode = await adviseCommand(
    ['--session', 'claude-cli-1', '--project', f.projectRoot, '--turn', 't1', '--message', 'Write tests first for the parser.'],
    { env: f.env, stdout: (s) => cliOut.push(s), stderr: (s) => cliErr.push(s) }
  );
  assert.equal(exitCode, 0);
  assert.equal(cliOut.join(''), '');
  assert.equal(cliErr.join(''), '');

  // 4) Claude statusline shows `skill: tdd` and never mutates the transcript.
  const transcriptFile = path.join(f.home, 'claude-cli-1.jsonl');
  const transcriptBody = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'Write tests first' } }) + '\n';
  fs.writeFileSync(transcriptFile, transcriptBody);
  setDisplayConfig({ theme: 'none', barStyle: 'line', icons: 'text' });
  const bar = stripAnsi(
    await collectAndRenderParity(
      { session_id: 'claude-cli-1', transcript_path: transcriptFile, cwd: f.projectRoot, model: { id: 'claude-opus-4-6' } },
      120,
      paritySettings({}),
      f.env
    )
  );
  assert.match(bar, /skill: tdd/);
  assert.equal(fs.readFileSync(transcriptFile, 'utf8'), transcriptBody);

  // Static check: Claude hook and pi extension outputs contain no advisor injection paths.
  const claudeHookSrc = fs.readFileSync('integrations/claude-mod/hooks/advisor.ts', 'utf8');
  assert.doesNotMatch(claudeHookSrc, /prompt\.submit|session\.append|ui\.toast/);
  assert.equal(scrubSecrets('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk123456'), 'Bearer [REDACTED]');
});

function runAdviseChild(t, argv, env, { stdinMode = 'open', payload, detached = false } = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, argv, {
    env,
    detached,
    stdio: [stdinMode === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  if (stdinMode === 'close') child.stdin.end();
  else if (stdinMode === 'payload') child.stdin.end(Buffer.from(JSON.stringify(payload), 'utf8'));
  const exited = once(child, 'exit').then(([code, signal]) => ({
    code,
    signal,
    stdout,
    stderr,
    elapsedMs: Date.now() - started,
  }));
  return exited;
}

test('hud advise --help and no-stdin invocations exit within 1 s; detached statusline runs stay silent', async (t) => {
  const f = setupEnv(t);
  writeSkill(f.skillsDir, 'tdd', 'tdd', 'Test-driven development red-green loop.');
  const api = await fakeDecisionServer(t, (body) => choiceResponse(body, 'tdd'));
  configureStubDecision(f.env, f.hudHome, api.baseUrl);
  fs.writeFileSync(
    f.env.HUD_SETTINGS_PATH,
    JSON.stringify({ advisorShadow: true, advisorSkillDirs: [f.skillsDir] })
  );

  const hudBin = path.resolve('bin/hud');
  const distBin = path.resolve('bin/hud-dist.mjs');

  for (const argv of [
    [hudBin, 'advise', '--help'],
    [distBin, 'advise', '--help'],
  ]) {
    const res = await runAdviseChild(t, argv, f.env, { stdinMode: 'open' });
    assert.equal(res.code, 0, `${argv.join(' ')} stderr=${res.stderr}`);
    assert.equal(res.signal, null);
    assert.ok(res.elapsedMs < 1000, `${argv.join(' ')} took ${res.elapsedMs}ms`);
    assert.match(res.stdout, /Usage: hud advise/);
    assert.equal(res.stderr, '');
  }

  for (const [argv, stdinMode] of [
    [[hudBin, 'advise'], 'open'],
    [[hudBin, 'advise'], 'ignore'],
    [[hudBin, 'advise', '--stdin'], 'open'],
    [[hudBin, 'advise', '--stdin'], 'close'],
    [[distBin, 'advise'], 'open'],
    [[distBin, 'advise'], 'ignore'],
    [[distBin, 'advise'], 'close'],
  ]) {
    const res = await runAdviseChild(t, argv, f.env, { stdinMode });
    assert.equal(res.code, 0, `${argv.join(' ')} (${stdinMode}) stderr=${res.stderr}`);
    assert.equal(res.signal, null);
    assert.ok(res.elapsedMs < 1000, `${argv.join(' ')} (${stdinMode}) took ${res.elapsedMs}ms`);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, '');
  }

  const detached = await runAdviseChild(t, [distBin, 'advise'], f.env, {
    stdinMode: 'payload',
    detached: true,
    payload: {
      session: 'detached-statusline-1',
      projectRoot: f.projectRoot,
      message: 'Let us write tests first for the parser.',
      messageId: 'turn-detached-1',
    },
  });
  assert.equal(detached.code, 0, detached.stderr);
  assert.equal(detached.signal, null);
  assert.equal(detached.stdout, '');
  assert.equal(detached.stderr, '');
  assert.equal(api.requests.length, 1);
  assert.equal(readAdvisorNotice(f.hudHome, { session: 'detached-statusline-1' }, Date.now(), f.env)?.skill, 'tdd');
});
