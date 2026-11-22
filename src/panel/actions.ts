import * as path from 'node:path';
import { openBoard, writeBoard } from '../cli/board.js';
import { focusJobTab, openEditorPane, stopJob } from '../cli/panel-pane.js';
import { readExpData, saveExpEdit } from '../collectors/exp-store.js';
import { answerJobQuestion } from '../collectors/panel-actions.js';
import type { ProjectVisits } from '../collectors/project-visits.js';
import { appendTry } from '../collectors/try-records.js';
import { finishChain } from '../render/chain-input.js';
import { effectiveModel } from '../render/control-view.js';
import { harnessItem } from '../render/harness-page.js';
import { language, t } from '../render/i18n.js';
import { expShown } from '../render/main-tabs.js';
import { rememberModel } from '../render/model-input.js';
import { controlRoleItem } from '../render/monitor-state.js';
import type { MonitorOutcome, MonitorState } from '../render/monitor.js';
import { HarnessSwitchError, setHarnessDisabled } from '../roles/harness-switches.js';
import { editPlaces, editPreset } from '../roles/role-control.js';

type ActionHost = {
  state: MonitorState;
  isClosed(): boolean;
  shownRoot(): string;
  projectDisplayRoot(): string | undefined;
  reloadExp(): void;
  collect(): void;
  repaint(): void;
  notice(text: string): void;
  boardNotice(text: string): void;
  error(text: string): void;
  boardInput(): Pick<Parameters<typeof writeBoard>[0], 'acceptance' | 'workboard' | 'briefs'>;
  refreshModels(): void;
  toggleBriefs(): void;
  openSettings(): void;
};

