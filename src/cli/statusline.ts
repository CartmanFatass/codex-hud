import { truncateAnsi } from '../render/colors.js';
import { readRoleSummary } from '../roles/role-summary.js';
import { renderRoleSummary } from '../render/role-summary.js';
import { NativeCallCollector } from '../collectors/native-calls.js';
import { nativeCallLabel, jevCallLabel } from '../core/link/view-model.js';
import { statuslineRef } from '../core/statusline-summary.js';
import { monitorText } from '../render/monitor-text.js';
import { fileURLToPath } from 'node:url';
import { statuslinePreview } from '../statusline-preview.js';
import { statuslineSettings } from '../statusline-settings.js';
import { readStatuslineSummary } from '../core/statusline-summary.js';
import { renderStatuslineSession, type StatuslineSessionOptions } from '../render/statusline-session.js';
import { renderStatuslineSummary } from '../render/statusline-summary.js';
import type { HudIO } from './link-export.js';

export const STATUSLINE_HELP = `Usage: hud statusline [--width COLUMNS] [--source ABSOLUTE_CLAUDE_ROOT]
       hud statusline --details [--lang en|zh] [--width COLUMNS] [--source ABSOLUTE_CLAUDE_ROOT]
       hud statusline settings preview
       hud statusline settings apply --plan ABSOLUTE_FILE
       hud statusline settings restore --backup ABSOLUTE_FILE
       hud-statusline [same arguments]

Render stdin Claude facts, with a bounded read-only delegation line when available.
Delegation source: --source or explicit CLAUDE_CONFIG_DIR; no guessed source/home.
Direct-child fallback is partial, never a full-tree total. Missing data keeps line 1.
No transcript reading, collection, network access or installation by default.
Settings commands are explicit Linux opt-in operations under HOME/.claude.
Preview before apply; keep the returned backup path for exact restore.
USD is the provider's estimated session cost, not an invoice.
--details opts into native facts and a context bar; --lang en|zh requires --details (default en).
Compact output remains the default; presentation options do not change settings.
See docs/statusline/native-details.md for fields, widths and validation limits.
See docs/statusline/product-settings.md for safety and recovery limits.
`;

export async function statuslineCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(STATUSLINE_HELP);
    return 0;
  }
  if (args[0] === 'settings') {
    try {
      const result = statuslineSettings(
        args.slice(1),
        io.env.HOME ?? '',
        process.execPath,
        fileURLToPath(new URL('../../bin/hud-statusline', import.meta.url))
      );
      await io.stdout(JSON.stringify(result, null, 2) + '\n');
      return 0;
    } catch {
      io.stderr('statusline_settings_failed: invalid input, changed settings, unsafe path, or unavailable build\n');
      return 2;
    }
  }
  let sourceRoot: string | undefined;
  const widthArgs: string[] = [];
  const options: StatuslineSessionOptions = {};
  if (args.includes('--details') || args.includes('--lang')) {
    let sawLanguage = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--details' && options.details !== true) {
        options.details = true;
      } else if (arg === '--lang' && !sawLanguage && ['en', 'zh'].includes(args[index + 1])) {
        sawLanguage = true;
        options.language = args[++index] as 'en' | 'zh';
      } else if (
        arg === '--source' &&
        sourceRoot === undefined &&
        args[index + 1] &&
        !args[index + 1].startsWith('--')
      ) {
        sourceRoot = args[++index];
      } else if (arg === '--width' && index + 1 < args.length) {
        // Consume the immediate token, even another flag. The existing protocol validates width.
        widthArgs.push(arg, args[++index]);
      } else {
        io.stderr('invalid_arguments\n');
        return 2;
      }
    }
    if (sawLanguage && options.details !== true) {
      io.stderr('invalid_arguments\n');
      return 2;
    }
  } else {
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--source') {
        if (sourceRoot !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) {
          io.stderr('invalid_arguments\n');
          return 2;
        }
        sourceRoot = args[++index];
      } else widthArgs.push(args[index]);
    }
  }
  return statuslinePreview(widthArgs, process.stdin, {
    columns: io.env.COLUMNS,
    ttyColumns: process.stdout.isTTY ? process.stdout.columns : undefined,
    stdout: async (text) => {
      await io.stdout(text);
    },
    stderr: io.stderr,
    render: async (value, width) => {
      const first = renderStatuslineSession(value, width, options);
      const nowMs = Date.now();
      const readStarted = performance.now();
      let role = '';
      try {
        const selected = statuslineRef(value, sourceRoot ?? io.env.CLAUDE_CONFIG_DIR);
        if (selected && selected.ref.threadId === null)
          role = renderRoleSummary(
            readRoleSummary(io.env, `${selected.ref.sourceId}/${selected.ref.sessionId}`, {
              nowMs,
              budgetMs: Math.max(0, 20 - (performance.now() - readStarted)),
            }),
            width
          );
      } catch {
        /* Missing identity/cache is unavailable, never an empty work total. */
      }
      const summary = await readStatuslineSummary(value, io.env, sourceRoot, {
        nowMs,
        budgetMs: Math.max(0, 20 - (performance.now() - readStarted)),
      });
      const second = renderStatuslineSummary(summary, width, nowMs);
      let direct = '';
      try {
        const parent = statuslineRef(value, sourceRoot ?? io.env.CLAUDE_CONFIG_DIR);
        if (parent) {
          const calls = NativeCallCollector.fromEnv(io.env);
          await calls.collect(parent.ref);
          const view = calls.merge(null);
          const labels = Object.values(view?.details ?? {}).flatMap((detail) =>
            detail.nativeCall
              ? [`${detail.nativeCall.relation.child.harness}: ${nativeCallLabel(detail.nativeCall)}`]
              : detail.jevCall
                ? [`jev: ${jevCallLabel(detail.jevCall)}`]
                : []
          );
          if (labels.length) direct = truncateAnsi(monitorText(`Native calls: ${labels.join(' · ')}`), width);
        }
      } catch {
        /* Keep the original native line and legacy summary on unavailable sources. */
      }
      return [first, second, direct, role].filter(Boolean).join('\n');
    },
  });
}
