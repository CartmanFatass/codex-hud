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
import { loadSettings, saveSettings, settingsPatch, type HudSettings } from '../settings.js';
import { herdrEndpoint, request as herdrRequest } from '../runtime/herdr-socket.js';
import { DEFAULT_HEIGHT, DEFAULT_WIDTH } from '../utils/pane-width.js';
import { setUnattended } from '../unattended/control.js';
import { readControl, unattendedOn } from '../unattended/state.js';
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
  apply(saved: HudSettings): void;
  setMouseTracking(enabled: boolean): void;
  repaint(): void;
};

type SettingsFacts = NonNullable<Parameters<typeof renderSettingsPage>[3]>;

/** Own the Settings draft, dirty-navigation prompt and overlaid Help. */
export function createSettingsFlow(saved: HudSettings, place: PanelPlace['settings'] | undefined, effects: SettingsEffects, rolePresets: (role: 'imp' | 'sonic') => readonly string[]) {
  const presets = () => ({ impPresets: rolePresets('imp'), sonicPresets: rolePresets('sonic') });
  // Draft edits replace values rather than mutating the opening snapshot.
  const openPage = (settings: HudSettings, position: NonNullable<PanelPlace['settings']>): SettingsPageState => ({
    ...position, draft: settings, original: settings, decisionKeys: availableDecisionKeys(), ...presets(), message: '',
  });
  let page = place ? openPage(saved, place) : null;
  let settingsFrame: SettingsFrame | undefined;
  let help: MonitorState | undefined;
  let leave: (SettingsConfirmationState & { destination?: () => void }) | null = null;
  let confirmationFrame: SettingsConfirmationFrame | undefined;
  let unattended = unattendedOn(getHudHome()), toggling = false;
  const observeUnattended = () => { unattended = unattendedOn(getHudHome()); };
  const toggleUnattended = async (target: SettingsPageState) => {
    if (toggling) return;
    toggling = true;
    const home = getHudHome();
    try {
      const enabling = !unattendedOn(home);
      if (enabling && !readControl(home)?.objectives.length) {
        target.message = t('Select Objectives first with hud unattended on --objective <id>');
      } else {
        await setUnattended(home, enabling);
        target.message = t(enabling ? 'Unattended started' : 'Unattended stop requested');
      }
    } catch (err) {
      target.message = t('Unattended: {reason}', { reason: String(err) });
    } finally {
      toggling = false;
      observeUnattended();
      // Navigation may replace the draft state during the asynchronous command.
      if (page && SETTING_ROWS[page.selected]?.key === 'unattended') page.message = target.message;
      effects.repaint();
    }
  };

  const applyDraft = (): boolean => {
    const draftPage = page;
    if (!draftPage?.original) return false;
    const patch = settingsPatch(draftPage.original, draftPage.draft);
    if (!Object.keys(patch).length) {
      draftPage.message = t('Saved');
      return true;
    }
    try {
      const previous = effects.current();
      const settings = saveSettings(patch, draftPage.original);
      const dockChanged =
        settings.treeWidth !== previous.treeWidth ||
        settings.dockHeight !== previous.dockHeight ||
        settings.dockMode !== previous.dockMode ||
        settings.dockSide !== previous.dockSide;
      if (settings.impOverflow !== previous.impOverflow || JSON.stringify(settings.roleCaps) !== JSON.stringify(previous.roleCaps)) {
        wakeWatcherIfQueued();
      }
      effects.apply(settings);
      draftPage.message = t('Saved');
      draftPage.draft = settings;
      draftPage.original = settings;
      effects.setMouseTracking(settings.mouse);
      if (dockChanged && process.env.HERDR_DOCK === '1' && herdrEndpoint()) {
        // A PTY resize repaints through the normal terminal resize event.
        void herdrRequest('dock.configure', {
          mode: settings.dockMode,
          side: settings.dockSide,
          width: settings.treeWidth || DEFAULT_WIDTH,
          height: settings.dockHeight || DEFAULT_HEIGHT,
        })
          .then((reply) => {
            if (reply?.result?.type === 'dock' && (reply.result.shown || reply.result.hidden)) return;
            if (page?.original === settings) {
              page.message = t('Saved; could not update the dock');
              effects.repaint();
            }
          });
      }
      return true;
    } catch (err) {
      draftPage.message = t('Save failed: {reason}', { reason: String(err) });
      return false;
    }
  };
  const requestLeave = (destination?: () => void) => {
    if (page && settingsDirty(page)) leave = { choice: 'cancel', destination };
    else {
      page = null;
      help = undefined;
      destination?.();
    }
  };
  return {
    get open() { return page !== null; },
    navigate(destination: () => void) { help = undefined; requestLeave(destination); effects.repaint(); },
    isDirty: () => page !== null && settingsDirty(page),
    observeUnattended,
    /** Adopt external persisted dock-size updates (e.g. from drag resize) without clobbering unsaved edits. */
    syncExternal(saved: HudSettings, keys: readonly ('treeWidth' | 'dockHeight')[]) {
      if (!page || !keys.length) return;
      const original = { ...(page.original ?? page.draft) };
      const draft = { ...page.draft };
      for (const key of keys) {
        if (draft[key] === original[key]) draft[key] = saved[key];
        original[key] = saved[key];
      }
      page = { ...page, draft, original };
      effects.repaint();
    },
    place: () => page && { selected: page.selected, offset: page.offset },
    show(settings: HudSettings) {
      observeUnattended();
      let decisionApi = settings.decisionApi;
      try { decisionApi = loadSettings().decisionApi; } catch { /* Keep the loaded draft. */ }
      page = openPage({ ...settings, decisionApi }, { selected: 0, offset: 0 });
    },
    paint(width: number, height: number, facts: () => SettingsFacts, paintHelp: (help: MonitorState, mouse: boolean) => string[]): string[] | undefined {
      if (!page) return;
      if (help) {
        // Help is drawn over Settings without changing Settings or the underlying tab.
        return withDisplaySettings(page.draft, () => paintHelp(help!, page!.draft.mouse));
      }
      settingsFrame = withDisplaySettings(page.draft, () => renderSettingsPage(page!, width, height, { ...facts(), unattended }));
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
        destination?.();
        effects.repaint();
        return;
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
        else if (result.action === 'unattended') void toggleUnattended(page);
      }
      effects.repaint();
      return;
    },
  };
}
