/** Opt-in statusline I/O boundary; the default renderer never calls this module's collectors. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { WorkSignals } from '../render/work-summary.js';
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
/**
 * Where Claude compacts on its own, in tokens: the model's `autoCompactWindow` in the user's settings.json, else the
 * top-level one, unless auto-compact is off. Read only; null when the file or the key is not there.
 */
export function compactWindow(env: NodeJS.ProcessEnv, modelId: string): number | null {
  try {
    const file = join(env.CLAUDE_CONFIG_DIR || join(env.HOME ?? '', '.claude'), 'settings.json');
    if (fs.statSync(file).size > 1024 * 1024) return null;
    const settings = record(JSON.parse(fs.readFileSync(file, 'utf8')));
    const own = record(record(settings.modelSettings)[modelId.replace(/\[[^\]]*\]$/, '')]).autoCompactWindow;
    const window = own ?? settings.autoCompactWindow;
    return settings.autoCompactEnabled !== false && typeof window === 'number' && window > 0 ? window : null;
  } catch {
    return null;
  }
}
export function collectAndRenderParity(
  input: unknown,
  width: number,
  settings: ParitySettings,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
  work?: WorkSignals
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
  const counts = settings.display.showConfigCounts ? collectConfigCounts(cwd, env) : { mcpCount: 0 };
  const git = cwd && settings.gitStatus.enabled ? collectParityGit(cwd, env, now) : null;
  const compact = compactWindow(
    env,
    typeof record(value.model).id === 'string' ? (record(value.model).id as string) : ''
  );
  return renderParity(native, width, settings, { transcript, counts, git, compact }, now, env, work);
}
