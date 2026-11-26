import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  ADVISOR_DEDUPE_MS,
  ADVISOR_NOTICE_MS,
  adviseOnMessage,
  adviseOnReply,
  advisorIndexPath,
  advisorStatePath,
  clearAdvisorIndexMemory,
  getSkillIndex,
  messageNamesSkillPath,
  onAdvisorUpdate,
  parseAdvisorRules,
  parseSkillFrontmatter,
  readAdvisorNotice,
  readAdvisorRecommendations,
  readAdvisorRuleHits,
  readAdvisorRuleNotice,
  runBuiltinRuleCheck,
  scrubSecrets,
} from '../../dist/collectors/advisor-shadow.js';
import { AdvisorHistory } from '../../dist/collectors/advisor-history.js';
import { HomePortfolioCollector } from '../../dist/collectors/home-portfolio.js';
import { panelActionLine, PANEL_ACTIONS_FILE } from '../../dist/collectors/panel-actions.js';
import { adviseCommand } from '../../dist/cli/advise.js';
import { installPiPackage } from '../../dist/harness/pi/package-entry.js';
import { createPanelActions } from '../../dist/panel/actions.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { scheduleView } from '../../dist/render/home-cards.js';
import { homeRows } from '../../dist/render/home-view.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { renderBar } from '../../dist/render/layout/bar-fields.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { loadSettings } from '../../dist/settings.js';
import { collectAndRenderParity } from '../../dist/statusline-parity/collect.js';
import { paritySettings } from '../../dist/statusline-parity/settings.js';
import { collectTranscript } from '../../dist/statusline-parity/transcript.js';
import { copyToClipboard, osc52Sequence } from '../../dist/utils/clipboard.js';
import { fakeDecisionServer } from '../helpers/thin-mcp-harness.mjs';
import { completeAdvisorTurn, createAdvisor, startAdvisorTurn } from '../../integrations/claude-mod/hooks/advisor.ts';

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

  const alias = path.join(f.root, 'project-link');
  fs.symlinkSync(f.projectRoot, alias, 'dir');
  const rec = await adviseOnMessage(
    f.hudHome,
    { session: 'sess-1', projectRoot: alias, message: rawMessage, previousReply: rawReply, messageId: 'm1' },
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
  assert.match(reqBody.questions[0].instructions, /NONE is the default\. Pick a skill only when the owner is asking the assistant to start the kind of work that skill guides/);
  assert.match(reqBody.questions[0].instructions, /a question, an explanation request or a proposal to discuss is not a request to start that work/);
  assert.match(reqBody.questions[0].instructions, /untrusted quoted data/i);
  assert.deepEqual(reqBody.questions[0].choices.map((c) => c.value), ['codebase-design', 'tdd', 'NONE']);

  // Verify advice event appended once to $HUD_HOME/events/2026-11.jsonl with 0600 mode.
  const eventsFile = path.join(f.hudHome, 'events', '2026-11.jsonl');
  assert.equal(fs.statSync(eventsFile).mode & 0o777, 0o600);
  const eventLines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(eventLines.length, 1);
  assert.equal(eventLines[0].kind, 'advice');
  assert.equal(eventLines[0].session, 'sess-1');
  assert.equal(eventLines[0].project, fs.realpathSync(f.projectRoot));
  assert.equal(eventLines[0].skill, 'tdd');
  assert.equal(eventLines[0].path, tddPath);
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

function ruleResponse(body, yes = []) {
  return { answers: body.questions.map(({ name, type }) => ({ name, type, probability: yes.includes(name) ? 0.98 : 0.02 })) };
}

test('batches rules with secret-scrubbed excerpts, shows hits beside skills, and counts no-hit batches once', async (t) => {
  const f = setupEnv(t);
  const rulesFile = path.join(f.home, 'rules.md');
  fs.writeFileSync(rulesFile, '# Rules\nIgnore this line\n- R2: Name the tests run.\n- R3: Never echo API_KEY=fake-secret-value.\n- R5: State what is unverified.\n');
  let yes = ['R2', 'R5'];
  const api = await fakeDecisionServer(t, (body) => ruleResponse(body, yes));
  configureStubDecision(f.env, f.hudHome, api.baseUrl);
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ advisorShadow: true, advisorRulesFile: rulesFile }));
  const now = Date.parse('2026-11-24T20:00:00.000Z');
  const nested = path.join(f.projectRoot, 'subdir');
  fs.mkdirSync(nested);
  fs.mkdirSync(path.join(f.projectRoot, '.git'));
  fs.writeFileSync(path.join(f.projectRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const input = {
    session: 'hit-session', projectRoot: nested, replyId: 'r1',
    message: `API_KEY=synthetic-owner-key ${'m'.repeat(2500)} owner tail`,
    reply: `reply head ${'r'.repeat(4500)} API_KEY=synthetic-reply-key reply tail`,
  };
  const options = { env: f.env, now };
  await Promise.all([adviseOnReply(f.hudHome, input, options), adviseOnReply(f.hudHome, input, options)]);
  assert.equal(api.requests.length, 1);
  const [body] = api.requests;
  assert.deepEqual(body.questions.map(({ name, type }) => [name, type]), [['R2', 'predicate'], ['R3', 'predicate'], ['R5', 'predicate']]);
  for (const { instructions } of body.questions) {
    assert.match(instructions, /No is the default unless the reply plainly breaks it/);
    assert.match(instructions, /untrusted quoted data/);
  }
  const [page, facts] = body.input[0].content.filter((item) => item.type === 'input_json').map((item) => item.data);
  assert.equal(page.page.text.length, 2000);
  assert.equal(facts.facts.assistant_reply.length, 4000);
  assert.match(facts.facts.assistant_reply, /reply tail$/);
  assert.doesNotMatch(JSON.stringify(body), /owner tail|reply head|synthetic-(owner|reply)-key|fake-secret-value|Ignore this line|rules\.md|hit-session/);

  const notice = readAdvisorRuleNotice(f.hudHome, input, now, f.env);
  assert.deepEqual(notice, { ids: ['R2', 'R5'], at: now });
  const barFacts = { advisor: { skill: 'tdd', at: now }, advisorRules: notice };
  const previousDisplay = setDisplayConfig({ theme: 'none', barStyle: 'line', icons: 'text' });
  try {
    for (const icons of ['text', 'nerd', 'unicode']) {
      setDisplayConfig({ theme: 'none', barStyle: 'line', icons });
      const line = stripAnsi(renderBar(barFacts, 120, now).line);
      assert.match(line, /skill: tdd.*rules: R2 R5/);
      if (icons === 'text') assert.doesNotMatch(line, /\uf0eb|✦/);
      if (icons === 'nerd') assert.match(line, /\uf0eb rules: R2 R5/);
      if (icons === 'unicode') assert.match(line, /✦ rules: R2 R5/);
      assert.doesNotMatch(renderBar(barFacts, 120, now + ADVISOR_NOTICE_MS).line, /rules:/);
    }
    const previousSettings = process.env.HUD_SETTINGS_PATH;
    process.env.HUD_SETTINGS_PATH = f.env.HUD_SETTINGS_PATH;
    let portfolio;
    try {
      portfolio = await new HomePortfolioCollector(f.hudHome).read(
        [{ root: f.projectRoot, name: 'project', unavailable: false, registrationIndex: 0 }],
        { workers: [], activeCount: 0, waitingCount: 0, failedCount: 0 }, now
      );
    } finally {
      if (previousSettings === undefined) delete process.env.HUD_SETTINGS_PATH;
      else process.env.HUD_SETTINGS_PATH = previousSettings;
    }
    assert.equal(portfolio.projects[0].activeToday, true);
    const rows = homeRows(portfolio, 40, now, 20, false, undefined, { sorted: [], overdue: 0, today: 0 });
    assert.ok(rows.some(({ text }) => /Rule R2: Name the tests run\./.test(text)));
    assert.ok(rows.some(({ text }) => /Rule R5: State what is unverified\./.test(text)));
    assert.ok(rows.every(({ text }) => visualLength(text) === 40));
  } finally {
    setDisplayConfig(previousDisplay);
  }

  yes = [];
  const noHit = { ...input, session: 'different-session', replyId: 'r2' };
  await adviseOnReply(f.hudHome, noHit, options);
  await adviseOnReply(f.hudHome, noHit, options);
  await adviseOnReply(f.hudHome, { ...noHit, replyId: 'r3' }, options);
  assert.equal(api.requests.length, 3);
  assert.equal(readAdvisorRuleNotice(f.hudHome, noHit, now, f.env), undefined);
  const eventsFile = path.join(f.hudHome, 'events', '2026-11.jsonl');
  assert.equal(fs.statSync(eventsFile).mode & 0o777, 0o600);
  const event = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
  const { ms, ...rest } = event;
  assert.ok(Number.isInteger(ms) && ms >= 0);
  assert.deepEqual(rest, { v: 1, kind: 'rule_hits', session: input.session, project: fs.realpathSync(f.projectRoot),
    rules: ['R2', 'R5'], at: new Date(now).toISOString() });
  const counters = path.join(f.hudHome, 'events', 'advisor-counters.json');
  assert.equal(fs.statSync(counters).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(counters, 'utf8')), { '2026-11': { rule_no_hits: 2 } });
});

