/**
 * The Codex bar's facts, from `HudData`, as `renderBar` (`bar-fields.ts`) takes them: the model and its effort, the
 * context against the point where Codex compacts (else the model's window), the repository and its branch, the
 * account's usage, what needs the person (an approval, a job's question) and what just happened, and what Codex loaded.
 * A field with no trustworthy data is left out, so nothing shows a zero it does not have.
 */

import type { BarNotice, HudData } from '../../types.js';
import { icons } from '../colors.js';
import { alertParts, collectAttention } from '../attention.js';
import { formatCredits, quotaState, readQuotaWindows } from '../quota.js';
import { shortModel } from '../providers.js';
import { agentEvent, gitSync, span, type BarEvent, type BarFacts } from './bar-fields.js';

function eventOf(notice: BarNotice): BarEvent {
  const at = notice.at.getTime();
  const who = { id: notice.id, name: notice.subject ?? 'agent', model: notice.model, effort: notice.effort };
  switch (notice.kind) {
    case 'agent-started':
      return agentEvent('started', who, at);
    case 'agent-done':
      return agentEvent('done', who, at);
    case 'agent-failed':
      return agentEvent('failed', who, at);
  }
}

export function barFacts(data: HudData, nowMs: number): BarFacts {
  const model = data.session?.model ?? data.config.model;
  const usage = data.contextUsage;
  const used = usage?.inContext ?? usage?.used;
  let window = usage?.window ?? usage?.total;
  // Codex compacts at its configured limit when that is below the window: the reading is against it.
  const limit = data.config.model_auto_compact_token_limit;
  if (window && limit && limit > 0 && limit < window) window = limit;
  const percent =
    used !== undefined && window && window > 0 ? Math.max(0, Math.min(100, Math.round((used / window) * 100))) : null;
  const git = data.git;
  const windows = readQuotaWindows(data.rateLimits, nowMs);
  const tightest = windows.length ? windows.reduce((a, b) => (b.percent > a.percent ? b : a)) : null;
  const credits = tightest && tightest.percent >= 100 ? quotaState(data.rateLimits, windows).credits : null;
  return {
    model: model
      ? {
          name: shortModel(model),
          effort: data.session?.reasoningEffort ?? data.config.model_reasoning_effort,
          id: model,
          provider: data.session?.modelProvider ?? data.config.model_provider,
        }
      : undefined,
    context: percent === null || !window ? undefined : { percent, shown: `${percent}%`, window },
    project: {
      name: git.repo ?? data.project.projectName,
      branch: git.isGitRepo ? git.branch : null,
      marks: (git.isDirty ? icons.dirty : '') + gitSync(git.ahead, git.behind),
      dirty: git.isDirty,
    },
    quota: !tightest
      ? undefined
      : credits
        ? { label: 'credits', text: formatCredits(credits) }
        : {
            windows: windows.map((w) => ({
              label: w.label,
              percent: w.percent,
              reset: w.resetsAt && !w.resetDue ? span(Math.ceil((w.resetsAt.getTime() - nowMs) / 60000)) : '',
            })),
          },
    needs: [
      ...alertParts(
        collectAttention(data, nowMs).filter((item) => item.kind === 'approval'),
        nowMs
      ),
      ...(data.work?.needs ?? []),
    ],
    events: [...(data.notices ?? []).map(eventOf), ...(data.work?.events ?? [])],
    loaded: {
      counts: [
        ['MCP', data.project.mcpCount],
        ['skills', data.project.skillsCount],
      ],
    },
  };
}
