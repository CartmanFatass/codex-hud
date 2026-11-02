import {
  handoffMinTokensFor,
  loadCacheConfig,
  type CacheConfigEntry,
  type CacheConfigLoaded,
  type CacheDocumentedBlock,
  type CachePlanningBlock,
  type CacheTtlBlock,
} from '../core/cache-config.js';
import { options } from './runtime.js';
import type { HudIO } from './link-export.js';

export const CACHE_USAGE = 'hud cache show [--json]';

export const CACHE_HELP = `Usage: ${CACHE_USAGE}
       hud cache --help

Print the cache.json v2 snapshot that hud-mcp loads once at startup, with its
validation result. Read-only: nothing is created, written or migrated.
HUD_HOME defaults to ~/.hud and must be an absolute, private directory owned by this uid.
A missing cache.json is a valid empty snapshot (exit 0). An invalid file prints
its detail code (exit 2); hud-mcp still starts and reports empty advice.
--json prints the loader result: {ok, snapshot, path, origin}. A failure prints
one reason-code line on stderr and no JSON.

Exit codes:
  0  Success or help (valid or missing file)
  1  Unexpected internal or output failure
  2  Invalid arguments or invalid cache.json
  3  Invalid, missing, inaccessible, or non-private HUD_HOME
`;

function quoted(value: string): string {
  return JSON.stringify(value);
}

function ttl(block: CacheTtlBlock | null): string {
  if (!block) return 'none';
  const parts = [`ttlMs=${block.ttlMs === null ? 'null' : block.ttlMs}`];
  if (block.source !== null) parts.push(`source=${quoted(block.source)}`);
  if (block.note !== null) parts.push(`note=${quoted(block.note)}`);
  return parts.join(' ');
}

function documented(block: CacheDocumentedBlock | null): string {
  if (!block) return 'none';
  const parts = [`ttlMs=${block.ttlMs === null ? 'null' : block.ttlMs}`];
  if (block.writeMultiplier !== null) parts.push(`writeMultiplier=${block.writeMultiplier}`);
  if (block.readMultiplier !== null)
    parts.push(
      `readMultiplier=${Object.entries(block.readMultiplier)
        .map(([model, multiplier]) => `${model}:${multiplier}`)
        .join(',')}`
    );
  if (block.lifetimeFrom !== null) parts.push(`lifetimeFrom=${quoted(block.lifetimeFrom)}`);
  if (block.source !== null) parts.push(`source=${quoted(block.source)}`);
  if (block.note !== null) parts.push(`note=${quoted(block.note)}`);
  return parts.join(' ');
}

function planning(block: CachePlanningBlock | null): string {
  if (!block) return 'none';
  const parts = [`ttlMs=${block.ttlMs === null ? 'null' : block.ttlMs}`];
  if (block.label !== null) parts.push(`label=${quoted(block.label)}`);
  return parts.join(' ');
}

function entry(index: number, value: CacheConfigEntry): string[] {
  const auth = value.match.auth === null ? '*' : value.match.auth.join('|');
  return [
    `entry ${index}: harness=${value.match.harness} auth=${auth} warming=${value.warming}`,
    `  configured: ${ttl(value.configured)}`,
    `  documented: ${documented(value.documented)}`,
    `  observed: ${ttl(value.observed)}`,
    `  planningAssumption: ${planning(value.planningAssumption)}`,
  ];
}

/** Human form: one snapshot, one entry per block, no merged provenance. */
export function renderCache(load: CacheConfigLoaded): string {
  const lines = [
    `cache.json: ${load.path}`,
    'validation: ok',
    `origin: ${load.origin}`,
    `version: ${load.snapshot.version}`,
    `handoffMinTokens: ${load.snapshot.handoffMinTokens === null ? 'null' : load.snapshot.handoffMinTokens} (default ${handoffMinTokensFor(load.snapshot)})`,
    `entries: ${load.snapshot.entries.length}`,
  ];
  for (const [index, value] of load.snapshot.entries.entries()) lines.push(...entry(index, value));
  return lines.join('\n') + '\n';
}

/** `hud cache show [--json]`; the caller has already validated HUD_HOME. */
export async function cacheCommand(args: readonly string[], home: string, io: HudIO): Promise<number> {
  const [command, ...rest] = args;
  if (command !== 'show') {
    io.stderr(`invalid_command: ${CACHE_USAGE}\n`);
    return 2;
  }
  const flags = options(rest, ['--json'], []);
  const load = loadCacheConfig(home);
  if (!load.ok) {
    io.stderr(`cache_config_invalid: ${load.detail}${load.at === null ? '' : ` at ${load.at}`}\n`);
    return 2;
  }
  await io.stdout(flags.has('--json') ? JSON.stringify(load) + '\n' : renderCache(load));
  return 0;
}
