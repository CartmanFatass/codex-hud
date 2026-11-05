import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { queryDelegationExport, type ExportQueryOptions } from '../core/export-query.js';

export const EXPORT_USAGE = 'Usage: hud link export --json --schema-version 1 [--paths local] [--link <linkId> ...]';

export const EXPORT_HELP = `${EXPORT_USAGE}
       hud [link [export]] --help
       hud claude --help
       hud run --help
       hud cache show [--json]
       hud codex [ARG ...]          Existing codex-hud compatibility launcher

Export a complete, read-only snapshot of local delegation metadata to stdout.
--json and --schema-version 1 are required. --link is repeatable; default: all links.
Paths are omitted unless --paths local is given. No files are saved.
HUD_HOME defaults to ~/.hud and must be an absolute, private directory owned by this uid.
The ledger must already exist. Nothing is initialized or migrated.

HUD failures emit one reason-code line on stderr and no JSON.
Node/runtime diagnostics may also appear on stderr; stdout remains the machine-readable channel.

Exit codes:
  0  Success or help
  1  Unexpected internal or output failure
  2  Invalid command, arguments, or export schema version
  3  Invalid, missing, inaccessible, or non-private HUD_HOME
  4  Missing, inaccessible, or invalid ledger
  5  Unsupported ledger storage version or runtime
  6  Export budget exceeded or metadata assembly/validation failed
`;

export interface HudIO {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void | Promise<void>;
  stderr: (text: string) => void;
}

type ParsedExport = { ok: true; options: ExportQueryOptions } | { ok: false; reason: string };

export function parseLinkExport(args: readonly string[]): ParsedExport {
  const seen = new Set<string>();
  const linkIds: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--json', '--schema-version', '--paths', '--link'].includes(flag))
      return { ok: false, reason: 'invalid_arguments' };
    if (flag !== '--link' && seen.has(flag)) return { ok: false, reason: 'duplicate_option' };
    seen.add(flag);
    if (flag === '--json') continue;
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) return { ok: false, reason: 'missing_option_value' };
    if (flag === '--schema-version' && value !== '1') return { ok: false, reason: 'unsupported_export_schema' };
    if (flag === '--paths' && value !== 'local') return { ok: false, reason: 'invalid_paths' };
    if (flag === '--link') {
      if (!value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value) || linkIds.includes(value))
        return { ok: false, reason: 'invalid_scope' };
      linkIds.push(value);
    }
  }
  if (!seen.has('--json')) return { ok: false, reason: 'json_required' };
  if (!seen.has('--schema-version')) return { ok: false, reason: 'schema_version_required' };
  return {
    ok: true,
    options: {
      schemaVersion: 1,
      ...(seen.has('--paths') ? { paths: 'local' } : {}),
      ...(linkIds.length ? { scope: { kind: 'links', linkIds } } : {}),
    },
  };
}

function exportExitCode(reason: string): number {
  if (reason === 'runtime_unavailable' || reason === 'unsupported_ledger_schema') return 5;
  if (['ledger_missing', 'ledger_unavailable', 'invalid_ledger'].includes(reason)) return 4;
  return 6;
}

export async function linkExport(args: readonly string[], io: HudIO): Promise<number> {
  const parsed = parseLinkExport(args);
  if (!parsed.ok) {
    io.stderr(`${parsed.reason}: ${EXPORT_USAGE}\n`);
    return 2;
  }
  const requestedHome = io.env.HUD_HOME ?? join(homedir(), '.hud');
  if (!isAbsolute(requestedHome)) {
    io.stderr('invalid_hud_home\n');
    return 3;
  }
  // A trailing slash or /. makes lstat follow an otherwise rejected final symlink.
  const home = requestedHome.replace(/(?:\/\.?)+$/, '') || '/';
  try {
    const info = await lstat(home);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      typeof process.getuid !== 'function' ||
      info.uid !== process.getuid() ||
      info.mode & 0o077
    ) {
      io.stderr('invalid_hud_home\n');
      return 3;
    }
    await access(home, constants.X_OK);
  } catch {
    io.stderr('hud_home_unavailable\n');
    return 3;
  }
  const result = await queryDelegationExport(home, parsed.options);
  if (!result.ok) {
    io.stderr(`${result.reason}\n`);
    return exportExitCode(result.reason);
  }
  await io.stdout(result.value.json);
  return 0;
}
