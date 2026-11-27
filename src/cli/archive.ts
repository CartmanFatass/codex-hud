/** Inspect and extract compressed cold archives under $HUD_HOME/archive/cold/YYYY-MM/. */
import { join, resolve } from 'node:path';
import {
  COLD_ID_RE,
  coldRawCapGB,
  extractColdArchive,
  listColdArchive,
  type ColdArchiveItem,
} from '../roles/cold-archive.js';
import type { HudIO } from './hud.js';
import { CliError, privateHome } from './private-home.js';

const USAGE =
  'Usage: hud archive list [--month YYYY-MM] [--json]\n' +
  '       hud archive extract <id> [--out DIR] [--part all|text|raw] [--json]\n';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function formatList(items: readonly ColdArchiveItem[], capGB: number): string {
  if (!items.length) return `No cold archive entries (raw cap: ${capGB} GB).\n`;
  let textTotal = 0;
  let rawTotal = 0;
  const lines = items.map((item) => {
    textTotal += item.text?.size ?? 0;
    rawTotal += item.raw?.size ?? 0;
    const textCol = item.text ? formatBytes(item.text.size) : '-';
    const rawCol = item.raw ? formatBytes(item.raw.size) : '-';
    return `${item.month}  ${item.id}  text=${textCol}  raw=${rawCol}`;
  });
  lines.push(`Total: ${items.length} entries, text ${formatBytes(textTotal)}, raw ${formatBytes(rawTotal)} (cap ${capGB} GB)`);
  return lines.join('\n') + '\n';
}

export async function archiveCommand(args: readonly string[], io: HudIO): Promise<number> {
  if (!args.length || (args.length === 1 && (args[0] === '--help' || args[0] === 'help'))) {
    await io.stdout(USAGE);
    return 0;
  }
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'list') {
    let month: string | undefined;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === '--json') {
        json = true;
      } else if (arg === '--month') {
        const value = rest[++i];
        if (!value || !/^\d{4}-\d{2}$/.test(value)) throw new CliError('invalid --month (expected YYYY-MM)');
        month = value;
      } else {
        throw new CliError(USAGE.trimEnd());
      }
    }
    const home = privateHome(io.env);
    const items = listColdArchive(home, { month });
    const capGB = coldRawCapGB(home);
    if (json) {
      await io.stdout(JSON.stringify({ cap_gb: capGB, items }, null, 2) + '\n');
    } else {
      await io.stdout(formatList(items, capGB));
    }
    return 0;
  }
  if (sub === 'extract') {
    const id = rest[0];
    if (!id || !COLD_ID_RE.test(id)) throw new CliError('invalid or missing archive id (expected j/q/b/w + 16 hex)');
    let outDir: string | undefined;
    let part: 'all' | 'text' | 'raw' = 'all';
    let json = false;
    for (let i = 1; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === '--out') {
        const value = rest[++i];
        if (!value) throw new CliError('missing value for --out');
        outDir = value;
      } else if (arg === '--part') {
        const value = rest[++i];
        if (value !== 'all' && value !== 'text' && value !== 'raw') throw new CliError('invalid --part (expected all|text|raw)');
        part = value;
      } else if (arg === '--json') {
        json = true;
      } else {
        throw new CliError(USAGE.trimEnd());
      }
    }
    const home = privateHome(io.env);
    const target = resolve(outDir ?? join(process.cwd(), id));
    let extracted: Awaited<ReturnType<typeof extractColdArchive>>;
    try {
      extracted = await extractColdArchive(home, id, target, part);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') {
        throw new CliError(`target path already exists (extract requires a new directory): ${target}`);
      }
      if (err.code === 'ELOOP' || err.code === 'ENOTDIR') {
        throw new CliError(`unsafe extraction target: ${err.message}`);
      }
      throw error;
    }
    if (!extracted) throw new CliError(`archive_not_found: ${id}`);
    if (json) {
      await io.stdout(JSON.stringify(extracted, null, 2) + '\n');
    } else {
      await io.stdout(`Extracted ${extracted.files.length} files (${extracted.parts.join('+')}) for ${extracted.id} (${extracted.month}) to ${extracted.outDir}\n`);
    }
    return 0;
  }
  throw new CliError(USAGE.trimEnd());
}
