/** `hud select-send`: plugin action and minimal popup composer. */
import { StringDecoder } from 'node:string_decoder';
import { resolve as resolvePath } from 'node:path';
import { MAX_ADVISOR_FOLLOWUPS, readSelectionAdvisor, recordSelectionExcerpt, recordSelectionNote, setExcerptDelivery, type ExcerptDelivery } from '../roles/selection-excerpts.js';
import { advisorPhase, continueSelectionAdvisor, endSelectionAdvisor, startSelectionAdvisor } from '../roles/selection-advisor.js';
import { getHudHome } from '../hud-home.js';
import { setDisplayConfig } from '../render/hud-config.js';
import { resolveLanguage, setLanguage, t } from '../render/i18n.js';
import { monitorText } from '../render/monitor-text.js';
import {
  applyComposerKey,
  createComposerState,
  excerptDisplayLines,
  renderAdvisorConversation,
  renderSelectSendComposer,
  type ComposerKey,
  type ComposerState,
} from '../render/select-send-composer.js';
import {
  captureSelectionBaseline,
  contextPaneId,
  deliverSelection,
  formatSelectionMessage,
  handleInvestigatePaneAction,
  handleSelectionAction,
  normalizePaneExcerpt,
  normalizeSelectionExcerpt,
  normalizeQuestion,
  parsePluginContext,
  retrySelectionAction,
  readAndRemoveSelectionHandoff,
  readPaneVisibleText,
  refreshSelectionExcerpt,
  resolveSelectionTarget,
  waitAndRetryGuardedPrompt,
  type PluginSelectionContext,
} from '../roles/select-send.js';
import { herdrEndpoint, request as herdrRequest } from '../runtime/herdr-socket.js';
import { loadSettings } from '../settings.js';
import type { HudIO } from './hud.js';
import { CliError } from './private-home.js';

