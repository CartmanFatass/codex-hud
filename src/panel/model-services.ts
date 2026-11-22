import * as path from 'node:path';
import { DecisionLabels } from '../collectors/decision-labels.js';
import { DecisionTitles } from '../collectors/decision-titles.js';
import { HomeRecommendation } from '../collectors/home-recommendation.js';
import { JobSentences } from '../collectors/job-sentences.js';
import { ModelProbe, apiSettings } from '../collectors/model-probe.js';
import { SmallModel, modelHttpRequest } from '../collectors/small-model.js';
import { WaitingBriefs } from '../collectors/waiting-briefs.js';
import { TryBriefs } from '../collectors/try-brief.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { getHudDisplayHome } from '../hud-home.js';
import { resolveLanguage } from '../render/i18n.js';
import type { MonitorState } from '../render/monitor.js';
import { discoverModelLists, readModelListCache } from '../roles/model-discovery.js';
import type { HudSettings } from '../settings.js';
import type { SubagentTree } from '../types.js';

export function createPanelModelServices(home: string, render: () => void, isClosed: () => boolean) {
  // One queue, cache and hourly cap for chat calls, beside the HUD's state.
  const dir = path.join(getHudDisplayHome(), 'model-cache');
  let modelOn = false;
  let modelChanged = () => {};
  const model = new SmallModel({ dir, onChange: () => modelChanged() });
  const probe = new ModelProbe({ dir }, render);
  const jobSentences = new JobSentences(model, path.join(dir, 'job-sentences.json'), render);
  const tryBriefs = new TryBriefs(model, path.join(dir, 'try-briefs.json'), render);
  const waitingBriefs = new WaitingBriefs(model, path.join(dir, 'waiting-briefs.json'), render);
  const decisionTitles = new DecisionTitles(model, path.join(dir, 'decision-titles.json'), render);
  const decisionLabels = new DecisionLabels(dir, render);
  const homeRecommendation = new HomeRecommendation(dir, model, render);
  const apply = (board: WorkboardSnapshot) => decisionLabels.apply(decisionTitles.apply(jobSentences.apply(board)));

  let lastControlShown = false;
  let modelListRefresh: Promise<void> | null = null;
  let modelListAbort: AbortController | null = null;
  const refreshModelLists = (force: boolean) => {
    if (isClosed()) return;
    if (!force && readModelListCache(home, Date.now())) return;
    if (modelListRefresh) return;
    const controller = new AbortController();
    modelListAbort = controller;
    modelListRefresh = discoverModelLists(home, process.env, Date.now(), { signal: controller.signal })
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (modelListAbort === controller) modelListAbort = null;
        modelListRefresh = null;
      });
  };

  return {
    probe, tryBriefs, waitingBriefs, apply: (board: WorkboardSnapshot) => waitingBriefs.board(apply(board)), refreshModelLists,
    get enabled() { return modelOn; },
    onChange(callback: () => void) { modelChanged = callback; },
    configure(settings: HudSettings) {
      modelOn =
        settings.modelEnabled &&
        !('error' in modelHttpRequest(apiSettings(settings), { feature: 'progress', system: '', prompt: '' }));
      model.configure({
        backend: modelOn ? 'api' : 'off',
        api: { base: settings.briefingApiBase, model: settings.model },
        hourlyCap: settings.modelCallsPerHour,
      });
      decisionLabels.configure(settings.modelEnabled, settings.decisionCallsPerHour);
      homeRecommendation.configure(settings.homeMode === 'recommended' && settings.modelEnabled, resolveLanguage(settings.language), settings.decisionCallsPerHour, settings.decisionApi, settings.summaryIntervalMinutes, settings);
      jobSentences.configure(modelOn, resolveLanguage(settings.language), settings.summaryIntervalMinutes);
      waitingBriefs.configure(modelOn, resolveLanguage(settings.language));
      tryBriefs.configure(modelOn, resolveLanguage(settings.language));
      decisionTitles.configure(modelOn, resolveLanguage(settings.language));
    },
    modelHealth: () => !modelOn ? undefined : model.diagnostics(),
    modelCalls: () => model.usage(),
    decisionCalls: () => decisionLabels.usage(),
    recommend: (board: WorkboardSnapshot) => homeRecommendation.apply(board),
    update(board: WorkboardSnapshot, tree: SubagentTree, subpage: MonitorState['subpage']) {
      decisionTitles.inspect(board, home, subpage?.kind === 'inspector' ? subpage.target : undefined);
      decisionLabels.update(board, home, tree);
      jobSentences.update(board, home, tree);
      homeRecommendation.update(apply(board));
    },
    leaveRoot() {
      // Cancel old-root writers before loading the next root's model log.
      decisionTitles.stop();
      decisionLabels.stop();
      homeRecommendation.stop();
      jobSentences.stop();
      tryBriefs.stop();
      waitingBriefs.stop();
    },
    syncDiscovery(shown: boolean) {
      if (shown && !lastControlShown) refreshModelLists(false);
      lastControlShown = shown;
    },
    dispose() {
      jobSentences.stop();
      tryBriefs.stop();
      waitingBriefs.stop();
      decisionTitles.stop();
      decisionLabels.stop();
      homeRecommendation.stop();
      model.cancelAll();
      modelListAbort?.abort();
      probe.cancel();
    },
  };
}
