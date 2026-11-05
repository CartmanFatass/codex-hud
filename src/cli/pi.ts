import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { makeSourceId } from '../core/identity.js';
import type { ReaderBudget } from '../core/interfaces/harness-adapter.js';
import { PiTranscriptFiles } from '../harness/pi/binding.js';
import { createPiReader, DEFAULT_READER_BUDGET } from '../harness/pi/reader.js';
import type { HudIO } from './link-export.js';
import { CliError, delegateConfig, integer, options, privateHome } from './runtime.js';

export const PI_HELP = `Usage: hud pi inspect --source ROOT --session FILE [--json] [--context-window TOKENS]
       hud pi inspect --profile NAME --session FILE [--json] [--context-window TOKENS]
       hud pi --help

Inspect one existing pi transcript without launching pi or writing any files.
ROOT and FILE must be absolute paths. FILE must be contained in the selected source.
--profile selects an exact pi profile from HUD_HOME/delegate.json.
--source works without HUD_HOME or a built hud-mcp package.
Output is JSON presentation data; --json is optional. No checkpoint or transcript body is exported.
The context window is unknown unless explicitly supplied; model names never imply a window.
One read is bounded to 4 MiB, 2000 records and a soft 20 ms, after a bounded header check.
Partial coverage and continuation are shown, not hidden. Re-running starts a new inspection.
Exit 0: complete observation; 6: incomplete observation; 2: invalid arguments; 4: unavailable source/session.
This does not activate panel collection, launch/resume, MCP authorization or branch navigation.
`;

export function parsePiInspect(args: readonly string[]) {
  if (args[0] !== 'inspect') throw new CliError('invalid_pi_command');
  const flags = options(args.slice(1), ['--json'], ['--profile', '--source', '--session', '--context-window']);
  const profile = flags.get('--profile') as string | undefined;
  const sourceRoot = flags.get('--source') as string | undefined;
  const file = flags.get('--session') as string | undefined;
  if (
    (profile === undefined) === (sourceRoot === undefined) ||
    profile === '' ||
    (sourceRoot !== undefined && (!sourceRoot || !isAbsolute(sourceRoot))) ||
    !file ||
    !isAbsolute(file)
  )
    throw new CliError('invalid_arguments');
  const contextWindow = flags.has('--context-window')
    ? integer(String(flags.get('--context-window')), Number.MAX_SAFE_INTEGER)
    : undefined;
  if (contextWindow === 0) throw new CliError('invalid_number');
  return { profile, sourceRoot, file, contextWindow };
}

/** A one-shot observation. No ledger, checkpoint store, authority or subprocess is created. */
export async function inspectPiFile(
  input: { sourceRoot: string; file: string; contextWindow?: number },
  budget: ReaderBudget = DEFAULT_READER_BUDGET
) {
  if (
    !isAbsolute(input.sourceRoot) ||
    !isAbsolute(input.file) ||
    input.sourceRoot.includes('\0') ||
    input.file.includes('\0') ||
    (input.contextWindow !== undefined && (!Number.isSafeInteger(input.contextWindow) || input.contextWindow <= 0)) ||
    !Number.isSafeInteger(budget.maxBytes) ||
    budget.maxBytes <= 0 ||
    !Number.isSafeInteger(budget.maxRecords) ||
    budget.maxRecords <= 0 ||
    !Number.isFinite(budget.budgetMs) ||
    budget.budgetMs <= 0
  )
    throw new CliError('invalid_arguments');
  let root: string;
  try {
    root = await realpath(input.sourceRoot);
    if (!(await stat(root)).isDirectory()) throw new Error('not_directory');
  } catch {
    throw new CliError('invalid_pi_source', 4);
  }
  const sourceId = makeSourceId('pi', root);
  const files = new PiTranscriptFiles(root, sourceId);
  try {
    // This existing helper reads at most 64 KiB. The reader independently checks
    // the same header at its own file boundary, so replacement cannot swap IDs.
    const header = files.header(input.file);
    const ref = { harness: 'pi' as const, sourceId, sessionId: header.id, threadId: null };
    const reader = createPiReader({
      ref,
      resolveFile: () => files.contained(input.file),
      contextWindow: input.contextWindow,
    });
    const result = await reader.read({
      maxBytes: Math.min(budget.maxBytes, DEFAULT_READER_BUDGET.maxBytes),
      maxRecords: Math.min(budget.maxRecords, DEFAULT_READER_BUDGET.maxRecords),
      budgetMs: Math.min(budget.budgetMs, DEFAULT_READER_BUDGET.budgetMs),
    });
    const { evidence, observation } = result;
    return {
      format: 'hud.pi.inspect' as const,
      ref,
      observedAt: observation.statusProjection.observedAt,
      model: evidence.model,
      context: evidence.context,
      spent: observation.spent,
      cacheWarm: evidence.cacheWarm,
      coverage: observation.coverage,
      continuation: result.continuation ?? null,
      branchView: evidence.branchView,
      incomplete: observation.coverage.state !== 'complete',
      stats: result.stats,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    throw new CliError(
      [
        'pi_transcript_outside_source',
        'pi_header_too_large',
        'invalid_pi_header',
        'pi_session_mismatch',
        'invalid_pi_ref',
      ].includes(reason)
        ? reason
        : 'pi_transcript_unavailable',
      4
    );
  }
}

/** JSON escapes C0 controls; also escape C1 and direction controls for terminal-safe presentation. */
function presentation(value: unknown): string {
  return (
    JSON.stringify(value, null, 2).replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    ) + '\n'
  );
}

export async function piCommand(args: readonly string[], io: HudIO): Promise<number> {
  // Help and explicit-source inspection do not validate or touch HUD_HOME.
  if (
    (args.length === 1 && args[0] === '--help') ||
    (args.length === 2 && args[0] === 'inspect' && args[1] === '--help')
  ) {
    await io.stdout(PI_HELP);
    return 0;
  }
  const parsed = parsePiInspect(args);
  let sourceRoot = parsed.sourceRoot;
  if (parsed.profile !== undefined) {
    const config = await delegateConfig(privateHome(io.env));
    const profiles = config.profiles.filter((p) => p.harness === 'pi' && p.name === parsed.profile);
    if (profiles.length !== 1) throw new CliError('pi_profile_required', 4);
    sourceRoot = profiles[0].source.root;
  }
  const output = await inspectPiFile({
    sourceRoot: sourceRoot!,
    file: parsed.file,
    contextWindow: parsed.contextWindow,
  });
  await io.stdout(presentation(output));
  return output.incomplete ? 6 : 0;
}
