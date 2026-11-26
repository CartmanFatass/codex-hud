import * as path from 'node:path';
import { openBoard, writeBoard } from '../cli/board.js';
import { focusJobTab, hideJobTab, openEditorPane, openGitShowPane, stopJob } from '../cli/panel-pane.js';
import { readExpData, saveExpEdit } from '../collectors/exp-store.js';
import { collectEvidenceEntry } from '../collectors/objectives.js';
import { answerJobQuestion, appendPanelAction, recordPanelAnswer, type AnswerResult } from '../collectors/panel-actions.js';
import type { ProjectVisits } from '../collectors/project-visits.js';
import { acceptAll, TryLog } from '../collectors/try-records.js';
import { finishChain } from '../render/chain-input.js';
import { effectiveModel } from '../render/control-view.js';
import { batchStateWord } from '../render/work-jobs.js';
import { harnessItem } from '../render/harness-page.js';
import { language, t } from '../render/i18n.js';
import { resourcesShown } from '../render/main-tabs.js';
import { rememberModel } from '../render/model-input.js';
import { controlRoleItem } from '../render/monitor-state.js';
import type { MonitorOutcome, MonitorState } from '../render/monitor.js';
import { allowCouncil } from '../roles/council-grant.js';
import { HarnessSwitchError, setHarnessDisabled } from '../roles/harness-switches.js';
import { editPlaces, editPreset } from '../roles/role-control.js';
import { roleRegistry } from '../roles/roster.js';
import { getJobIndexCache } from '../roles/job-index-cache.js';
import { resumePanelAnswer } from '../mcp/thin-main.js';
import { copyToClipboard } from '../utils/clipboard.js';

/** A tab consumes the answer file itself. A paused headless session needs the same handoff as hud_respond. */
export async function answerFromPanel(home: string, id: string, qid: string, answer: string, role: string | null): Promise<AnswerResult> {
  try {
    const job = getJobIndexCache(home).readJob(id);
    if (job.status !== 'ok' || !job.value.headless) return answerJobQuestion(home, id, qid, answer, role);
    const result = await resumePanelAnswer(home, id, qid, answer.trim());
    if (result.ok && result.written) recordPanelAnswer(home, id, qid, answer.trim(), role);
    return result;
  } catch (error) { return { ok: false, reason: (error as Error).message }; }
}

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
  boardInput(): Pick<Parameters<typeof writeBoard>[0], 'workboard'>;
  refreshModels(): void;
  openSettings(): void;
  copyClipboard?: (text: string) => boolean;
};

/** Execute only the actions emitted by monitor input, off the paint path. */
export function createPanelActions(home: string, cwd: string, visits: ProjectVisits, host: ActionHost) {
  let expSaving = false;
  const tries = new TryLog(home);
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
      if (action?.type === 'open-objective-evidence') {
        const { file, commit } = collectEvidenceEntry(action.text, action.root, home);
        action = file ? { type: 'open-files', files: [file] } : commit ? { type: 'git-show', cwd: action.root, hash: commit } : undefined;
      }
      if (!action) return;
      const state = host.state;
      switch (action.type) {
        case 'open-files':
        case 'git-show':
          void (action.type === 'open-files' ? openEditorPane(action.files, process.env)
            : openGitShowPane(action.cwd, action.hash, process.env)).catch((err) => {
            host.error(String(err));
            host.repaint();
          });
          break;
        case 'accept-all': {
          const root = host.shownRoot();
          // On a project switch the panel can still show the previous project's hub.
          if (host.projectDisplayRoot() !== root) break;
          const ledger = visits.snapshot(root)?.ledger;
          if (!ledger) break;
          try {
            if (acceptAll(home, root, ledger, tries)) { host.notice(''); host.collect(); }
          } catch { host.notice(t('Could not accept all')); }
          break;
        }
        // The owner's micro-actions on a HUD job: what failed shows until the next key.
        case 'request-retry':
          try {
            appendPanelAction(action.home, { type: 'retry', job: action.jobId });
            host.notice(t('Retry requested'));
          } catch { host.notice(t('Could not record request')); }
          break;
        case 'copy-advisor': {
          const copied = (host.copyClipboard ?? copyToClipboard)(action.path);
          try {
            appendPanelAction(home, {
              type: 'advice-copy',
              session: action.session,
              skill: action.skill,
              path: action.path,
              project: action.root,
            });
          } catch { /* Recording the copy action is best-effort. */ }
          host.notice(copied ? t('Copied: {name}', { name: action.skill }) : t('Could not copy path'));
          break;
        }
        case 'focus-job-tab':
        case 'hide-job-tab': {
          const hide = action.type === 'hide-job-tab';
          void (hide ? hideJobTab : focusJobTab)(action.dir, process.env).then((result) => {
            if (result.ok) return;
            const { reason } = result;
            host.notice(t(reason === 'tab closed' ? 'tab closed' : reason === 'no tab' ? 'no tab recorded'
              : reason === 'hidden tabs unavailable' ? reason : hide ? 'could not hide the tab' : 'could not focus the tab'));
            host.repaint();
          });
          break;
        }
        case 'answer-job': {
          const { home, jobId, qid, answer, role } = action;
          void answerFromPanel(home, jobId, qid, answer, role).then(done => {
            host.notice(!done.ok ? `${t('Could not answer')}: ${done.reason}` : done.written ? '' : t('Already answered'));
            host.collect();
          });
          break;
        }
        case 'stop-job':
          void stopJob(action.dir, process.env).then((stopped) => {
            if (!stopped.ok) host.notice(`${t('Could not stop')}: ${stopped.reason}`);
            host.repaint();
            host.collect();
          });
          break;
        // One call acts on the whole batch, through the engine control behind `hud_create({batch, action})`.
        case 'batch-control':
          void import('../mcp/batch.js')
            .then(({ controlBatchAsOwner }) => controlBatchAsOwner(home, action.flow, action.control))
            .then((b) => { if (!b.applied) host.notice(t('Batch unchanged: {state}', { state: t(batchStateWord(b)) })); })
            .catch((error: Error) => host.notice(`${t('Could not control batch')}: ${error.message}`))
            .finally(() => { host.repaint(); host.collect(); });
          break;
        case 'exp-save': {
          if (!resourcesShown(state)) break;
          const saved = () => {
            host.reloadExp();
            const latest = host.state;
            host.state = { ...latest, overlay: undefined, exp: { ...latest.exp, notice: 'Saved' } };
          };
          const failed = () => { host.state.exp = { ...host.state.exp, notice: 'Could not save resource setting' }; };
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
              nav: { ...nav, cursor: harnessItem(id), revealed: undefined },
            } } };
            host.notice('');
          } catch (err) {
            host.notice(t(err instanceof HarnessSwitchError ? err.message : 'Could not save harness switch'));
          }
          if (visit.control) visit.collector.refreshRoles(visit.control, Date.now());
          break;
        }
        case 'council-grant':
          void allowCouncil(home, 'panel').then(() => host.notice(t('One council authorized for 30 minutes')),
            () => host.notice(t('Could not authorize council'))).finally(() => host.repaint());
          break;
        case 'role-switch': {
          const root = host.shownRoot(), visit = visits.visit(root);
          try {
            roleRegistry(home, root).setOptionalRoleEnabled(action.role, action.enabled);
            host.notice('');
          } catch { host.notice(t('Could not save role switch')); }
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
        case 'settings': host.openSettings(); break;
      }
    },
  };
}