test('rule checks require an absolute, enabled, readable and bounded file; changed mtime reloads', async (t) => {
  const f = setupEnv(t);
  const rulesFile = path.join(f.home, 'rules.md');
  const api = await fakeDecisionServer(t, (body) => ruleResponse(body));
  configureStubDecision(f.env, f.hudHome, api.baseUrl);
  const configure = (advisorShadow, advisorRulesFile) =>
    fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ advisorShadow, advisorRulesFile }));
  const check = (replyId) => adviseOnReply(f.hudHome, {
    session: 'main', projectRoot: f.projectRoot, message: 'Please run the checks.', reply: 'I did.', replyId,
  }, { env: f.env });
  assert.equal(loadSettings(f.env).advisorRulesFile, '');
  configure(true, './rules.md');
  assert.equal(loadSettings(f.env).advisorRulesFile, '');
  configure(true, rulesFile);
  await check('missing');
  fs.writeFileSync(rulesFile, '- R1: Say what was tested.\n' + 'é'.repeat(4096));
  await check('oversize');
  fs.writeFileSync(rulesFile, Array.from({ length: 31 }, (_, n) => `- R${n + 1}: A synthetic rule.`).join('\n'));
  await check('too-many');
  fs.writeFileSync(rulesFile, '- R1: Say what was tested.\n');
  configure(false, rulesFile);
  await check('off');
  assert.equal(api.requests.length, 0);
  configure(true, rulesFile);
  await check('first');
  const mtime = fs.statSync(rulesFile).mtime;
  fs.writeFileSync(rulesFile, '- R2: Say what was tested.\n');
  fs.utimesSync(rulesFile, mtime, new Date(mtime.getTime() + 1000));
  await check('reloaded');
  assert.deepEqual(api.requests.map(({ questions }) => questions.map(({ name }) => name)), [['R1'], ['R2']]);
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