export const SELECT_SEND_HELP =
  'Usage: hud select-send --action             Invoked by the herdr selection plugin action\n' +
  '       hud select-send --investigate        Invoked by the herdr pane investigate plugin action\n' +
  '       hud select-send --composer [--file PATH]  Open the selection composer in the current terminal\n' +
  '       hud select-send --recover-draft      Open the last selection held because the popup was busy\n';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export class ComposerKeyDecoder {
  private pending = '';
  private pasting = false;
  private pasteBuf = '';
  private readonly utf8 = new StringDecoder('utf8');

  push(chunk: Buffer | string): ComposerKey[] {
    this.pending += typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    const out: ComposerKey[] = [];
    while (this.pending.length) {
      if (this.pasting) {
        const end = this.pending.indexOf(PASTE_END);
        if (end < 0) {
          const keep = Math.min(this.pending.length, PASTE_END.length - 1);
          this.pasteBuf += this.pending.slice(0, this.pending.length - keep);
          this.pending = this.pending.slice(this.pending.length - keep);
          break;
        }
        this.pasteBuf += this.pending.slice(0, end);
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.pasting = false;
        if (this.pasteBuf) out.push({ type: 'text', text: this.pasteBuf });
        this.pasteBuf = '';
        continue;
      }
      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.pasting = true;
        continue;
      }
      if (this.pending[0] === '\x1b') {
        if (this.pending.length === 1) {
          out.push({ type: 'cancel' });
          this.pending = '';
          break;
        }
        const seq3 = this.pending.slice(0, 3);
        const seq4 = this.pending.slice(0, 4);
        if (seq3 === '\x1b[A' || seq3 === '\x1bOA') { out.push({ type: 'scroll', delta: -1 }); this.pending = this.pending.slice(3); continue; }
        if (seq3 === '\x1b[B' || seq3 === '\x1bOB') { out.push({ type: 'scroll', delta: 1 }); this.pending = this.pending.slice(3); continue; }
        if (seq3 === '\x1b[C' || seq3 === '\x1bOC') { out.push({ type: 'right' }); this.pending = this.pending.slice(3); continue; }
        if (seq3 === '\x1b[D' || seq3 === '\x1bOD') { out.push({ type: 'left' }); this.pending = this.pending.slice(3); continue; }
        if (seq3 === '\x1b[H' || seq3 === '\x1bOH') { out.push({ type: 'home' }); this.pending = this.pending.slice(3); continue; }
        if (seq3 === '\x1b[F' || seq3 === '\x1bOF') { out.push({ type: 'end' }); this.pending = this.pending.slice(3); continue; }
        if (seq4 === '\x1b[3~') { out.push({ type: 'delete' }); this.pending = this.pending.slice(4); continue; }
        if (seq4 === '\x1b[5~') { out.push({ type: 'scroll', delta: -5 }); this.pending = this.pending.slice(4); continue; }
        if (seq4 === '\x1b[6~') { out.push({ type: 'scroll', delta: 5 }); this.pending = this.pending.slice(4); continue; }
        if (seq4 === '\x1b[1~' || seq4 === '\x1b[7~') { out.push({ type: 'home' }); this.pending = this.pending.slice(4); continue; }
        if (seq4 === '\x1b[4~' || seq4 === '\x1b[8~') { out.push({ type: 'end' }); this.pending = this.pending.slice(4); continue; }
        // Drop unknown escape sequences without inserting garbage.
        const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(this.pending);
        if (csi) { this.pending = this.pending.slice(csi[0].length); continue; }
        this.pending = this.pending.slice(1);
        continue;
      }
      const ch = String.fromCodePoint(this.pending.codePointAt(0)!);
      this.pending = this.pending.slice(ch.length);
      if (ch === '\r' || ch === '\n') out.push({ type: 'enter' });
      else if (ch === '\t') out.push({ type: 'targets' });
      else if (ch === '\x03' || ch === '\x04') out.push({ type: 'cancel' });
      else if (ch === '\x7f' || ch === '\b') out.push({ type: 'backspace' });
      else if (ch === '\x15') out.push({ type: 'clear-line' });
      else if (ch === '\x01') out.push({ type: 'home' });
      else if (ch === '\x05') out.push({ type: 'end' });
      else if (ch >= ' ') out.push({ type: 'text', text: ch });
    }
    return out;
  }
}

function configureDisplay(env: NodeJS.ProcessEnv): void {
  try {
    const settings = loadSettings(env);
    setDisplayConfig({
      theme: env.NO_COLOR !== undefined && env.NO_COLOR !== '' ? 'none' : settings.theme,
      icons: settings.icons,
      barStyle: settings.barStyle,
      barFields: settings.barFields,
    });
    setLanguage(resolveLanguage(settings.language, env));
  } catch {
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') setDisplayConfig({ theme: 'none' });
    setLanguage(resolveLanguage('auto', env));
  }
}

export interface ComposerSessionOptions {
  context?: PluginSelectionContext;
  advisorId?: string;
  hudHome: string;
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  stdout: NodeJS.WritableStream & { isTTY?: boolean; columns?: number; rows?: number };
  now?: () => Date;
  onFrame?: (lines: string[], state: ComposerState) => void;
}

