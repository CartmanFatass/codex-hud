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

test('Project design: cell-exact, word-wrapped, with per-feature progress and named Details at 40/50/80 in EN/ZH', async (t) => {
  const f = await design(t);
  const objective = (id) => `project:objective:${f.own}:${id}`;
  for (const width of [40, 50, 80]) for (const lang of ['en', 'zh']) for (const icons of ['unicode', 'nerd', 'text']) {
    const zh = lang === 'zh', frame = f.draw(width, lang, { icons }), rows = frame.workboard.rows, text = rows.map(visible).join('\n');
    assert.ok([...rows.map((r) => r.text), ...frame.lines].every((line) => visualLength(line) === width && !line.includes('\x1b')));
    assert.doesNotMatch(text, /Partial|不完整|This pane|本窗格|Jobs in Project|^任务 /m);
    assert.match(text, zh ? /进行中 · 高优先级 · 20分前/ : /active · high priority · (?:updated )?20m ago/);
    const request = (frame.workboard.requests ?? []).filter((r) => r.item === 'project:wait:0').map(visible);
    assert.match(request[0], zh ? /rate-limits .*在等你 1天$/ : /rate-limits .*work waits 1d$/);
    const inline = width === 80 || (width === 50 && zh);
    if (inline) {
      assert.equal(request.length, 1);
      assert.match(request[0], /Pick the default burst/);
    } else {
      assert.equal(request.length, 2);
      assert.match(request[1], /^  Pick the default burst size:/);
    }
    for (const [id, ratio, flag] of [['rate-limits', '4/8', zh ? '受阻' : 'blocked'], ['ci-speed', '4/6', zh ? '进行中' : 'active']]) {
      const lines = rows.filter((r) => r.item === objective(id)).map(visible);
      assert.match(lines[0], new RegExp(`${ratio} ${zh ? '工单' : 'tickets'} ${flag}$`));
      assert.doesNotMatch(lines[0], /[█░#]/);
      const title = lines.slice(1, lines.findIndex((l) => /^ {4}[›>\uF054] /u.test(l)));
      assert.ok(title.length >= 1 && title.length <= 3);
      assert.equal(title.map((line) => line.trim()).join(' '), f.project.objectives.objectives.find((o) => o.id === id).title);
    }
    assert.equal(rows.filter((r) => r.item === objective('sdk-v1')).length, 1);
    assert.match(text, /sdk-v1 Retire the v1 SDK/);
    const n = width === 40 ? 14 : 24, filled = icons === 'text' ? '#' : '█', pending = icons === 'text' ? '.' : '░';
    for (const [feature, ratio, solid] of [['rate-limit-core', '3/5', width === 40 ? 11 : 19], ['quota-headers', '1/3', width === 40 ? 5 : 8], ['ci-cache', '4/6', width === 40 ? 12 : 20]]) {
      const row = rows.map(visible).find((l) => l.startsWith(`    ${feature} `));
      assert.deepEqual(row.trim().split(/ +/).slice(0, 3), [feature, filled.repeat(solid) + pending.repeat(n - solid), ratio]);
    }
    const firstJob = rows.findIndex((r) => r.item === 'project:job:j0000000000000001');
    assert.match(visible(rows[firstJob - 1]), /^    rate-limit-core/);
    assert.match(visible(rows[firstJob]), zh ? /04 limiter config file +14分$/ : /04 limiter config file +14m$/);
    const resultAt = rows.findIndex((r) => visible(r).includes('Token-bucket core shipped;'));
    assert.match(visible(rows[resultAt]), zh ? /4时$/ : /4h$/);
    if (width >= 50) {
      const [first, second] = rows.slice(resultAt, resultAt + 2).map(visible);
      const part = first.replace(/^ {4}. /u, '').replace(/ +4[时h]$/, '');
      const result = [part, second.startsWith('      ') ? second.trim() : ''].filter(Boolean).join(' ');
      assert.equal(result, f.project.objectives.objectives.find((o) => o.id === 'rate-limits').result);
    }
    assert.match(text, /docs\/notes\/rate-limits\.md/);
    assert.match(text, /9f3a1c2/);
    assert.match(text, zh ? /^详情 [-─]+\n工单 +8\/14 完成 · 3 个功能\n进度 +M2 · 2 进行中 · 4 待办\n文档 +规范 M2 · 复审 2天前$/m
      : /^Details [-─]+\nTickets +8\/14 done · 3 features\nProgress +M2 · 2 working · 4 to do\nDocs +spec M2 · review 2d ago$/m);
    assert.ok(!rows.some((r) => r.item === 'project:page:tree'));
  }
  const config = setDisplayConfig({ theme: 'mocha' });
  try {
    const bar = f.draw(40, 'en', { colour: 'mocha' }).workboard.rows.find((r) => visible(r).startsWith('    rate-limit-core'));
    assert.ok(bar.text.includes(theme.board.success('█'.repeat(8))));
    assert.ok(bar.text.includes(theme.board.active('█'.repeat(3))));
    assert.ok(bar.text.includes(theme.board.muted('░'.repeat(3))));
  } finally { setDisplayConfig(config); }
});

test('STATE notes stand in only when there is no Objective record; Project keeps an older result', async (t) => {
  const f = await design(t);
  const load = (root) => new ProjectCollector(root, f.home).collect(true, f.board, NOW);
  const sketch = await load(f.roots.sketch), lab = await load(f.roots.lab);
  assert.equal(sketch.objectives, undefined);
  for (const lang of ['en', 'zh']) {
    const sketchLines = f.draw(40, lang, { project: sketch, name: 'sketchbook' }).workboard.rows.map(visible).join('\n');
    assert.match(sketchLines, lang === 'en' ? /Now ─+\n  Prototype the capture overlay\nNext ─+\n  Pick the colour palette/ : /现在 ─+\n  Prototype the capture overlay\n下一步 ─+\n  Pick the colour palette/);
    assert.doesNotMatch(sketchLines, /Objectives|目标/);
    const labLines = f.draw(50, lang, { project: lab, name: 'tide-lab' }).workboard.rows.map(visible).join('\n');
    assert.match(labLines, lang === 'en' ? /Two of three tokenizers.*6d/ : /Two of three tokenizers.*6天/);
    assert.doesNotMatch(labLines, /Measuring tokenizers/);
  }
});

test('Enter keeps the request, Objective, evidence and job destinations', async (t) => {
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
  for (const [index, { text }] of resolved.entries()) {
    assert.deepEqual(enter(draw(`${objectiveId}:evidence:${index}`)).action, { type: 'open-objective-evidence', root: f.own, text });
  }
  const job = 'j0000000000000001';
  assert.deepEqual(enter(draw(`project:job:${job}`)).action, { type: 'open-files', files: [join(f.home, 'jobs', job, 'brief.md')] });
});
