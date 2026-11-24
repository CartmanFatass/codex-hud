import * as fs from 'node:fs';
import { join } from 'node:path';
import { decisionKeys, readHudCredentials } from '../jev/ask/config.js';
import { getHudHome } from '../hud-home.js';
import { jobFiles } from '../mcp/paths.js';
import { ensureJobWatcher } from '../mcp/watch-pid.js';
import { t } from '../render/i18n.js';
import { handleMonitorInput, initialMonitorState, type MonitorContext, type MonitorState } from '../render/monitor.js';
import {
  handleSettingsInput, renderSettingsPage, resetSettingsGroup, settingsDirty, SETTING_ROWS,
  type SettingsFrame, type SettingsPageState,
} from '../render/settings-page.js';
import {
  handleSettingsConfirmation, renderSettingsConfirmation, type SettingsConfirmationFrame, type SettingsConfirmationState,
} from '../render/settings-confirmation.js';
import { withDisplaySettings } from '../settings-runtime.js';
import { loadSettings, saveSettings, type HudSettings } from '../settings.js';
import type { PanelPlace } from '../render/monitor-reload-codec.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';

function availableDecisionKeys() {
  try { return decisionKeys(readHudCredentials()); } catch { return undefined; }
}

function wakeWatcherIfQueued() {
  try {
    const home = getHudHome();
    const jobsDir = join(home, 'jobs');
    if (!fs.existsSync(jobsDir)) return;
    const hasQueued = fs.readdirSync(jobsDir).some((id) => {
      if (!/^j[0-9a-f]{16}$/.test(id)) return false;
      try {
        const status = JSON.parse(fs.readFileSync(join(jobsDir, id, jobFiles.status), 'utf8'));
        return status?.state === 'queued';
      } catch {
        return false;
      }
    });
    if (!hasQueued) return;
    ensureJobWatcher(home);
  } catch { /* Best effort; running watcher already watches hud-settings.json. */ }
}

type SettingsEffects = {
  current(): HudSettings;
  apply(saved: HudSettings, widthChanged: boolean): void;
  setMouseTracking(enabled: boolean): void;
  applyWidth(): Promise<unknown> | undefined;
  repaint(): void;
  repaintAll(): void;
};

type SettingsFacts = NonNullable<Parameters<typeof renderSettingsPage>[3]>;

/** Own the Settings draft, dirty-navigation prompt and overlaid Help. */
export function createSettingsFlow(saved: HudSettings, place: PanelPlace['settings'] | undefined, effects: SettingsEffects, impPresets: () => readonly string[]) {
  let page: SettingsPageState | null = place
    ? { ...place, draft: { ...saved, roleCaps: { ...saved.roleCaps } }, original: { ...saved, roleCaps: { ...saved.roleCaps } }, decisionKeys: availableDecisionKeys(), impPresets: impPresets(), message: '' } : null;
  let settingsFrame: SettingsFrame | undefined;
  let help: MonitorState | undefined;
  let leave: (SettingsConfirmationState & { destination?: string }) | null = null;
  let confirmationFrame: SettingsConfirmationFrame | undefined;

  const applyDraft = (): boolean => {
    const draftPage = page;
    if (!draftPage) return false;
    try {
      const previous = effects.current();
      const previousWidth = previous.treeWidth;
      const settings = saveSettings(draftPage.draft);
      const widthChanged = settings.treeWidth !== previousWidth;
      if (settings.impOverflow !== previous.impOverflow || JSON.stringify(settings.roleCaps) !== JSON.stringify(previous.roleCaps)) {
        wakeWatcherIfQueued();
      }
      effects.apply(settings, widthChanged);
      draftPage.message = t('Saved');
      draftPage.original = { ...settings, roleCaps: { ...settings.roleCaps } };
      effects.setMouseTracking(settings.mouse);
      void (widthChanged ? effects.applyWidth() : undefined)
        ?.then(() => effects.repaintAll())
        .catch((err) => {
          if (page) page.message = String(err);
          effects.repaint();
        });
      return true;
    } catch (err) {
      draftPage.message = t('Save failed: {reason}', { reason: String(err) });
      return false;
    }
  };
  const requestLeave = () => {
    if (page && settingsDirty(page)) leave = { choice: 'cancel', destination: undefined };
    else page = null;
  };
  return {
    get open() { return page !== null; },
    isDirty: () => page !== null && settingsDirty(page),
    place: () => page && { selected: page.selected, offset: page.offset },
    show(settings: HudSettings) {
      let decisionApi = settings.decisionApi;
      try { decisionApi = loadSettings().decisionApi; } catch { /* Keep the loaded draft. */ }
      page = { draft: { ...settings, roleCaps: { ...settings.roleCaps }, decisionApi }, decisionKeys: availableDecisionKeys(), impPresets: impPresets(), selected: 0, offset: 0, message: '' };
    },
    paint(width: number, height: number, facts: () => SettingsFacts, paintHelp: (help: MonitorState, mouse: boolean) => string[]): string[] | undefined {
      if (!page) return;
      if (help) {
        // Help is drawn over Settings without changing Settings or the underlying tab.
        return withDisplaySettings(page.draft, () => paintHelp(help!, page!.draft.mouse));
      }
      settingsFrame = withDisplaySettings(page.draft, () => renderSettingsPage(page!, width, height, facts()));
      page = settingsFrame.state;
      if (!leave) return settingsFrame.lines;
      confirmationFrame = renderSettingsConfirmation(settingsFrame.lines, leave, width, height, 1, page);
      return confirmationFrame.lines;
    },
    /** Return the input only if it should continue through the underlying monitor. */
    input(input: WorkbenchInput, context: MonitorContext, framePlace: (state: MonitorState) => MonitorState): WorkbenchInput | undefined {
      if (leave && confirmationFrame) {
        const result = handleSettingsConfirmation(leave, input, confirmationFrame);
        leave = { ...leave, ...result.state };
        if (!result.action) {
          effects.repaint();
          return;
        }
        if (result.action === 'cancel') {
          leave = null;
          effects.repaint();
          return;
        }
        if (result.action === 'save' && !applyDraft()) {
          leave.error = page?.message || t('Could not save settings');
          effects.repaint();
          return;
        }
        const destination = leave.destination;
        leave = null;
        page = null;
        if (!destination) {
          effects.repaint();
          return;
        }
        input = { type: 'key', key: destination };
      }
      if (!page || !settingsFrame) return input;
      if (help) {
        const result = handleMonitorInput(framePlace(help), input, context);
        // `q` returns to Settings too, so an unsaved draft is not lost.
        help = !result.close && result.state.help ? result.state : undefined;
      } else if (input.type === 'key' && input.key === 'help') {
        help = { ...initialMonitorState(), help: {} };
      } else {
        const result = handleSettingsInput(page, input, settingsFrame);
        page = result.state;
        if (result.action === 'back') requestLeave();
        else if (result.action === 'reset') {
          const group = SETTING_ROWS[page.selected].group;
          page = {
            ...page,
            draft: resetSettingsGroup(page.draft, group),
            message: t('Group defaults ready; Save to apply'),
          };
        } else if (result.action === 'save') applyDraft();
      }
      effects.repaint();
      return;
    },
  };
}