test('Home recent advice spans sessions and UTC months, expires, caps at five, and copies recorded or indexed skill paths', async (t) => {
  const f = setupEnv(t);
  const previousSettings = process.env.HUD_SETTINGS_PATH;
  process.env.HUD_SETTINGS_PATH = f.env.HUD_SETTINGS_PATH;
  const prevDisplay = setDisplayConfig({ theme: 'none', icons: 'text' }), prevLang = setLanguage('en');
  t.after(() => {
    if (previousSettings === undefined) delete process.env.HUD_SETTINGS_PATH;
    else process.env.HUD_SETTINGS_PATH = previousSettings;
    setDisplayConfig(prevDisplay);
    setLanguage(prevLang);
  });
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, '{"advisorShadow":true}');
  const now = Date.parse('2027-01-01T00:20:00Z'), min = 60_000, day = 24 * 60 * min;
  const other = path.join(f.root, 'other-project');
  const skillPath = '/demo/previous-skills/review/SKILL.md';
  writeSkill(f.skillsDir, 'review', 'review', 'Review a change.');
  const legacyPath = writeSkill(f.skillsDir, 'legacy', 'legacy', 'Legacy skill.');
  getSkillIndex(f.hudHome, [f.skillsDir]);
  const append = (delta, event) => {
    const at = new Date(now + delta).toISOString();
    const dir = path.join(f.hudHome, 'events');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), JSON.stringify({ v: 1, at, ms: 3, ...event }) + '\n');
  };
  append(-5 * min, { kind: 'rule_hits', session: 'a', project: other, rules: ['R3', 'R8'] });
  append(-8 * min, { kind: 'advice', session: 'b', project: f.projectRoot, skill: 'review', path: skillPath });
  append(-6 * min, { kind: 'advice', session: 'a', skill: 'legacy' });
  append(-2 * min, { kind: 'objective', project: other });
  append(min, { kind: 'advice', session: 'c', skill: 'future' });
  append(-30 * min, { kind: 'rule_hits', session: 'c', rules: ['R2'] });
  append(-day, { kind: 'advice', session: 'c', skill: 'Legacy' });
  append(-day - 1, { kind: 'advice', session: 'c', skill: 'expired' });

  const collector = new HomePortfolioCollector(f.hudHome);
  const projects = [{ root: f.projectRoot, name: 'Demo', registrationIndex: 0, unavailable: true }];
  const collect = (at = now) => collector.read(projects, { workers: [] }, at);
  const portfolio = await collect();
  assert.deepEqual(portfolio.recentAdvice.map(e => e.skill ?? e.rules.join(' ')), ['R3 R8', 'legacy', 'review', 'R2', 'Legacy']);
  assert.equal(portfolio.recentAdvice[1].path, legacyPath);
  assert.equal(portfolio.recentAdvice[2].path, skillPath);
  assert.equal((await collect(now + 1)).recentAdvice.length, 4);
  append(-25 * min, { kind: 'advice', session: 'c', skill: 'earlier' });
  assert.deepEqual((await collect()).recentAdvice.map(e => e.skill ?? e.rules.join(' ')), ['R3 R8', 'legacy', 'review', 'earlier', 'R2']);

  const draw = (state = initialMonitorState()) => renderMonitor({ state, homePortfolio: portfolio, width: 40, height: 20, nowMs: now });
  const frame = draw();
  const { rows } = frame.panes[0];
  assert.ok(rows.every(row => visualLength(row.text) === 40));
  assert.ok(!rows.some(row => row.text.includes('Recent advice')), 'Home omits the removed multi-row Recent advice block');
  setLanguage('zh');
  const translated = draw().panes[0].rows;
  assert.ok(!translated.some(row => row.text.includes('近期建议')));
  assert.ok(translated.every(row => visualLength(row.text) === 40));
  setLanguage('en');

  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, '{"advisorShadow":false}');
  const off = await collect();
  const offRows = homeRows(off, 40, now, 20, false, undefined, scheduleView([], now));
  assert.equal(off.recentAdvice, undefined);
  assert.ok(!offRows.some(row => row.text.includes('Recent advice')));
});

test('Home keeps the per-project opt-in Advisor line and never renders the Recent advice block', () => {
  const now = Date.parse('2026-11-24T20:00:00Z'), root = '/demo/project', skillPath = '/demo/skills/live/SKILL.md';
  const portfolio = {
    requests: [],
    projects: [{ root, name: 'Demo', activeToday: true, advisor: { skill: 'live', session: 'live-session', path: skillPath, at: now } }],
    recentAdvice: [{ kind: 'rule_hits', at: now, project: root, session: 'old-session', rules: ['R3'] }],
  };
  const schedule = scheduleView(Array.from({ length: 4 }, (_, id) => ({ id: `due-${id}`, text: 'Review the plan', date: '2026-11-24' })), now);
  const draw = (p, room) => homeRows(p, 50, now, room, false, undefined, schedule);
  const full = draw(portfolio, 20);
  assert.ok(!full.some(r => stripAnsi(r.text).includes('Recent advice') || stripAnsi(r.text).includes('rules: R3')));
  assert.deepEqual(full, draw({ ...portfolio, recentAdvice: undefined }, 20));
  assert.ok(full.some(r => r.advisorCopy?.path === skillPath));
  assert.ok(full.some(r => stripAnsi(r.text).startsWith('Schedule')));
  assert.ok(draw(portfolio, 1).some(r => r.advisorCopy?.path === skillPath));
});

