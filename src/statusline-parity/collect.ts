/** Opt-in statusline I/O boundary; the default renderer never calls this module's collectors. */
import { collectTranscript } from './transcript.js';
import { collectConfigCounts } from './config-counts.js';
import { collectParityGit } from './git.js';
import { renderParity } from './render.js';
import type { ParitySettings } from './settings.js';
import { cachePath, cached, record, saveJson, signature } from './storage.js';
interface ContextCache {
  version: 1;
  at: number;
  identity: string;
  context: Record<string, unknown>;
}
export function collectAndRenderParity(
  input: unknown,
  width: number,
  settings: ParitySettings,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
  work = ''
): string {
  const value = record(input),
    file =
      typeof value.transcript_path === 'string' && value.transcript_path.length <= 4096 ? value.transcript_path : '';
  const transcript = collectTranscript(file, env);
  let native = value;
  if (file && Object.keys(record(value.context_window)).length) {
    const context = record(value.context_window),
      usage = record(context.current_usage);
    const total = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce(
      (n, k) => n + (typeof usage[k] === 'number' ? (usage[k] as number) : 0),
      0
    );
    const path = cachePath(env, 'context', file),
      previous = cached<ContextCache>(path);
    const identity = signature(file).split(':').slice(0, 2).join(':');
    if (context.used_percentage === 0 && total === 0) {
      if (transcript.compactAt !== undefined && transcript.compactAt > (previous?.at ?? 0)) {
        const size = context.context_window_size;
        if (typeof size === 'number' && size > 0 && transcript.compactPostTokens)
          native = {
            ...value,
            context_window: {
              ...context,
              used_percentage: Math.min(100, Math.round((transcript.compactPostTokens / size) * 100)),
            },
          };
      } else if (previous && previous.identity === identity && now >= previous.at && now - previous.at <= 5 * 60 * 1000)
        native = {
          ...value,
          context_window: {
            ...previous.context,
            context_window_size: context.context_window_size ?? previous.context.context_window_size,
          },
        };
    } else if (typeof context.used_percentage === 'number' && context.used_percentage > 0) {
      if (!previous || now - previous.at > 30000 || JSON.stringify(previous.context) !== JSON.stringify(context)) {
        try {
          saveJson(path, { version: 1, at: now, identity, context });
        } catch {
          /* optional */
        }
      }
    }
  }
  const cwd = typeof value.cwd === 'string' && value.cwd.length <= 4096 ? value.cwd : undefined;
  const counts = settings.display.showConfigCounts
    ? collectConfigCounts(cwd, env)
    : { claudeMdCount: 0, rulesCount: 0, mcpCount: 0, hooksCount: 0 };
  const git = cwd && settings.gitStatus.enabled ? collectParityGit(cwd, env, now) : null;
  return renderParity(native, width, settings, { transcript, counts, git }, now, env, work);
}
