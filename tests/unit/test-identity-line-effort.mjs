import assert from 'node:assert/strict';

import { renderIdentityLine } from '../../dist/render/lines/identity-line.js';
import { stripAnsi } from '../../dist/render/colors.js';

const layout = {
  mode: 'expanded',
  showSeparators: false,
  showDuration: true,
  showContextBreakdown: true,
  barWidth: 10,
};

const baseData = {
  config: {
    model: 'gpt-5.4',
    model_reasoning_effort: 'high',
    model_provider: 'openai',
  },
  git: {
    branch: null,
    isDirty: false,
    isGitRepo: false,
    ahead: 0,
    behind: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
  },
  project: {
    cwd: '/tmp/codex-hud',
    projectName: 'codex-hud',
    agentsMdCount: 0,
    hasCodexDir: false,
    instructionsMdCount: 0,
    rulesCount: 0,
    mcpCount: 0,
    configsCount: 0,
    extensionsCount: 0,
    workMode: 'development',
  },
  sessionStart: new Date('2026-04-09T00:00:00Z'),
};

const sessionDriven = stripAnsi(
  renderIdentityLine(
    {
      ...baseData,
      session: {
        id: '019d7295-3ef8-7292-a039-fdf7ecd4f53e',
        rolloutPath: '/tmp/rollout.jsonl',
        startTime: new Date('2026-04-09T00:00:00Z'),
        cwd: '/tmp/codex-hud',
        cliVersion: '0.118.0',
        model: 'gpt-5.4',
        reasoningEffort: 'xhigh',
      },
    },
    layout
  )
);

assert.match(
  sessionDriven,
  /5\.4/,
  'identity line should prefer the current session model over config defaults'
);
assert.match(
  sessionDriven,
  /●/,
  'identity line should prefer the current session effort over config defaults'
);
assert.doesNotMatch(sessionDriven, /xhigh/, 'effort is a glyph, not the word xhigh');

const configDriven = stripAnsi(renderIdentityLine(baseData, layout));
assert.match(configDriven, /5\.4/, 'identity line should show config model before a session is bound');
assert.match(configDriven, /◕/, 'identity line should show config reasoning effort as a fill glyph');

console.log('test-identity-line-effort: PASS');