test('recent advice only parses changed monthly tails and ignores truncated lines', (t) => {
  const f = setupEnv(t);
  const previousSettings = process.env.HUD_SETTINGS_PATH;
  process.env.HUD_SETTINGS_PATH = f.env.HUD_SETTINGS_PATH;
  t.after(() => {
    if (previousSettings === undefined) delete process.env.HUD_SETTINGS_PATH;
    else process.env.HUD_SETTINGS_PATH = previousSettings;
  });
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, '{"advisorShadow":true}');
  const now = Date.parse('2026-11-24T20:00:00Z');
  const dir = path.join(f.hudHome, 'events'), file = path.join(dir, '2026-11.jsonl');
  fs.mkdirSync(dir);
  const line = (skill) => JSON.stringify({ v: 1, kind: 'advice', at: new Date(now).toISOString(), session: 'a', skill });
  // The beginning and incomplete end both look like advice but are outside the complete tail.
  const prefix = `${line('beyond-tail')}\n${'x'.repeat(1024 * 1024)}\n`;
  fs.writeFileSync(file, `${prefix}${line('first')}\n${line('in-progress')}`);
  const history = new AdvisorHistory(f.hudHome);
  const [entry, ...others] = history.read(now);
  assert.equal(entry.skill, 'first');
  assert.deepEqual(others, []);
  assert.equal(history.read(now)[0], entry, 'unchanged signature reuses parsed entries');
  const index = advisorIndexPath(f.hudHome);
  fs.mkdirSync(path.dirname(index));
  const replaceIndex = (skillPath) => {
    const staged = `${index}.tmp`;
    fs.writeFileSync(staged, JSON.stringify({ version: 1, dirs: {}, skills: [{ name: 'first', description: 'First skill.', path: skillPath }] }));
    fs.renameSync(staged, index);
  };
  replaceIndex('/demo/skills/first/SKILL.md');
  assert.equal(history.read(now)[0].path, '/demo/skills/first/SKILL.md', 'new index resolves an unchanged event');
  replaceIndex('/demo/skills/moved/SKILL.md');
  assert.equal(history.read(now)[0].path, '/demo/skills/moved/SKILL.md', 'replaced index refreshes the path');
  replaceIndex('relative/SKILL.md');
  assert.equal(history.read(now)[0], entry, 'invalid paths do not survive an index replacement');
  const mtime = fs.statSync(file).mtimeMs;
  fs.writeFileSync(file, `${prefix}${line('newer')}\n${line('in-progress')}`);
  fs.utimesSync(file, new Date(mtime), new Date(mtime + 1_000));
  assert.equal(history.read(now)[0].skill, 'newer', 'same-size replacement with changed mtime reparses');
  fs.appendFileSync(file, '\n');
  assert.deepEqual(history.read(now).map(e => e.skill), ['in-progress', 'newer']);
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
  const advisorRulesFile = path.join(f.home, 'rules.md');
  fs.writeFileSync(advisorRulesFile, '- R2: Name the tests run.\n- R5: State what is unverified.\n');
  const api = await fakeDecisionServer(t, (body) => body.questions[0].type === 'predicate'
    ? ruleResponse(body, ['R2', 'R5']) : choiceResponse(body, 'tdd'));
  configureStubDecision(f.env, f.hudHome, api.baseUrl);
  fs.writeFileSync(
    f.env.HUD_SETTINGS_PATH,
    JSON.stringify({ advisorShadow: true, advisorSkillDirs: [f.skillsDir], advisorRulesFile })
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

  const updated = Promise.withResolvers();
  const unlisten = onAdvisorUpdate(f.hudHome, updated.resolve);
  t.after(unlisten);
  const agentEnd = { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'It is done.' }] }] };
  for (const h of handlers.get('agent_end') ?? []) {
    assert.equal(await h(agentEnd, ctx), undefined);
    assert.equal(await h(agentEnd, ctx), undefined);
  }
  await updated.promise;
  assert.equal(api.requests.length, 2);
  assert.deepEqual(readAdvisorRuleNotice(f.hudHome, { session: 'pi-main-1' }, Date.now(), f.env)?.ids, ['R2', 'R5']);
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(notifications, []);
  assert.equal(fs.readFileSync(sessionFile, 'utf8'), initialTranscript);

  // 2) The Claude advisor spawns hud advise silently, even without session.start.
  const advisor = createAdvisor();
  const spawned = [];
  const appended = [];
  const submitted = [];
  const skillSpawned = Promise.withResolvers();
  const ruleSpawned = Promise.withResolvers();
  f.env.CLAUDE_CODE_SESSION_ID = 'claude-cli-1';
  const fakeEngine = {
    env: { get: async (k) => f.env[k] },
    fs: { read: async (p) => fs.readFileSync(p, 'utf8') },
    session: {
      surfaces: async () => ['terminal'],
      cwd: async () => f.projectRoot,
      root: async () => f.projectRoot,
      append: async (x) => { appended.push(x); return {}; },
    },
    prompt: { submit: async (x) => { submitted.push(x); return {}; } },
    process: {
      run: async (argv, opts) => {
        spawned.push({ argv, opts });
        (argv.includes('--reply') ? ruleSpawned : skillSpawned).resolve(argv);
        return { exitCode: 0, stdout: 'synthetic child output', stderr: '' };
      },
    },
  };
  const turnEvent = { turnId: 't1', text: 'Write tests first for the parser.' };
  await startAdvisorTurn(fakeEngine, advisor, turnEvent);
  assert.deepEqual((await skillSpawned.promise).slice(0, 2), ['hud', 'advise']);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].opts.cwd, f.projectRoot);

  const completed = { turnId: 't1', answer: '--help', reason: 'answer' }; // A reply is data, not a CLI option.
  completeAdvisorTurn(fakeEngine, advisor, completed);
  completeAdvisorTurn(fakeEngine, advisor, completed);
  const ruleArgs = (await ruleSpawned.promise).slice(2);
  assert.equal(spawned.length, 2);
  assert.deepEqual(appended, []);
  assert.deepEqual(submitted, []);

  // 3) Both `hud advise` modes emit zero bytes to stdout/stderr.
  const cliOut = [];
  const cliErr = [];
  const exitCode = await adviseCommand(
    ['--session', 'claude-cli-1', '--project', f.projectRoot, '--turn', 't1', '--message', 'Write tests first for the parser.'],
    { env: f.env, stdout: (s) => cliOut.push(s), stderr: (s) => cliErr.push(s) }
  );
  assert.equal(exitCode, 0);
  assert.equal(await adviseCommand(ruleArgs, { env: f.env, stdout: (s) => cliOut.push(s), stderr: (s) => cliErr.push(s) }), 0);
  assert.equal(api.requests.length, 4);
  assert.equal(cliOut.join(''), '');
  assert.equal(cliErr.join(''), '');

  // 4) Claude statusline shows both notices and never mutates the transcript.
  const transcriptFile = path.join(f.home, 'claude-cli-1.jsonl');
  const transcriptBody = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'Write tests first' } }) + '\n';
  fs.writeFileSync(transcriptFile, transcriptBody);
  setDisplayConfig({ theme: 'none', barStyle: 'line', icons: 'text' });
  const payload = { session_id: 'claude-cli-1', transcript_path: transcriptFile, cwd: f.projectRoot, model: { id: 'claude-opus-4-6' } };
  const bar = stripAnsi(await collectAndRenderParity(payload, 120, paritySettings({}), f.env));
  assert.match(bar, /skill: tdd.*rules: R2 R5/);
  const launched = spawnSync('./bin/hud-statusline', ['--width', '120'], {
    env: { ...f.env, NO_COLOR: '1' }, input: JSON.stringify(payload), encoding: 'utf8', timeout: 7000,
  });
  assert.equal(launched.status, 0, launched.error?.message);
  assert.equal(launched.stderr, '');
  assert.match(launched.stdout, /skill: tdd.*rules: R2 R5/);
  assert.equal(fs.readFileSync(transcriptFile, 'utf8'), transcriptBody);

  // Static check: Claude hook and pi extension outputs contain no advisor injection paths.
  const claudeHookSrc = fs.readFileSync('integrations/claude-mod/hooks/advisor.ts', 'utf8');
  assert.doesNotMatch(claudeHookSrc, /prompt\.submit|session\.append|ui\.toast/);
  assert.equal(scrubSecrets('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk123456'), 'Bearer [REDACTED]');
});

function runAdviseChild(t, argv, env, { stdinMode = 'open', payload, detached = false } = {}) {
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
  return once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
}