/** Execute only the actions emitted by monitor input, off the paint path. */
export function createPanelActions(home: string, cwd: string, visits: ProjectVisits, host: ActionHost) {
  let expSaving = false;
  const exportBoard = () => {
    const state = host.state;
    const root = state.activeTab === 'project' || state.activeTab === 'control' ? host.shownRoot() : cwd;
    void writeBoard({ cwd: root, hudHome: home, env: process.env, now: Date.now(), lang: language(), ...host.boardInput() })
      .then((file) => {
        openBoard(file, process.env);
        host.boardNotice(t('Board saved: {name}', { name: path.basename(file) }));
      })
      .catch(() => { host.boardNotice(t('Could not export board')); })
      .finally(() => host.repaint());
  };
  return {
    get expSaving() { return expSaving; },
    execute(action: MonitorOutcome['action'], previous: MonitorState) {
      if (!action) return;
      const state = host.state;
      switch (action.type) {
        case 'open-files':
          void openEditorPane(action.files, process.env).catch((err) => {
            host.error(String(err));
            host.repaint();
          });
          break;
        case 'record-try': {
          const root = state.activeTab === 'home' ? cwd : host.shownRoot();
          if (visits.snapshot(root) && (state.prefs.acceptance === 'slice' || host.projectDisplayRoot() === root)) {
            try {
              appendTry(home, root, action.action, action.target);
              host.notice('');
            } catch { host.notice(t('Could not record try')); }
          }
          break;
        }
        // The owner's micro-actions on a HUD job: what failed shows until the next key.
        case 'focus-job-tab':
          void focusJobTab(action.dir, process.env).then((focused) => {
            if (focused.ok) return;
            host.notice(t(focused.reason === 'tab closed' ? 'tab closed' : focused.reason === 'no tab' ? 'no tab recorded' : 'could not focus the tab'));
            host.repaint();
          });
          break;
        case 'answer-job': {
          const { home, jobId, qid, answer, role } = action, done = answerJobQuestion(home, jobId, qid, answer, role);
          host.notice(!done.ok ? `${t('Could not answer')}: ${done.reason}` : done.written ? '' : t('Already answered'));
          host.collect();
          break;
        }
        case 'stop-job':
          void stopJob(action.dir, process.env).then((stopped) => {
            if (!stopped.ok) host.notice(`${t('Could not stop')}: ${stopped.reason}`);
            host.repaint();
            host.collect();
          });
          break;
        case 'exp-save': {
          if (!expShown(state)) break;
          const saved = () => {
            host.reloadExp();
            const latest = host.state;
            host.state = { ...latest, overlay: undefined, exp: { ...latest.exp, notice: 'Saved' } };
          };
          const failed = () => { host.state.exp = { ...host.state.exp, notice: 'Could not save EXP setting' }; };
          try {
            const pending = saveExpEdit(home, action.edit, Date.now());
            if (pending) {
              expSaving = true;
              void pending.then(saved, failed).finally(() => {
                expSaving = false;
                if (!host.isClosed()) host.repaint();
              });
            } else saved();
          } catch { failed(); }
          break;
        }
        case 'refresh-models': host.refreshModels(); break;
        case 'export-board': exportBoard(); break;
        case 'harness-switch': {
          const { id, off } = action;
          const visit = visits.visit(host.shownRoot());
          try {
            setHarnessDisabled(home, id, off);
            const harnesses = state.control.harnesses, nav = harnesses.nav;
            host.state = { ...state, overlay: undefined, control: { ...state.control, notice: { kind: 'harness', id, off }, harnesses: {
              folded: off ? new Set() : harnesses.folded,
              nav: { ...nav, cursor: harnessItem(id), revealed: undefined, split: { ...nav.split, focus: 'list' } },
            } } };
            host.notice('');
          } catch (err) {
            host.notice(t(err instanceof HarnessSwitchError ? err.message : 'Could not save harness switch'));
          }
          if (visit.control) visit.collector.refreshRoles(visit.control, Date.now());
          break;
        }
        case 'role-edit': {
          const { type: _type, ...edit } = action;
          const done = editPlaces(home, host.shownRoot(), process.env, edit);
          if (done.ok && done.preset !== undefined)
            state.control = { ...state.control, notice: { kind: 'preset', role: edit.role, name: done.preset } };
          // Read the roles again now so a moved place or new assignment is reflected immediately.
          const visit = visits.visit(host.shownRoot());
          if (visit.control) visit.collector.refreshRoles(visit.control, Date.now());
          host.notice(done.ok ? '' : t(done.message ?? 'could not save the change') + (done.reason ? `: ${done.reason}` : ''));
          break;
        }
        case 'preset-edit': {
          const { type: _type, modelIndex, ...edit } = action;
          const done = editPreset(home, host.shownRoot(), process.env, edit);
          const chainSave = modelIndex === undefined && state.overlay?.kind === 'control-chain' ? state.overlay : undefined;
          if (modelIndex === undefined && done.ok) {
            const next = chainSave ? finishChain(state) : state;
            const roles = next.control.roles;
            host.state = { ...next, overlay: undefined, control: { ...next.control,
              notice: done.preset === undefined ? undefined : { kind: 'preset', role: edit.role, name: done.preset },
              roles: { ...roles, nav: { ...roles.nav, cursor: controlRoleItem(edit.role), revealed: undefined } },
            } };
          } else if (chainSave) {
            host.state = { ...state, overlay: { ...chainSave, error: done.message ?? 'could not save the change' } };
          }
          // Keep the draft (and its revision) on failure; a quick save uses the ordinary notice slot.
          host.notice(done.ok || chainSave ? '' : t(done.message ?? 'could not save the change') + (done.reason ? `: ${done.reason}` : ''));
          const visit = visits.visit(host.shownRoot());
          if (visit.control) visit.collector.refreshRoles(visit.control, Date.now());
          if (done.ok && modelIndex !== undefined && edit.op === 'run') {
            const role = visit.control?.roles.find((r) => r.role === edit.role);
            if (role) rememberModel(state, previous, role, edit.run[modelIndex]?.model);
            const place = role?.places[modelIndex];
            const model = place ? place.piModel?.current ?? effectiveModel(place) : edit.run[modelIndex]?.model ?? null;
            const roles = state.control.roles;
            state.control = { ...state.control, notice: { kind: 'model', role: edit.role, index: modelIndex, model },
              roles: { ...roles, nav: { ...roles.nav, revealed: undefined } } };
          }
          break;
        }
        case 'brief-toggle': host.toggleBriefs(); break;
        case 'settings': host.openSettings(); break;
      }
    },
  };
}
