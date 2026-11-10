import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initialMonitorState, renderMonitor } from '../../src/render/monitor.js';
import { renderSettingsPage, SETTING_ROWS } from '../../src/render/settings-page.js';
import { defaultSettings } from '../../src/settings.js';
import { setLanguage } from '../../src/render/i18n.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { visualLength, stripAnsi } from '../../src/render/colors.js';
import type { WorkboardSnapshot, OwnerWorker } from '../../src/collectors/workboard-types.js';
import type { JobProgressDisplay, JobProgressNote } from '../../src/collectors/job-progress.js';
const at = Date.parse('2026-11-09T12:00:00Z');
const worker: OwnerWorker = {
  id: 'synthetic-job',
  laneId: 'synthetic-lane',
  role: 'imp',
  task: 'Public parser boundary repair',
  harness: 'pi',
  model: 'synthetic-model',
  effort: 'high',
  state: 'working',
  startedAt: at - 120000,
  settledAt: null,
  phase: 'build',
  homeNeedsHuman: false,
  humanEndedAt: null,
  stale: false,
  evidence: [],
  work: {
    episode: 'synthetic-episode',
    signature: 'synthetic',
    activityAt: at,
    activityBasis: 'producer',
    phases: ['build'],
    request: false,
    failed: false,
    result: false,
  },
};
const board: WorkboardSnapshot = {
  revision: 'synthetic-board',
  lanes: [
    {
      id: worker.laneId,
      identity: { kind: 'invocation', home: '/synthetic/hud', root: 'synthetic/root', jobId: worker.id },
      label: 'Parser repair',
      title: 'Parser repair',
      startedAt: worker.startedAt,
      phase: 'build',
      workers: [worker],
      decisions: [],
      evidence: [],
    },
  ],
  workers: [worker],
  decisions: [],
  coverage: { incomplete: false, workspace: null, diagnostics: [] },
};
const tree = { rootId: 'synthetic-root', nodes: [], totalCount: 0, updatedAt: new Date(at) };
const file = new URL(
  '../fixtures/job-progress-visual.json',
  import.meta.url.replace('/dist-test/tests/unit/', '/tests/unit/')
);
test('P3b additive sentence/basis/denied/error/empty/attention/consent frames at 44/56/110 EN/ZH colour/mono', () => {
  const frames: Record<string, string[]> = {};
  const oldLanguage = setLanguage('en');
  const oldDisplay = setDisplayConfig({ theme: 'none' });
  try {
    for (const language of ['en', 'zh'] as const)
      for (const theme of ['none', 'mocha'] as const)
        for (const width of [44, 56, 110]) {
          setLanguage(language);
          setDisplayConfig({ theme, icons: 'unicode', look: 'tab' });
          const line =
            language === 'en'
              ? 'Repairing the parser boundary while preserving the public evidence filter and the existing deterministic review facts.'
              : '正在修复解析器边界，同时保留公开证据过滤规则和已有的确定性审查事实，详细依据可在检查器中查看。';
          const note: JobProgressNote = {
            line,
            attention: false,
            basis: ['e1'],
            fingerprint: 'synthetic-fingerprint',
            generatedAt: at,
            coverage: ['bounded_job_excerpts'],
            basisEvidence: [
              {
                id: 'e1',
                locator: 'brief.md#goal',
                text:
                  language === 'en'
                    ? 'Repair the public parser. Preserve filtering of reasoning, user history and tool payloads; do not add any execution behaviour.'
                    : '修复公开解析器。继续过滤推理、用户历史和工具内容，不增加任何执行行为。',
                truncated: false,
                revision: 'synthetic-revision',
              },
            ],
          };
          for (const scene of [
            'sentence',
            'basis',
            'no-grant',
            'error',
            'empty',
            'attention',
            'consent-granted',
            'consent-denied',
          ]) {
            const key = `job-progress/${language}/${theme}/${scene}/${width}x30`;
            if (scene.startsWith('consent')) {
              const selected = SETTING_ROWS.findIndex((r) => r.key === 'jobMaterialConsent');
              frames[key] = renderSettingsPage(
                {
                  draft: defaultSettings(),
                  selected,
                  offset: 0,
                  message: '',
                  jobConsent: scene === 'consent-granted' ? 'granted' : 'denied',
                  jobRecipient: 'api.mistral.ai · MISTRAL_API_KEY from credentials.env · synthetic-model',
                },
                width,
                30
              ).lines;
            } else {
              const display: JobProgressDisplay =
                scene === 'no-grant'
                  ? { reason: 'Job consent denied' }
                  : scene === 'error'
                    ? { reason: 'Job sentence unavailable' }
                    : {
                        note:
                          scene === 'empty'
                            ? { ...note, line: '', basis: [], basisEvidence: [] }
                            : { ...note, attention: scene === 'attention' },
                      };
              const inspector = ['basis', 'error', 'empty', 'no-grant'].includes(scene);
              const state = {
                ...initialMonitorState(),
                mainTab: 'work' as const,
                modes: { ...initialMonitorState().modes, details: 'open' as const },
                focus: inspector ? ('details' as const) : ('agents' as const),
                boardInspect: inspector
                  ? { kind: 'worker' as const, laneId: worker.laneId, workerId: worker.id }
                  : undefined,
              };
              frames[key] = renderMonitor({
                tree,
                workboard: board,
                state,
                width,
                height: 30,
                nowMs: at,
                jobProgress: new Map([[worker.id, display]]),
              }).lines;
              if (scene === 'basis')
                assert.ok(
                  stripAnsi(frames[key].join('\n'))
                    .replace(/\s+/g, ' ')
                    .includes(language === 'en' ? 'execution behaviour' : '执行行为'),
                  key + '\n' + stripAnsi(frames[key].join('\n'))
                );
            }
            assert.equal(frames[key].length, 30, key);
            for (const line of frames[key]) assert.equal(visualLength(line), width, key);
          }
        }
    if (process.env.P3B_UPDATE === '1') fs.writeFileSync(file, JSON.stringify(frames, null, 2) + '\n');
    assert.deepEqual(frames, JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(Object.keys(frames).length, 96);
  } finally {
    setLanguage(oldLanguage);
    setDisplayConfig(oldDisplay);
  }
});