test('hud advise skips stdin for help and flags, bounds an empty pipe, and stays silent when detached', async (t) => {
  const f = setupEnv(t);
  const stdin = new PassThrough();
  const getStdin = t.mock.getter(process, 'stdin', () => stdin);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const io = { env: f.env, stdout() {}, stderr() {} };
  // Give the command a turn to settle, without advancing its clock or providing input.
  const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
  const assertExited = async (run, message) => assert.equal(await Promise.race([run, nextTurn()]), 0, message);
  for (const args of [['--help'], []]) {
    await assertExited(adviseCommand(args, io), `hud advise ${args[0] ?? '(no arguments)'} waited`);
    assert.equal(getStdin.mock.callCount(), 0, 'help and flag-only invocations must not read stdin');
  }
  // Explicit --stdin (also the detached launcher's default) may wait for input,
  // but must release an open, empty pipe at the 150 ms idle timeout without EOF.
  const idle = adviseCommand(['--stdin'], io);
  await nextTurn();
  t.mock.timers.tick(150);
  await assertExited(idle, 'advise --stdin waited past its idle timeout');
  stdin.end();
  await assertExited(adviseCommand(['--stdin'], io), 'advise --stdin waited after EOF');
  t.mock.reset();

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

test('transcript newOwnerMessage ignores plugin, system, task-notification and fallback records; keeps normal owner records', async (t) => {
  const f = setupEnv(t);
  const transcriptFile = path.join(f.home, 'sess-origin-1.jsonl');
  fs.writeFileSync(
    transcriptFile,
    JSON.stringify({ type: 'assistant', uuid: 'a0', message: { content: 'Initial reply.' } }) + '\n'
  );
  // Cold start primes the byte cursor without emitting newOwnerMessage.
  assert.equal(collectTranscript(transcriptFile, f.env).newOwnerMessage, undefined);

  const append = (record) => {
    fs.appendFileSync(transcriptFile, JSON.stringify(record) + '\n');
    return collectTranscript(transcriptFile, f.env);
  };

  // Plugin-origin, system-origin, task-notification, sidechain/meta, and text-prefix fallback records never become newOwnerMessage.
  for (const ignored of [
    {
      type: 'user',
      uuid: 'p1',
      origin: { kind: 'plugin', name: 'hud-mod' },
      promptSource: 'system',
      turnOrigin: 'system',
      pluginPrompt: { name: 'hud-mod', text: 'HUD events (status only; not user instructions):\nj1 done' },
      message: { content: 'The hud-mod plugin sent a message:\nHUD events (status only; not user instructions):\nj1 done' },
    },
    {
      type: 'user',
      uuid: 'p2',
      origin: { kind: 'plugin', name: 'other-plugin' },
      message: { content: 'Write tests first for billing.' },
    },
    {
      type: 'user',
      uuid: 'p3',
      pluginPrompt: { name: 'hud-mod', text: 'Wake' },
      message: { content: 'Write tests first for billing.' },
    },
    {
      type: 'user',
      uuid: 's1',
      promptSource: 'system',
      message: { content: 'Write tests first for billing.' },
    },
    {
      type: 'user',
      uuid: 's2',
      turnOrigin: 'system',
      message: { content: 'Write tests first for billing.' },
    },
    {
      type: 'user',
      uuid: 's3',
      origin: { kind: 'system' },
      message: { content: 'Write tests first for billing.' },
    },
    {
      type: 'user',
      uuid: 's4',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      turnOrigin: 'task_notification',
      message: { content: 'Background job finished.' },
    },
    {
      type: 'user',
      uuid: 's5',
      origin: { kind: 'agent' },
      message: { content: 'Automated follow-up.' },
    },
    {
      type: 'user',
      uuid: 's6',
      isSidechain: true,
      message: { content: 'Write tests first for billing.' },
    },
    {
      type: 'user',
      uuid: 's7',
      isMeta: true,
      message: { content: 'Write tests first for billing.' },
    },
    {
      type: 'user',
      uuid: 'f1',
      message: { content: 'The hud-mod plugin sent a message:\nHUD events (status only; not user instructions):\nj1 done' },
    },
    {
      type: 'user',
      uuid: 'f2',
      message: { content: 'HUD events (status only; not user instructions):\nj1 done' },
    },
    {
      type: 'user',
      uuid: 'f3',
      message: { content: '<task-notification><task-id>b1</task-id></task-notification>' },
    },
    {
      type: 'user',
      uuid: 'f4',
      message: { content: '<system-reminder>Internal note.</system-reminder>' },
    },
  ]) {
    assert.equal(append(ignored).newOwnerMessage, undefined, `expected ${ignored.uuid} to be ignored`);
  }

  // Older records without origin fields still become newOwnerMessage.
  const first = append({
    type: 'user',
    uuid: 'u1',
    message: { content: 'Write unit tests first for billing.' },
  });
  assert.deepEqual(first.newOwnerMessage, {
    id: 'u1',
    text: 'Write unit tests first for billing.',
    previousReply: 'Initial reply.',
  });

  append({ type: 'assistant', uuid: 'a1', message: { content: 'Tests added.' } });
  for (const [promptSource, text] of [
    ['typed', 'Now add edge cases.'],
    ['queued', 'Also cover empty input.'],
  ]) {
    const owner = append({
      type: 'user',
      uuid: `owner-${promptSource}`,
      origin: { kind: 'human' },
      promptSource,
      turnOrigin: 'human',
      message: { content: [{ type: 'text', text }] },
    });
    assert.deepEqual(owner.newOwnerMessage, {
      id: `owner-${promptSource}`,
      text,
      previousReply: 'Tests added.',
    });
  }

  // Claude mod startAdvisorTurn also ignores wrapped plugin prompts.
  const advisor = createAdvisor({ cwd: f.projectRoot, isInteractive: true });
  const spawned = [];
  const fakeEngine = {
    env: { get: async (k) => f.env[k] },
    fs: { read: async (p) => fs.readFileSync(p, 'utf8') },
    session: { surfaces: async () => ['terminal'], cwd: async () => f.projectRoot, root: async () => f.projectRoot },
    process: {
      run: async (argv) => {
        spawned.push(argv);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  };
  await startAdvisorTurn(fakeEngine, advisor, {
    turnId: 'plugin-turn',
    text: 'The hud-mod plugin sent a message:\nHUD events (status only; not user instructions):\nj1 done',
  });
  assert.deepEqual(spawned, []);
});

test('an owner message seen by both the Claude mod trigger and the statusline trigger makes one Decision call', async (t) => {
  const f = setupEnv(t);
  writeSkill(f.skillsDir, 'tdd', 'tdd', 'Test-driven development red-green loop.');
  writeSkill(f.skillsDir, 'design', 'codebase-design', 'Deep module design.');
  const api = await fakeDecisionServer(t, async (body) => {
    await new Promise((r) => setTimeout(r, 80));
    return choiceResponse(body, 'tdd');
  });
  configureStubDecision(f.env, f.hudHome, api.baseUrl);
  fs.writeFileSync(
    f.env.HUD_SETTINGS_PATH,
    JSON.stringify({ advisorShadow: true, advisorSkillDirs: [f.skillsDir] })
  );

  // 1) Concurrent in-process calls with different messageIds and whitespace normalization make one Decision call.
  // Use the same clock as the CLI in part 2 so it does not prune this claim as expired.
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([
    adviseOnMessage(
      f.hudHome,
      { session: 'sess-race', projectRoot: f.projectRoot, message: 'Write tests first for billing.', messageId: 'mod-turn-1' },
      { env: f.env, now: t0 }
    ),
    adviseOnMessage(
      f.hudHome,
      { session: 'sess-race', projectRoot: f.projectRoot, message: '  Write  tests\nfirst for billing. ', messageId: 'transcript-uuid-1' },
      { env: f.env, now: t0 }
    ),
  ]);
  assert.equal(api.requests.length, 1);
  assert.equal([r1, r2].filter(Boolean).length, 1);

  // 2) End-to-end: Claude mod turn.start + statusline transcript trigger racing for the same owner message make one Decision call.
  const sessionId = 'sess-both-1';
  const transcriptFile = path.join(f.home, `${sessionId}.jsonl`);
  fs.writeFileSync(
    transcriptFile,
    JSON.stringify({ type: 'assistant', uuid: 'a0', message: { content: 'Ready.' } }) + '\n'
  );
  const statuslinePayload = {
    session_id: sessionId,
    transcript_path: transcriptFile,
    cwd: f.projectRoot,
    model: { id: 'claude-opus-4-6' },
  };
  // Cold start primes the transcript cursor (no advisor call).
  await collectAndRenderParity(statuslinePayload, 120, paritySettings({}), f.env);
  assert.equal(api.requests.length, 1);

  const ownerText = 'Let us write red-green tests first for the parser.';
  fs.appendFileSync(
    transcriptFile,
    JSON.stringify({ type: 'user', uuid: 'transcript-uuid-2', message: { content: ownerText } }) + '\n'
  );

  const modEnv = { ...f.env, CLAUDE_CODE_SESSION_ID: sessionId };
  const modDone = Promise.withResolvers();
  const advisor = createAdvisor({ cwd: f.projectRoot, isInteractive: true });
  const fakeEngine = {
    env: { get: async (k) => modEnv[k] },
    fs: { read: async (p) => fs.readFileSync(p, 'utf8') },
    session: { surfaces: async () => ['terminal'], cwd: async () => f.projectRoot, root: async () => f.projectRoot },
    process: {
      run: async (argv) => {
        // Run the real `hud advise` CLI path that the mod invokes.
        const exitCode = await adviseCommand(argv.slice(2), { env: modEnv, stdout: () => {}, stderr: () => {} });
        modDone.resolve(exitCode);
        return { exitCode, stdout: '', stderr: '' };
      },
    },
  };

  // Trigger both statusline (detached `hud-dist.mjs advise`) and Claude mod (`startAdvisorTurn`) for the same message.
  await Promise.all([
    collectAndRenderParity(statuslinePayload, 120, paritySettings({}), f.env),
    startAdvisorTurn(fakeEngine, advisor, { turnId: 'mod-turn-2', text: `  ${ownerText}\n` }),
  ]);
  assert.equal(await modDone.promise, 0);
  // Wait for any detached statusline child to finish and confirm only one Decision call occurred for this message.
  for (let i = 0; i < 40 && !readAdvisorNotice(f.hudHome, { session: sessionId }, Date.now(), f.env); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(api.requests.length, 2, 'mod + statusline triggers for one owner message must make only one Decision call');
  assert.equal(readAdvisorNotice(f.hudHome, { session: sessionId }, Date.now(), f.env)?.skill, 'tdd');
  const saved = JSON.parse(fs.readFileSync(advisorStatePath(f.hudHome), 'utf8'));
  assert.equal(saved.messages.length, 2, 'advisor-state.json should record each owner message once');
});

test('parseAdvisorRules handles built-in checks, skips unknown checks as invalid, and keeps 30-rule bound', () => {
  const parsed = parseAdvisorRules([
    '# Owner rules',
    'Ignored prose line',
    '- R1 (check: chinese-reply): Reply to the owner in Simplified Chinese.',
    '- R2: Name the checks you ran.',
    '- R3 (check: bogus-check): Should be skipped as invalid.',
    '- R4 (check: no-secrets): Never print raw credentials.',
    '- R5 (check: ): Empty check name is also invalid.',
    '- R1: Duplicate ID keeps first entry.',
    '- R6 (check: chinese-reply):   ',
  ].join('\n'));
  assert.equal(parsed.invalid, 2);
  assert.deepEqual(parsed.rules, [
    { id: 'R1', sentence: 'Reply to the owner in Simplified Chinese.', check: 'chinese-reply' },
    { id: 'R2', sentence: 'Name the checks you ran.' },
    { id: 'R4', sentence: 'Never print raw credentials.', check: 'no-secrets' },
  ]);

  // 30 matched rule lines (including invalid-check lines) stay within bound; 31 disables rule checks.
  const atLimit = [
    ...Array.from({ length: 29 }, (_, n) => `- R${n + 1}: Rule ${n + 1}.`),
    '- R30 (check: unknown): Invalid check counted toward bound.',
  ].join('\n');
  const parsedLimit = parseAdvisorRules(atLimit);
  assert.equal(parsedLimit.rules.length, 29);
  assert.equal(parsedLimit.invalid, 1);

  const overLimit = `${atLimit}\n- R31 (check: no-secrets): Over the 30-rule limit.`;
  assert.deepEqual(parseAdvisorRules(overLimit), { rules: [], invalid: 0 });
});

test('chinese-reply built-in check strips code/paths/tokens and enforces letter and Han thresholds', () => {
  // Chinese reply packed with code names, paths, URLs, env assignments, inline code and fenced code -> pass.
  const chineseWithCode = [
    '已完成修改：在 `src/collectors/advisor-shadow.ts` 中新增了 parseAdvisorRules 和 runBuiltinRuleCheck，',
    '支持 chinese-reply 与 no-secrets，保留 rule_hits 事件与 advisor-counters.json 计数。',
    '路径 src/collectors/advisor-shadow.ts:654-790 与 tests/unit/advisor-shadow.test.mjs 已验证，',
    '设置了 HUD_HOME=/tmp/hud-test 和 OPENAI_BASE_URL=http://127.0.0.1:8080，参考 https://example.com/docs/advisor-rules 。',
    '```ts',
    'export function veryLongEnglishHelperName(inputText: string): boolean {',
    '  // This fenced block has plenty of English prose that must be ignored completely.',
    '  return inputText.length > 0;',
    '}',
    '```',
  ].join('\n');
  assert.equal(runBuiltinRuleCheck('chinese-reply', chineseWithCode), false);

  // Plain English paragraph -> hit.
  const englishParagraph =
    'I updated the advisor shadow rules parser to support deterministic local checks and merged their hits with the model results.';
  assert.equal(runBuiltinRuleCheck('chinese-reply', englishParagraph), true);

  // English paragraph with a tiny Chinese quote (< 30% Han) -> hit.
  const mostlyEnglish =
    'I checked the rule for "中文回复" and confirmed that an English explanation paragraph still triggers the deterministic check.';
  assert.equal(runBuiltinRuleCheck('chinese-reply', mostlyEnglish), true);

  // Very short English reply (< 40 letters) -> no verdict (pass).
  assert.equal(runBuiltinRuleCheck('chinese-reply', 'Done. All checks passed.'), false);

  // Short English intro with large fenced code block -> no verdict (pass).
  const shortWithFence = [
    'Here is the patch:',
    '~~~js',
    'function explainEverythingInEnglish() {',
    '  return "This entire block is inside a tilde fence and has far more than forty letters.";',
    '}',
    '~~~',
  ].join('\n');
  assert.equal(runBuiltinRuleCheck('chinese-reply', shortWithFence), false);

  // Only URLs, paths and KEY=value -> no verdict (pass).
  const tokensOnly = [
    'https://example.com/very/long/documentation/path/with/many/english/words',
    'src/collectors/advisor-shadow.ts:10-20',
    'ADVISOR_RULES_FILE=/home/user/project/rules.md',
  ].join('\n');
  assert.equal(runBuiltinRuleCheck('chinese-reply', tokensOnly), false);

  // Exact boundaries: 39 letters -> pass; 40 letters -> hit; 70 letters + 30 Han (30%) -> pass; 70 + 29 -> hit.
  assert.equal(runBuiltinRuleCheck('chinese-reply', `${'a'.repeat(39)}`), false);
  assert.equal(runBuiltinRuleCheck('chinese-reply', `${'a'.repeat(40)}`), true);
  assert.equal(runBuiltinRuleCheck('chinese-reply', `${'a'.repeat(70)} ${'中'.repeat(30)}`), false);
  assert.equal(runBuiltinRuleCheck('chinese-reply', `${'a'.repeat(70)} ${'中'.repeat(29)}`), true);
});

test('no-secrets built-in check reuses scrubSecrets and ignores env names, credential paths and masked values', () => {
  // Real synthetic secrets -> hit.
  for (const leaky of [
    'Key is sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    'Token: ghp_abcdefghijklmnopqrstuvwxyz123456',
    'Authorization: Bearer synthetic_bearer_token_value_12345',
    'JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk123456',
    'Connect to https://alice:supersecretpass@example.com/repo',
    'OPENAI_API_KEY=synthetic-secret-value-12345',
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ\n-----END PRIVATE KEY-----',
  ]) {
    assert.equal(runBuiltinRuleCheck('no-secrets', leaky), true, `expected hit for: ${leaky}`);
  }

  // Env var names, credential file paths, and masked values -> pass.
  for (const safe of [
    'Set OPENAI_API_KEY and ANTHROPIC_API_KEY before running.',
    'Export OPENAI_API_KEY=${OPENAI_API_KEY} or API_KEY=$MY_API_KEY.',
    'Read TOKEN=process.env.GITHUB_TOKEN in the worker.',
    'Keys are stored in ~/.hud/credentials.env and $HUD_HOME/credentials.env.',
    'SECRET_FILE=/home/user/.hud/credentials.env.',
    'PRIVATE_KEY: ~/.ssh/id_ed25519,',
    'TOKEN_PATH=./credentials.env',
    'API_KEY=[REDACTED].',
    '(API_KEY=[REDACTED])',
    'API_KEY=********',
    'API_KEY=sk-****1234',
    'API_KEY=sk-proj-...1234',
    'API_KEY=••••••1234',
    'API_KEY=<your-api-key>.',
    'Bearer [REDACTED]',
    'Bearer sk-proj-...1234567890',
    'https://alice:****@example.com/repo',
    'https://alice:[REDACTED]@example.com/repo',
  ]) {
    assert.equal(runBuiltinRuleCheck('no-secrets', safe), false, `expected pass for: ${safe}`);
    assert.equal(scrubSecrets(safe), safe, `scrubSecrets should leave safe text unchanged: ${safe}`);
  }
});

test('adviseOnReply merges local check hits with model hits, skips unknown checks, and counts no-hit replies once', async (t) => {
  const f = setupEnv(t);
  const rulesFile = path.join(f.home, 'rules.md');
  fs.writeFileSync(rulesFile, [
    '- R1 (check: chinese-reply): Reply in Simplified Chinese.',
    '- R2: Name the tests run.',
    '- R3 (check: unknown-check): Invalid rule must not go to the model.',
    '- R4 (check: no-secrets): Never print secrets.',
    '- R5: State what is unverified.',
  ].join('\n') + '\n');

  let yes = ['R2'];
  let failApi = false;
  const api = await fakeDecisionServer(t, (body) => (failApi ? { status: 500, body: { error: 'boom' } } : ruleResponse(body, yes)));
  configureStubDecision(f.env, f.hudHome, api.baseUrl);
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ advisorShadow: true, advisorRulesFile: rulesFile }));

  const now = Date.parse('2026-11-25T08:00:00.000Z');
  let listenerCalls = 0;
  const unlisten = onAdvisorUpdate(f.hudHome, () => { listenerCalls += 1; });
  t.after(unlisten);

  // 1) Mixed hit: R1 (local chinese-reply) + R2 (model) + R4 (local no-secrets) merge into one notice/event in file order.
  await adviseOnReply(f.hudHome, {
    session: 'mix-sess',
    projectRoot: f.projectRoot,
    replyId: 'r-mix-hit',
    message: 'Please explain the change.',
    reply: 'I updated the parser and leaked sk-proj-abcdefghijklmnopqrstuvwxyz123456 directly in the reply text.',
  }, { env: f.env, now });

  assert.equal(api.requests.length, 1);
  // Only model-judged rules (R2, R5) are sent; check-based (R1, R4) and unknown (R3) are excluded.
  assert.deepEqual(api.requests[0].questions.map(({ name }) => name), ['R2', 'R5']);
  assert.equal(listenerCalls, 1);

  const notice = readAdvisorRuleNotice(f.hudHome, { session: 'mix-sess' }, now, f.env);
  assert.deepEqual(notice, { ids: ['R1', 'R2', 'R4'], at: now });
  const hits = readAdvisorRuleHits(f.hudHome, now, f.env);
  assert.deepEqual(hits[0].rules, [
    { id: 'R1', sentence: 'Reply in Simplified Chinese.' },
    { id: 'R2', sentence: 'Name the tests run.' },
    { id: 'R4', sentence: 'Never print secrets.' },
  ]);

  const eventsFile = path.join(f.hudHome, 'events', '2026-11.jsonl');
  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].rules, ['R1', 'R2', 'R4']);

  // 2) Mixed no-hit reply increments rule_no_hits exactly once.
  yes = [];
  await adviseOnReply(f.hudHome, {
    session: 'mix-clean',
    projectRoot: f.projectRoot,
    replyId: 'r-mix-clean',
    message: '请说明修改内容。',
    reply: '已在 advisor-shadow.ts 中更新解析器并通过了单测，环境变量 OPENAI_API_KEY 保持在 ~/.hud/credentials.env。',
  }, { env: f.env, now });
  assert.equal(api.requests.length, 2);
  assert.equal(readAdvisorRuleNotice(f.hudHome, { session: 'mix-clean' }, now, f.env), undefined);
  const countersFile = path.join(f.hudHome, 'events', 'advisor-counters.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(countersFile, 'utf8')), { '2026-11': { rule_no_hits: 1 } });

  // 3) Mixed rules with Decision failure: no local hit does NOT increment rule_no_hits; local hit STILL records notice.
  failApi = true;
  await adviseOnReply(f.hudHome, {
    session: 'mix-fail-clean',
    projectRoot: f.projectRoot,
    replyId: 'r-fail-clean',
    message: '请检查。',
    reply: '已完成检查，没有发现问题。',
  }, { env: f.env, now });
  assert.deepEqual(JSON.parse(fs.readFileSync(countersFile, 'utf8')), { '2026-11': { rule_no_hits: 1 } });

  await adviseOnReply(f.hudHome, {
    session: 'mix-fail-local-hit',
    projectRoot: f.projectRoot,
    replyId: 'r-fail-local-hit',
    message: 'Check keys.',
    reply: 'Found OPENAI_API_KEY=synthetic-secret-value-99999 in output.',
  }, { env: f.env, now });
  assert.deepEqual(readAdvisorRuleNotice(f.hudHome, { session: 'mix-fail-local-hit' }, now, f.env), { ids: ['R4'], at: now });
});

test('adviseOnReply makes no Decision call when only check-based or invalid-check rules remain', async (t) => {
  const f = setupEnv(t);
  const rulesFile = path.join(f.home, 'rules.md');
  fs.writeFileSync(rulesFile, [
    '- R1 (check: chinese-reply): Reply in Simplified Chinese.',
    '- R2 (check: no-secrets): Never print secrets.',
    '- R3 (check: unknown): Skipped invalid check.',
  ].join('\n') + '\n');

  const api = await fakeDecisionServer(t, (body) => ruleResponse(body, ['R1']));
  configureStubDecision(f.env, f.hudHome, api.baseUrl);
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ advisorShadow: true, advisorRulesFile: rulesFile }));
  const now = Date.parse('2026-11-25T08:05:00.000Z');

  // Hit on R1 with zero Decision calls.
  await adviseOnReply(f.hudHome, {
    session: 'local-only-hit',
    projectRoot: f.projectRoot,
    replyId: 'r-local-1',
    message: 'What changed?',
    reply: 'I refactored the entire rules parser and added deterministic checks that run completely offline without calling any model.',
  }, { env: f.env, now });
  assert.equal(api.requests.length, 0);
  assert.deepEqual(readAdvisorRuleNotice(f.hudHome, { session: 'local-only-hit' }, now, f.env), { ids: ['R1'], at: now });
  const hits = readAdvisorRuleHits(f.hudHome, now, f.env);
  assert.deepEqual(hits[0].rules, [{ id: 'R1', sentence: 'Reply in Simplified Chinese.' }]);

  // No-hit reply counts once with zero Decision calls.
  await adviseOnReply(f.hudHome, {
    session: 'local-only-clean',
    projectRoot: f.projectRoot,
    replyId: 'r-local-2',
    message: '改了什么？',
    reply: '已在 advisor-shadow.ts 加上内置检查并跑完测试，所有规则本地完成。',
  }, { env: f.env, now });
  assert.equal(api.requests.length, 0);
  const countersFile = path.join(f.hudHome, 'events', 'advisor-counters.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(countersFile, 'utf8')), { '2026-11': { rule_no_hits: 1 } });

  // File with only an unknown check makes zero Decision calls and does not increment no-hit counter.
  const mtime = fs.statSync(rulesFile).mtime;
  fs.writeFileSync(rulesFile, '- R9 (check: nope): Unknown check only.\n');
  fs.utimesSync(rulesFile, mtime, new Date(mtime.getTime() + 1000));
  await adviseOnReply(f.hudHome, {
    session: 'invalid-only',
    projectRoot: f.projectRoot,
    replyId: 'r-invalid-only',
    message: 'Hello',
    reply: 'Plain English reply that is definitely longer than forty characters to prove no check ran.',
  }, { env: f.env, now });
  assert.equal(api.requests.length, 0);
  assert.equal(readAdvisorRuleNotice(f.hudHome, { session: 'invalid-only' }, now, f.env), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(countersFile, 'utf8')), { '2026-11': { rule_no_hits: 1 } });
});
