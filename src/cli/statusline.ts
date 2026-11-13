import { getHudHome } from '../hud-home.js';
import { readThinJobs } from '../collectors/thin-jobs.js';
import { renderWorkSummary, workSignals } from '../render/work-summary.js';
import { fileURLToPath } from 'node:url';
import { visualLength } from '../render/colors.js';
import { statuslinePreview } from '../statusline-preview.js';
import { applyBarSettings } from '../bar-settings.js';
import { NOTICE_MS } from '../render/layout/bar-fields.js';
import { renderStatuslineSession, type StatuslineSessionOptions } from '../render/statusline-session.js';
import type { HudIO } from './hud.js';
import { loadParitySettings, paritySettings } from '../statusline-parity/settings.js';
import { collectAndRenderParity } from '../statusline-parity/collect.js';
import { forwardInput } from '../statusline-parity/forward.js';

export const STATUSLINE_HELP = `Usage: hud statusline [--width COLUMNS] [--source ABSOLUTE_CLAUDE_ROOT]
       hud statusline --details [--lang en|zh] [--width COLUMNS] [--source ABSOLUTE_CLAUDE_ROOT]
       hud statusline import --from ABS [--settings ABS] [--apply]
       hud statusline settings preview [--shim-dir ABS]
       hud statusline settings apply --plan ABSOLUTE_FILE
       hud statusline settings restore --backup ABSOLUTE_FILE
       hud-statusline [same arguments]

Render stdin Claude facts, with Work counts from this pane's job folders.
No transcript reading, collection, network access or installation by default.
The shared bar uses HUD config.json statusline preferences, or defaults when absent.
Import previews that section without writes; --apply writes HUD configuration only.
Settings commands are explicit Linux opt-in operations under HOME/.claude.
Preview before apply; keep the returned backup path for exact restore.
USD is the provider's estimated session cost, not an invoice.
--details opts into native facts and a context bar; --lang en|zh requires --details (default en).
Compact output remains the default; presentation options do not change settings.
See docs/reference.md (Claude statusline and shared facts) for fields, settings and recovery.
`;

export async function statuslineCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    await io.stdout(STATUSLINE_HELP);
    return 0;
  }
  if (args[0] === 'import') {
    try {
      const { importStatusline } = await import('../statusline-parity/import.js');
      await io.stdout(JSON.stringify(importStatusline(args.slice(1), io.env), null, 2) + '\n');
      return 0;
    } catch (e) {
      const reason = (e instanceof Error ? e.message : 'invalid input')
        .slice(0, 512)
        .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '?');
      io.stderr(`statusline_import_failed: ${reason}\n`);
      return 2;
    }
  }
  if (args[0] === 'settings') {
    try {
      const { statuslineSettings } = await import('../statusline-settings.js');
      const result = statuslineSettings(
        args.slice(1),
        io.env.HOME ?? '',
        process.execPath,
        fileURLToPath(new URL('../../bin/hud-statusline', import.meta.url)),
        io.env
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
  const parity = loadParitySettings(io.env) ?? paritySettings({});
  const tty = process.stdout.isTTY ? process.stdout.columns : undefined;
  const columns = parity
    ? String(
        Math.max(
          1,
          Math.min(
            500,
            (/^[1-9]\d*$/.test(io.env.COLUMNS ?? '') ? Number(io.env.COLUMNS) : (tty ?? 120)) - parity.widthMargin
          )
        )
      )
    : io.env.COLUMNS;
  return statuslinePreview(widthArgs, process.stdin, {
    columns,
    ttyColumns: tty,
    onInput: parity ? (bytes) => forwardInput(parity.forward, bytes, io.env) : undefined,
    stdout: async (text) => {
      await io.stdout(text);
    },
    stderr: io.stderr,
    render: async (value, width) => {
      const now = Date.now();
      const lanes = readThinJobs(getHudHome(io.env), { project: null, pane: io.env.HERDR_PANE_ID ?? null }, undefined,
        parity && !options.details ? { settledBefore: now - NOTICE_MS } : undefined);
      // The bar is one line: what the jobs ask and just did are events of its notice zone, not a row below.
      if (parity && !options.details) {
        applyBarSettings();
        return collectAndRenderParity(value, width, parity, io.env, now, workSignals(lanes, now));
      }
      const first = renderStatuslineSession(value, width, options);
      const work = renderWorkSummary(lanes, width, now);
      if (options.details) return [first, work].filter(Boolean).join('\n');
      const line = [first, work].filter(Boolean).join(' │ ');
      return visualLength(line) <= width ? line : first;
    },
  });
}