export async function runComposerSession(opts: ComposerSessionOptions): Promise<{
  code: number;
  sent: boolean;
  message?: string;
  targetPane?: string | null;
}> {
  configureDisplay(opts.env);
  const now = opts.now ?? (() => new Date());
  let advisorId = opts.advisorId;
  let advisor = advisorId ? readSelectionAdvisor(opts.hudHome, advisorId) : undefined;
  if (advisorId && !advisor) return { code: 1, sent: false };
  let ctx = advisor ? {} : opts.context ?? {};
  const mode = ctx.mode ?? 'selection';
  const investigate = mode === 'investigate';
  let excerpt = investigate ? normalizePaneExcerpt(ctx.selected_text) : normalizeSelectionExcerpt(advisor?.excerpt ?? ctx.selected_text);
  let stale = investigate ? false : Boolean(ctx.stale_content);

  if (investigate) {
    if (excerpt.empty) {
      const paneId = contextPaneId(ctx);
      if (paneId) {
        const rawText = await readPaneVisibleText(paneId, opts.env);
        if (rawText === null) return { code: 1, sent: false };
        excerpt = normalizePaneExcerpt(rawText);
        ctx = { ...ctx, pane_id: paneId, selected_text: excerpt.text, stale_content: false, selection: undefined };
      }
    }
  } else if (stale || (excerpt.empty && ctx.selection)) {
    const refreshed = await refreshSelectionExcerpt(ctx, excerpt, null, opts.env);
    excerpt = refreshed.excerpt;
    stale = refreshed.stale;
    ctx = {
      ...ctx,
      selected_text: excerpt.text,
      stale_content: false,
      ...(ctx.selection ? { selection: { ...ctx.selection, content_revision: undefined } } : {}),
    };
  }

  if (excerpt.empty) return { code: 0, sent: false };

  let baseline = advisor || investigate ? null : await captureSelectionBaseline(ctx, excerpt, opts.env);
  const resolved = advisor ? { source: advisor.source, targetPane: null, targetAgent: null, jobs: [] }
    : await resolveSelectionTarget(ctx, opts.hudHome, opts.env, now());

  let state = createComposerState({
    mode,
    source: resolved.source,
    targetPane: resolved.targetPane,
    targetAgent: resolved.targetAgent,
    jobs: resolved.jobs,
    excerpt,
    stale,
    error: investigate
      ? (resolved.jobs.length ? null : t('No working jobs found for this project.'))
      : (advisor || resolved.targetPane ? null : t('No main session found for this project.')),
  });

  const isTty = Boolean(opts.stdin.isTTY && opts.stdout.isTTY);
  const size = () => ({
    width: Math.max(20, opts.stdout.columns ?? (Number(opts.env.COLUMNS) || 80)),
    height: Math.max(6, opts.stdout.rows ?? (Number(opts.env.LINES) || 18)),
  });

  const conversation = () => {
    if (!advisor) return;
    const { width, height } = size();
    const phase = advisorPhase(opts.hudHome, advisor, now().getTime());
    return renderAdvisorConversation(advisor, state, phase, width, height);
  };
  const paint = () => {
    const lines = conversation()?.lines ?? renderSelectSendComposer(state, { ...size(), nowMs: now().getTime() });
    opts.onFrame?.(lines, state);
    if (isTty) {
      opts.stdout.write('\x1b[H' + lines.join('\r\n'));
    }
  };

  if (isTty) {
    opts.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
    opts.stdin.setRawMode?.(true);
  }
  opts.stdin.resume();

  const decoder = new ComposerKeyDecoder();
  let submission: AbortController | undefined;

  return new Promise((resolve) => {
    let finished = false;
    const refreshAdvisor = () => {
      if (advisorId) advisor = readSelectionAdvisor(opts.hudHome, advisorId) ?? advisor;
    };
    const poll = setInterval(() => {
      if (!advisorId || finished) return;
      refreshAdvisor();
      paint();
    }, 750);
    poll.unref();
    const onResize = () => { if (!finished) paint(); };
    const done = (result: { code: number; sent: boolean; message?: string; targetPane?: string | null }) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      submission?.abort();
      opts.stdin.off('data', onData);
      opts.stdin.off('end', onEnd);
      if (isTty && 'off' in opts.stdout) opts.stdout.off('resize', onResize);
      if (isTty) {
        opts.stdin.setRawMode?.(false);
        opts.stdout.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
      }
      opts.stdin.pause();
      resolve(result);
    };

    const submit = async () => {
      if (submission || finished) return;
      const targetPane = state.targetPane;
      const targetJob = state.targetJob;
      const askAdvisor = state.targetAdvisor;
      const note = state.noteForNextTurn ? normalizeQuestion(state.question) : undefined;
      if (note === '') {
        state = { ...state, error: t('Enter a note before saving.') };
        paint();
        return;
      }
      if (investigate) {
        if (!targetJob) {
          state = { ...state, error: t(state.jobs.length ? 'Choose a working job first.' : 'No working jobs found for this project.') };
          paint();
          return;
        }
        if (!state.source.projectRoot) {
          state = { ...state, error: t('Could not determine the project for this pane.') };
          paint();
          return;
        }
      } else if (!advisorId && !targetPane && !targetJob && !askAdvisor) {
        state = { ...state, error: t('No main session found for this project.') };
        paint();
        return;
      }
      submission = new AbortController();
      const { signal } = submission;
      state = { ...state, phase: 'sending', error: null };
      paint();
      try {
        if (advisorId && advisor) {
          const question = normalizeQuestion(state.question);
          const ending = question === '/end';
          const limit = (advisor.advisor?.followups.length ?? 0) >= MAX_ADVISOR_FOLLOWUPS;
          const ok = ending ? await endSelectionAdvisor(opts.hudHome, advisorId)
            : !limit && !!question && await continueSelectionAdvisor(opts.hudHome, advisorId, question);
          refreshAdvisor();
          state = { ...state, phase: 'editing', ...(ok ? { question: '', cursor: 0, scroll: 0 }
            : { error: t(ending ? 'Could not end advisor' : limit ? 'Advisor follow-up limit reached' : 'Follow-up not sent. Draft kept.') }) };
          if (!finished) paint();
          return;
        }
        // Investigate and annotations keep the displayed snapshot, even if the log scrolls during editing.
        const refreshed = !investigate && note === undefined
          ? await refreshSelectionExcerpt(ctx, state.excerpt, baseline, opts.env)
          : null;
        if (finished) return;
        if (refreshed?.baseline !== undefined) baseline = refreshed.baseline;
        const emptyNotice = state.mode === 'investigate'
          ? t('Pane has no visible output; nothing to send.')
          : t('Selection is empty; nothing to send.');
        if (refreshed?.stale && refreshed.changed) {
          ctx = {
            ...ctx,
            selected_text: refreshed.excerpt.text,
            stale_content: false,
            ...(ctx.selection ? { selection: { ...ctx.selection, content_revision: undefined } } : {}),
          };
          state = {
            ...state,
            phase: 'editing',
            stale: true,
            excerpt: refreshed.excerpt,
            scroll: 0,
            notice: refreshed.excerpt.empty
              ? emptyNotice
              : t('Content changed — review latest excerpt and press Enter to send.'),
          };
          paint();
          return;
        }
        if (state.excerpt.empty) {
          state = { ...state, phase: 'editing', notice: emptyNotice };
          paint();
          return;
        }
        const source = { ...state.source, time: now().toISOString() };
        if (askAdvisor) {
          const result = await startSelectionAdvisor(opts.hudHome, { excerpt: state.excerpt.text, source, question: state.question }, opts.env);
          advisor = result.advisor;
          advisorId = advisor?.id;
          state = { ...state, phase: 'editing', ...(advisor ? { question: '', cursor: 0, scroll: 0 }
            : { error: [t('Could not start advisor. Draft kept.'), result.error].filter(Boolean).join(' ') }) };
          if (!finished) paint();
          return;
        }
        if (note !== undefined || (targetJob && source.projectRoot)) {
          if (!targetJob || !source.projectRoot) throw new Error('missing selection target');
          const input = {
            excerpt: state.excerpt.text, source: { ...source, project: source.project?.slice(0, 256) ?? null },
            target: targetJob.job, launchId: targetJob.launchId, role: targetJob.role.slice(0, 256),
          };
          if (note !== undefined) {
            const record = await recordSelectionNote(opts.hudHome, { ...input, note }, herdrEndpoint(opts.env), signal);
            if (!record) throw new Error('unavailable note target');
            done({ code: 0, sent: record.delivery === 'pending' });
            return;
          }
          const record = await recordSelectionExcerpt(opts.hudHome, { ...input, question: normalizeQuestion(state.question) });
          const message = formatSelectionMessage({ ...record, excerptId: record.id });
          let delivery: ExcerptDelivery = 'delivery unknown';
          const { hudHome } = await import('../mcp/store/job-store.js');
          // The runtime's job store is process-scoped; never send to a different configured home.
          if (hudHome === resolvePath(opts.hudHome)) {
            const { sendJob } = await import('../mcp/dispatch/orchestrator.js');
            if (!signal.aborted) {
              const sent = await sendJob(targetJob.job, message, record.id, true, {
                selection: { project: source.projectRoot, launchId: record.launchId },
              });
              if ('ok' in sent && sent.ok) delivery = 'queued';
              else if ('code' in sent && sent.code === 'target_ended') delivery = 'target ended';
            }
          }
          await setExcerptDelivery(opts.hudHome, record.id, delivery);
          if (finished) return;
          if (delivery === 'queued') {
            done({ code: 0, sent: true, message });
            return;
          }
          const remaining = state.jobs.filter(job => job !== targetJob);
          const endedError = state.mode === 'investigate'
            ? t(remaining.length ? 'Target ended. Press Tab to choose another working job.' : 'Target ended. No working jobs left.')
            : t(targetPane ? 'Target ended. Enter sends to main.' : 'Target ended. No main session found.');
          state = delivery === 'target ended'
            ? { ...state, phase: 'editing', targetJob: undefined, jobs: remaining, error: endedError }
            : { ...state, phase: 'editing', error: t('Selection delivery unknown.') };
          paint();
          return;
        }
        if (state.mode === 'investigate' || !targetPane) return;
        const message = formatSelectionMessage({ excerpt: state.excerpt.text, source, question: state.question });
        let delivery = await deliverSelection(targetPane, message, opts.hudHome, opts.env, signal);
        if (finished) return;
        if (delivery.retryPrompt) {
          state = { ...state, phase: 'waiting' };
          paint();
          delivery = await waitAndRetryGuardedPrompt(targetPane, message, opts.hudHome, delivery.retryPrompt, opts.env, signal);
          if (finished) return;
        }
        if (!delivery.ok) {
          state = { ...state, phase: 'editing', error: t(delivery.error ?? 'Delivery failed.') };
          paint();
          return;
        }
        done({ code: 0, sent: true, message, targetPane });
      } catch {
        if (!finished) {
          state = { ...state, phase: 'editing', error: t(advisorId ? 'Advisor action failed. Draft kept.'
            : askAdvisor ? 'Could not start advisor. Draft kept.' : note !== undefined ? 'Note could not be saved.'
              : targetJob ? 'Selection delivery unknown.' : 'Delivery failed.') };
          paint();
        }
      } finally {
        submission = undefined;
      }
    };

    const onData = (chunk: Buffer | string) => {
      if (finished) return;
      const { width, height } = size();
      const bannerRows = state.error || state.phase !== 'editing' || state.notice || state.stale ? 1 : 0;
      const viewportRows = Math.max(1, height - bannerRows - 4);
      const maxScroll = conversation()?.maxScroll ?? Math.max(0, excerptDisplayLines(state.excerpt, Math.max(1, width - 2)).length - viewportRows);
      for (const key of decoder.push(chunk)) {
        if (advisor && (key.type === 'targets' || (advisor.advisor?.ended && key.type !== 'cancel' && key.type !== 'scroll'))) continue;
        const next = applyComposerKey(state, advisor && key.type === 'scroll' ? { ...key, delta: -key.delta } : key, maxScroll);
        state = next.state;
        if (next.intent === 'cancel') {
          done({ code: 0, sent: false });
          return;
        }
        if (next.intent === 'submit') void submit();
      }
      if (!submission) paint();
    };

    const onEnd = () => done({ code: 0, sent: false });
    if (isTty && 'on' in opts.stdout) {
      opts.stdout.on('resize', onResize);
    }

    opts.stdin.on('data', onData);
    opts.stdin.on('end', onEnd);
    paint();
  });
}

