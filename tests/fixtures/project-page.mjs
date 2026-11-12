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
  put(join(cwd, 'docs/handoff/STATE.md'), '# State\n\nMilestone: M4 · Project\n\n## Waiting for the owner\n\n- Try the Project tab\n- Choose the browser profile\n  after trying the synthetic setup\n\n## Later\n- Never show this unrelated bullet\n');
  put(join(cwd, 'docs/spec.md'), '# Synthetic spec');
  put(join(cwd, 'docs/reviews/2026-11-11-review.md'), '# Older review', 120);
  put(join(cwd, 'docs/reviews/2026-11-12-review.md'), 'Verdict: accept', 30);
  put(join(cwd, 'hud-convention.md'), '# Project convention');
  put(join(cwd, 'CLAUDE.md'), '# Claude instructions');
  put(join(cwd, 'AGENTS.md'), '# Agent instructions');
  put(join(hud, 'roles/imp.json'), { role: 'imp', harness: 'pi', pi_role: 'implementer', split: true, can_continue: true });
  put(join(root, 'roles/implementer.md'), '---\nmodel: synthetic/model\nthinking: high\n---\nRole text\n');
  put(join(bin, 'pi-role'), '#!/bin/sh\nexit 99\n');
  fs.chmodSync(join(bin, 'pi-role'), 0o700);
  put(join(home, '.claude/agents/user-agent.md'), '# Synthetic user agent');
  put(join(cwd, '.claude/agents/project-agent.md'), '# Synthetic project agent');
  put(join(home, '.codex/agents/codex-agent.toml'), 'model = "synthetic"');
  put(join(hud, 'credentials.env'), '# Synthetic names and values only\nMISTRAL_API_KEY=NEVER_RENDER_MISTRAL_VALUE\nOPENAI_API_KEY=""\nTYPESAFE_API_KEY=NEVER_RENDER_TYPESAFE_VALUE\nexport SYNTHETIC_KEY=NEVER_RENDER_OTHER_VALUE\n');
  put(join(hud, 'jev-runtime/runtime.json'), { endpoint: 'synthetic-not-contacted' });
  const id = 'j0000000000000001', job = join(hud, 'jobs', id);
  put(join(job, 'job.json'), { job: id, role: 'imp', cwd, herdr_pane: 'synthetic-main', package: 'M4-PROJECT', created_at: new Date(NOW - 20 * 60000).toISOString() });
  put(join(job, 'STATUS.json'), { state: 'working', started_at: new Date(NOW - 20 * 60000).toISOString() });
  put(join(job, 'brief.md'), '# Build the Project tab');
  const lanes = readThinJobs(hud, { project: cwd, pane: 'synthetic-main' });
  const board = { revision: 'synthetic', lanes, workers: lanes.flatMap((l) => l.workers), decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: cwd } };
  // A real, entirely synthetic Git repository; no git commit command or user config.
  const object = (kind, text) => {
    const bytes = Buffer.from(`${kind} ${Buffer.byteLength(text)}\0${text}`), hash = createHash('sha1').update(bytes).digest('hex');
    const path = join(cwd, '.git/objects', hash.slice(0, 2), hash.slice(2));
    fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, deflateSync(bytes));
    return hash;
  };
  const tree = object('tree', ''), stamp = NOW / 1000 - 7200;
  const hash = object('commit', `tree ${tree}\nauthor Synthetic <synthetic@example.invalid> ${stamp} +0000\ncommitter Synthetic <synthetic@example.invalid> ${stamp} +0000\n\nSynthetic Project baseline\n`);
  put(join(cwd, '.git/HEAD'), 'ref: refs/heads/synthetic-project\n');
  put(join(cwd, '.git/refs/heads/synthetic-project'), hash + '\n');
  const collector = new ProjectCollector(cwd, hud, env, home);
  const data = await collector.collect(true, board, NOW);
  const render = (width, lang = 'en', state = { ...initialMonitorState(), mainTab: 'project', projectFolded: new Set(['agents']) }, height = 42) => {
    const display = setDisplayConfig({ theme: 'none', icons: 'unicode' }), previous = setLanguage(lang);
    try { return renderMonitor({ tree: TREE, workboard: board, project: data, state, width, height, nowMs: NOW, modelEnabled: true }); }
    finally { setDisplayConfig(display); setLanguage(previous); }
  };
  return { cwd, hud, home, env, put, board, collector, data, render, job };
}
export const plain = (frame) => frame.lines.map((s) => stripAnsi(s).trimEnd());
export function projectFrames(f) {
  return Object.fromEntries([80, 120].flatMap((width) => ['en', 'zh'].map((lang) => [`project-${width}-${lang}`, plain(f.render(width, lang))])));
}
