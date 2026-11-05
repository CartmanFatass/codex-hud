import { RunArtifacts } from '../core/run/artifacts.js';
import type { DelegationViewModel } from '../core/link/view-model.js';
import { sameDelegationActionTarget } from './delegation-actions.js';
import { fit, monitorText, wrapped } from '../render/monitor-text.js';
import { monitorKey } from './panel-command.js';
import type { WorkbenchInput } from './workbench-input.js';

export const LOG_PAGE_BYTES = 16 * 1024;
export interface LogContext {
  vm: DelegationViewModel | null;
  root: string;
  epoch: number;
  selected: string | null | undefined;
}
export interface LogFrame {
  lines: string[];
  controls: Array<{
    action: 'stream' | 'previous' | 'next' | 'refresh' | 'close';
    x: number;
    y: number;
    width: number;
  }>;
}
/** No terminal control from a run is ever replayed. Keep LF for layout; expose all other controls as text. */
export function safeLogText(data: Buffer): string {
  return data.toString('utf8').split('\n').map(monitorText).join('\n');
}

/** One fixed run, one bounded page. All disk reads happen on input, never during paint. */
export class DelegationLogView {
  private view: {
    context: LogContext;
    key: string;
    artifacts: RunArtifacts;
    runId: string;
    stream: 'stdout' | 'stderr';
    offset: number;
    next: number;
    more: boolean;
    text: string;
    scroll: number;
    error: string | null;
  } | null = null;

  get isOpen(): boolean {
    return this.view !== null;
  }
  close(): void {
    this.view = null;
  }
  valid(context: LogContext): boolean {
    const v = this.view;
    return (
      !!v &&
      v.context.root === context.root &&
      v.context.epoch === context.epoch &&
      context.selected === v.key &&
      sameDelegationActionTarget(v.context.vm ?? undefined, context.vm, v.key)
    );
  }
  open(home: string, key: string, context: LogContext): boolean {
    this.close();
    const run = context.vm?.tree.nodes.find((node) => node.key === key)?.currentRun;
    if (!run || run.mode !== 'headless' || context.selected !== key) return false;
    try {
      this.view = {
        context,
        key,
        artifacts: RunArtifacts.open(home, run.runId),
        runId: run.runId,
        stream: 'stdout',
        offset: 0,
        next: 0,
        more: false,
        text: '',
        scroll: 0,
        error: null,
      };
      this.read(context);
      return true;
    } catch {
      this.close();
      return false;
    }
  }
  private read(context: LogContext): void {
    if (!this.valid(context)) {
      this.close();
      return;
    }
    const v = this.view!;
    try {
      const run = v.context.vm?.tree.nodes.find((node) => node.key === v.key)?.currentRun;
      const meta = v.artifacts.readMetaBounded();
      if (
        !run ||
        !meta ||
        meta.run_id !== run.runId ||
        meta.link_id !== run.linkId ||
        meta.source_id !== run.sourceId ||
        meta.binding_generation !== run.expectedGeneration ||
        meta.mode !== 'headless'
      )
        throw new Error('log_metadata_mismatch');
      // The extra byte distinguishes a full last page from a truncated display.
      const chunk = v.artifacts.readLogPinned(v.stream, v.offset, LOG_PAGE_BYTES + 1);
      v.more = chunk.data.length > LOG_PAGE_BYTES;
      const data = chunk.data.subarray(0, LOG_PAGE_BYTES);
      v.next = v.offset + data.length;
      v.text = safeLogText(data);
      v.error = null;
    } catch {
      v.text = '';
      v.more = false;
      v.error = 'Log unavailable: unsafe, replaced or unreadable artifact.';
    }
  }
  input(input: WorkbenchInput, frame: LogFrame | undefined, context: LogContext): void {
    if (!this.valid(context)) {
      this.close();
      return;
    }
    const v = this.view!;
    let action: string = '';
    if (input.type === 'key') action = input.key;
    if (input.type === 'command') action = monitorKey(input.command);
    if (input.type === 'mouse') {
      action =
        input.button === 'wheel-up'
          ? 'up'
          : input.button === 'wheel-down'
            ? 'down'
            : (frame?.controls.find((c) => c.y === input.y && input.x >= c.x && input.x < c.x + c.width)?.action ?? '');
    }
    if (['close', 'escape', 'pane-close'].includes(action)) {
      this.close();
      return;
    }
    if (['stream', 'tab', 'shift-tab'].includes(action)) {
      v.stream = v.stream === 'stdout' ? 'stderr' : 'stdout';
      v.offset = 0;
      v.scroll = 0;
      this.read(context);
    } else if (['next', 'right', 'page-down'].includes(action) && v.more) {
      v.offset = v.next;
      v.scroll = 0;
      this.read(context);
    } else if (['previous', 'left', 'page-up'].includes(action)) {
      v.offset = Math.max(0, v.offset - LOG_PAGE_BYTES);
      v.scroll = 0;
      this.read(context);
    } else if (['refresh', 'reset', 'r', 'log', 'enter'].includes(action)) this.read(context);
    else if (action === 'home') {
      v.offset = 0;
      v.scroll = 0;
      this.read(context);
    } else if (action === 'down') v.scroll++;
    else if (action === 'up') v.scroll = Math.max(0, v.scroll - 1);
  }
  render(width: number, height: number): LogFrame {
    const v = this.view;
    const w = Math.max(1, Math.min(500, width)),
      h = Math.max(1, Math.min(300, height));
    if (!v) return { lines: [], controls: [] };
    if (h < 4) {
      const lines = Array.from({ length: h }, () => ' '.repeat(w));
      if (h > 1) lines[0] = fit('Run log', w);
      lines[h - 1] = fit('[Esc close]', w);
      return { lines, controls: w >= 11 ? [{ action: 'close', x: 0, y: h - 1, width: 11 }] : [] };
    }
    const content = v.error
      ? [v.error]
      : (v.text || '(No bytes available at this offset.)').split('\n').flatMap((line) => wrapped(line, w));
    const available = Math.max(0, h - 4);
    const scroll = Math.min(v.scroll, Math.max(0, content.length - available));
    const controls: LogFrame['controls'] = [];
    let menu = '';
    for (const [label, action] of [
      ['[Tab stream]', 'stream'],
      ['[← prev]', 'previous'],
      ['[→ next]', 'next'],
      ['[r refresh]', 'refresh'],
      ['[Esc close]', 'close'],
    ] as const) {
      if (menu.length + label.length <= w) {
        controls.push({ action, x: menu.length, y: h - 1, width: label.length });
        menu += label + ' ';
      }
    }
    const lines = [
      fit(`Run log · ${monitorText(v.runId)} · ${v.stream}`, w),
      fit(`Bytes ${v.offset}–${v.next} · ${v.more ? 'page truncated; → next' : 'end at read; r refresh'}`, w),
      fit('Tab stream · ↑↓ scroll · ←→ pages · Esc close', w),
      ...content.slice(scroll, scroll + available).map((line) => fit(line, w)),
    ];
    while (lines.length < h - 1) lines.push(' '.repeat(w));
    lines.push(fit(menu.trimEnd(), w));
    return { lines: lines.slice(0, h), controls };
  }
}