export async function runSelectSendAction(env: NodeJS.ProcessEnv = process.env, retry = false): Promise<number> {
  const home = getHudHome(env);
  const result = retry ? await retrySelectionAction(home, env) : await handleSelectionAction(home, env);
  if (result.opened) return 0;

  configureDisplay(env);
  const empty = result.reason === 'empty_selection';
  const busy = result.reason === 'ui_busy';
  const title = empty
    ? t('No selection to send — select text with the mouse first.')
    : busy ? t('Popup busy. Draft kept. Run hud select-send --recover-draft.') : t('Could not open the selection composer.');
  const body = !empty && !busy && result.reason && result.reason !== 'popup_open_failed' ? monitorText(result.reason) : '';
  const reply = herdrEndpoint(env)
    ? await herdrRequest('notification.show', { title, ...(body ? { body } : {}) }, { env }).catch(() => null)
    : null;
  // Herdr captures action stderr in its plugin logs; it is not itself a toast.
  if (!empty || reply?.result?.shown !== true) {
    process.stderr.write(`select-send: ${title}${body ? ` ${body}` : ''}\n`);
  }
  return empty ? 0 : 1;
}

export async function runInvestigatePaneAction(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const result = await handleInvestigatePaneAction(getHudHome(env), env);
  if (result.opened) return 0;

  configureDisplay(env);
  const soft = result.reason === 'empty_pane' || result.reason === 'no_pane';
  const title = result.reason === 'empty_pane'
    ? t('No visible pane output to send.')
    : result.reason === 'no_pane'
      ? t('No pane found to investigate.')
      : result.reason === 'pane_read_failed'
        ? t("Could not read the pane's visible region; nothing sent.")
        : t('Could not open the investigate composer.');
  const body = !soft && result.reason && result.reason !== 'popup_open_failed' && result.reason !== 'pane_read_failed'
    ? monitorText(result.reason)
    : '';
  const reply = herdrEndpoint(env)
    ? await herdrRequest('notification.show', { title, ...(body ? { body } : {}) }, { env }).catch(() => null)
    : null;
  if (!soft || reply?.result?.shown !== true) {
    process.stderr.write(`select-send: ${title}${body ? ` ${body}` : ''}\n`);
  }
  return soft ? 0 : 1;
}

