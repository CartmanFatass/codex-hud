import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { collectObjectiveEvidence } from '../../dist/collectors/objectives.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { stripAnsi, theme, visualLength } from '../../dist/render/colors.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { collectAll } from '../../docs/design/home-portfolio/gen/current.mjs';
import { buildFixture, NOW } from '../../docs/design/home-portfolio/gen/fixture.mjs';

async function design(t) {
  const fx = await buildFixture();
  t.after(fx.cleanup);
  const ctx = await collectAll(fx, NOW);
  const draw = (width, lang, { icons = 'unicode', colour = 'none', project = ctx.project, name = 'harbor-api', cursor } = {}) => {
    const config = setDisplayConfig({ icons, theme: colour }), language = setLanguage(lang);
    try {
      const state = initialMonitorState();
      state.activeTab = 'project';
      state.project.nav.cursor = cursor;
      return renderMonitor({ state, width, height: 60, nowMs: NOW, workboard: ctx.board, project,
        projectName: name, projects: ctx.portfolio.projects, paneLoad: { running: 2, queued: 0 } });
    } finally { setDisplayConfig(config); setLanguage(language); }
  };
  return { ...fx, ...ctx, draw };
}
const visible = (row) => stripAnsi(row.text).trimEnd();
const enter = (frame) => handleMonitorInput(frame.state, { type: 'key', key: 'enter' }, { frame });

test('Project overview keeps requests and aggregate ticket bars cell-exact across icon sets', async (t) => {
  const f = await design(t);
  for (const width of [40, 50, 80]) for (const lang of ['en', 'zh']) for (const icons of ['unicode', 'nerd', 'text']) {
    const zh = lang === 'zh', frame = f.draw(width, lang, { icons }), rows = frame.workboard.rows, text = rows.map(visible).join('\n');
    assert.ok([...rows.map((r) => r.text), ...frame.lines].every((line) => visualLength(line) === width && !line.includes('\x1b')));
    assert.doesNotMatch(text, /Partial|不完整|This pane|本窗格|Jobs in Project|^任务 /m);
    const request = (frame.workboard.requests ?? []).filter((r) => r.item === 'project:wait:0').map(visible);
    assert.match(request[0], zh ? /rate-limits .*在等你 1天$/ : /rate-limits .*work waits 1d$/);
    assert.match(request.join(' '), /Pick the default burst/);
    for (const [id, ratio] of [['rate-limits', '4/8'], ['ci-speed', '4/6']]) {
      const row = rows.find((r) => r.objectiveTarget?.objective.id === id);
      assert.match(visible(row), new RegExp(`[█░#.]+ +${ratio}`));
    }
    assert.doesNotMatch(text, /sdk-v1|04 limiter config file|docs\/notes\/rate-limits\.md|9f3a1c2/);
    assert.match(frame.lines.join('\n'), zh ? /工单 +文档/ : /Tickets +Docs/);
    assert.ok(!frame.controls.some((c) => c.kind === 'project-page' && c.item === 'tree'));
  }
  const config = setDisplayConfig({ theme: 'mocha' });
  try {
    const bar = f.draw(80, 'en', { colour: 'mocha' }).workboard.rows.find((r) => r.objectiveTarget?.objective.id === 'rate-limits');
    assert.ok(bar.text.includes(theme.board.success('█'.repeat(12))));
    assert.ok(bar.text.includes(theme.board.active('█'.repeat(3))));
    assert.ok(bar.text.includes(theme.board.muted('░'.repeat(9))));
  } finally { setDisplayConfig(config); }
});

test('STATE notes stand in only when there is no Objective record; old results stay off the overview', async (t) => {
  const f = await design(t);
  const load = (root) => new ProjectCollector(root, f.home).collect(true, f.board, NOW);
  const sketch = await load(f.roots.sketch), lab = await load(f.roots.lab);
  assert.equal(sketch.objectives, undefined);
  for (const lang of ['en', 'zh']) {
    const sketchLines = f.draw(40, lang, { project: sketch, name: 'sketchbook' }).workboard.rows.map(visible).join('\n');
    assert.match(sketchLines, lang === 'en' ? /Now ─+\n  Prototype the capture overlay\nNext ─+\n  Pick the colour palette/ : /现在 ─+\n  Prototype the capture overlay\n下一步 ─+\n  Pick the colour palette/);
    assert.doesNotMatch(sketchLines, /Objectives|目标/);
    const labLines = f.draw(50, lang, { project: lab, name: 'tide-lab' }).workboard.rows.map(visible).join('\n');
    assert.match(labLines, /Compare three tokenizers/);
    assert.doesNotMatch(labLines, /Two of three tokenizers/);
  }
});

test('Enter opens request and Objective destinations, with evidence on the Objective page', async (t) => {
  const f = await design(t), objectiveId = `project:objective:${f.own}:rate-limits`;
  const file = join(f.own, 'docs/notes/rate-limits.md');
  mkdirSync(join(f.own, 'docs/notes'), { recursive: true });
  writeFileSync(file, '# Synthetic evidence\n');
  const draw = (cursor) => f.draw(50, 'en', { cursor });
  assert.deepEqual(enter(draw('project:wait:0')).state.project.view, { kind: 'waiting', index: 0, request: 'r1' });
  const opened = enter(draw(objectiveId));
  assert.equal(opened.state.subpage.kind, 'objective');
  assert.deepEqual([opened.state.subpage.target.root, opened.state.subpage.target.objective.id], [f.own, 'rate-limits']);
  const resolved = collectObjectiveEvidence(opened.state.subpage.target.objective, f.own, f.home);
  assert.equal(resolved[0].file, file);
  assert.equal(resolved[1].commit, '9f3a1c2');
  assert.ok(!draw(objectiveId).workboard.rows.some((row) => row.objectiveEvidence || row.item?.startsWith('project:job:')));
});
