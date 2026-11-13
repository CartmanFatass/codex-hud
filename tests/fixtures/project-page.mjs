/** Synthetic Project facts collected from disk, never an owner's home. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi } from '../../dist/render/colors.js';
export const NOW = Date.parse('2026-11-12T12:35:00Z');
export const TREE = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(NOW) };
export async function projectFixture(root) {
  const cwd = join(root, 'project'), hud = join(root, 'hud'), home = join(root, 'home'), bin = join(root, 'bin');
  const env = { HOME: home, HUD_HOME: hud, PATH: bin, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude') };
  const put = (path, text, age = 0) => {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(text));
    fs.utimesSync(path, new Date(NOW - age * 60000), new Date(NOW - age * 60000));
  };
  put(join(cwd, 'docs/handoff/STATE.md'), '# State\n\nMilestone: M3b · AI-THIN\n\n## Waiting for the owner\n\n- Try the Project tab\n- Choose the browser profile\n  after trying the synthetic setup\n\n## Next\n- NATIVE-TREE: native subagents on Home\n  beside package lanes\n- PROGRESS-BOARD: project progress\n- Try the milestone\n- Review the milestone\n- Later follow-up\n\n## Slices\n\n<!-- One line per synthetic slice; this comment is ignored. -->\n- working · M3b · NATIVE-TREE · native subagents on Home, one lane per main session\n- working · M4 · ORPHAN · a working slice without a worktree\n- blocked · M4 · BLOCKED · waiting for a synthetic prerequisite\n- try · M3b · LANDING · a landed slice (1234567)\n- accepted · M3 · SHIPPED · an accepted slice (2345678)\n- todo · M4 · QUEUE · a later slice\n- dropped · M4 · RETIRED · a dropped slice\n- mystery · M4 · INVISIBLE · an unknown state must not count\n\n## Now (2026-11-12): Synthetic milestone closing; pages building in worktrees\n\n## Later\n- Never show this unrelated bullet\n');
  put(join(cwd, 'docs/spec.md'), '# Synthetic spec\n\n## 5. Milestones\n\n- **M1, usable**\n- **M2, clean**\n- **M3, extend**\n- **M3b, AI-THIN**\n  - **NOT-A-MILESTONE, nested**\n- **M4, project view**\n\n## 6. Other\n- **M5, not in the ladder**\n');
  put(join(cwd, 'docs/reviews/2026-11-11-review.md'), '# Older review', 120);
  put(join(cwd, 'docs/reviews/2026-11-12-review.md'), 'Verdict: accept', 30);
  put(join(cwd, 'hud-convention.md'), '# Project convention');
  // Unregistered `.hud/` must not load. The control plane only notes that it was ignored.
  put(join(cwd, '.hud/roles/secret.json'), { role: 'secret', harness: 'pi', pi_role: 'implementer', split: false, can_continue: true, model: 'NEVER_RENDER_PROJECT_ROLE' });
  put(join(cwd, '.hud/project.json'), { version: 1, roles: ['secret'] });
  put(join(cwd, '.hud/hud-convention.md'), 'NEVER_RENDER_PROJECT_CONVENTION');
  put(join(cwd, 'CLAUDE.md'), '# Claude instructions');
  put(join(cwd, 'AGENTS.md'), '# Agent instructions');
  put(join(hud, 'roles/imp.json'), { role: 'imp', harness: 'pi', pi_role: 'implementer', split: true, can_continue: true });
  put(join(hud, 'roles/bad.json'), '{ NEVER_RENDER_ROLE_FILE');
  put(join(root, 'roles/implementer.md'), '---\nmodel: synthetic/model\nthinking: high\n---\nRole text\n');
  put(join(bin, 'pi-role'), '#!/bin/sh\nexit 99\n');
  fs.chmodSync(join(bin, 'pi-role'), 0o700);
  put(join(home, '.claude/agents/user-agent.md'), '# Synthetic user agent');
  put(join(cwd, '.claude/agents/project-agent.md'), '# Synthetic project agent');
  put(join(home, '.codex/agents/codex-agent.toml'), 'model = "synthetic"');
  put(join(hud, 'credentials.env'), '# Synthetic names and values only\nMISTRAL_API_KEY=NEVER_RENDER_MISTRAL_VALUE\nOPENAI_API_KEY=""\nTYPESAFE_API_KEY=NEVER_RENDER_TYPESAFE_VALUE\nexport SYNTHETIC_KEY=NEVER_RENDER_OTHER_VALUE\n');
  for (const name of ['google-chrome', 'jev-ask']) {
    put(join(bin, name), '#!/bin/sh\nexit 99\n');
    fs.chmodSync(join(bin, name), 0o700);
  }
  const id = 'j0000000000000001', job = join(hud, 'jobs', id);
  put(join(job, 'job.json'), { job: id, role: 'imp', cwd, herdr_pane: 'w4E:p1', package: 'M4-PROJECT', created_at: new Date(NOW - 20 * 60000).toISOString() });
  put(join(job, 'STATUS.json'), { state: 'working', started_at: new Date(NOW - 20 * 60000).toISOString() });
  put(join(job, 'brief.md'), '# Build the Project tab');
  const lanes = readThinJobs(hud, { project: cwd, pane: 'w4E:p1' });
  const board = { revision: 'synthetic', lanes, workers: lanes.flatMap((l) => l.workers), decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: cwd } };
  // A real, entirely synthetic Git repository; no git commit command or user config.
  const object = (kind, text) => {
    const bytes = Buffer.from(`${kind} ${Buffer.byteLength(text)}\0${text}`), hash = createHash('sha1').update(bytes).digest('hex');
    const path = join(cwd, '.git/objects', hash.slice(0, 2), hash.slice(2));
    fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, deflateSync(bytes));
    return hash;
  };
  const tree = object('tree', ''), stamp = NOW / 1000 - 7200;
  const hash = object('commit', `tree ${tree}\nauthor Synthetic <synthetic@invalid> ${stamp} +0000\ncommitter Synthetic <synthetic@invalid> ${stamp} +0000\n\nSynthetic Project baseline\n`);
  put(join(cwd, '.git/HEAD'), 'ref: refs/heads/synthetic-project\n');
  put(join(cwd, '.git/refs/heads/synthetic-project'), hash + '\n');
  put(join(cwd, '.git/info/exclude'), '.hud/\n');
  const linked = ['NATIVE-TREE', 'NO-JOB'].map((name) => {
    const path = join(root, name), admin = join(cwd, '.git/worktrees', name);
    put(join(path, '.git'), `gitdir: ${admin}\n`);
    put(join(admin, 'gitdir'), join(path, '.git') + '\n');
    put(join(admin, 'commondir'), '../..\n');
    put(join(admin, 'HEAD'), `ref: refs/heads/wt/${name}\n`);
    put(join(cwd, '.git/refs/heads/wt', name), hash + '\n');
    return path;
  });
  const sliceJob = join(hud, 'jobs/j0000000000000002');
  put(join(sliceJob, 'job.json'), { job: 'j0000000000000002', role: 'imp', cwd: linked[0], herdr_pane: 'w4E:p1', created_at: new Date(NOW - 12 * 60000).toISOString() });
  put(join(sliceJob, 'STATUS.json'), { state: 'working', started_at: new Date(NOW - 12 * 60000).toISOString() });
  put(join(sliceJob, 'qa/q1.md'), 'Question: Which synthetic option?');
  put(join(sliceJob, 'brief.md'), '# NATIVE-TREE: synthetic subagents');
  put(join(sliceJob, 'report.md'), '# Synthetic progress report');
  board.lanes = readThinJobs(hud, { project: cwd, pane: 'w4E:p1' });
  board.workers = board.lanes.flatMap((l) => l.workers);
  const collector = new ProjectCollector(cwd, hud, env, home);
  const data = await collector.collect(true, board, NOW);
  const render = (width, lang = 'en', state = { ...initialMonitorState(), mainTab: 'project', projectFolded: new Set(['agents']) }, height = 56, snapshot = data, modelEnabled = true, icons = 'unicode', theme = 'none') => {
    const display = setDisplayConfig({ theme, icons }), previous = setLanguage(lang);
    try { return renderMonitor({ tree: TREE, workboard: board, project: snapshot, state, width, height, nowMs: NOW, modelEnabled }); }
    finally { setDisplayConfig(display); setLanguage(previous); }
  };
  return { cwd, hud, home, env, put, board, collector, data, render, job, linked, sliceJob };
}
export const plain = (frame) => frame.lines.map((s) => stripAnsi(s).trimEnd());
export function projectFrames(f) {
  return Object.fromEntries([80, 120].flatMap((width) => ['en', 'zh'].map((lang) => [`project-${width}-${lang}`, plain(f.render(width, lang))])));
}