export async function runSelectSendComposer(env: NodeJS.ProcessEnv = process.env, file?: string): Promise<number> {
  const hudHome = getHudHome(env);
  const handoffPath = file || env.HUD_SELECT_SEND_FILE;
  const advisorId = handoffPath ? undefined : env.HUD_SELECTION_ADVISOR_ID;
  const context = advisorId ? undefined : handoffPath ? readAndRemoveSelectionHandoff(handoffPath) ?? undefined : parsePluginContext(env);
  if (!context && !advisorId) return 0;
  const outcome = await runComposerSession({
    context,
    advisorId,
    hudHome,
    env,
    stdin: process.stdin,
    stdout: process.stdout,
  });
  process.stdin.unref?.();
  return outcome.code;
}

export async function selectSendCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(SELECT_SEND_HELP);
    return 0;
  }
  if (args.length === 1 && args[0] === '--action') {
    return runSelectSendAction(io.env);
  }
  if (args.length === 1 && args[0] === '--investigate') {
    return runInvestigatePaneAction(io.env);
  }
  if (args.length === 1 && args[0] === '--recover-draft') return runSelectSendAction(io.env, true);
  if (args[0] === '--composer' && (args.length === 1 || (args.length === 3 && args[1] === '--file' && args[2]))) {
    return runSelectSendComposer(io.env, args[2]);
  }
  throw new CliError(SELECT_SEND_HELP.trimEnd());
}
