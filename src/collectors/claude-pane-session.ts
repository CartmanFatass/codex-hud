/** Display binding from Claude's statusline stdin, scoped to the exact herdr pane. */
import { dirname, join, isAbsolute } from 'node:path';
import { statSync, realpathSync } from 'node:fs';
import { getHudHome } from '../hud-home.js';
import { readBytes, saveJson } from '../statusline-parity/storage.js';
const file = (env: NodeJS.ProcessEnv) =>
  /^[\w.-]{1,128}$/.test(env.HERDR_PANE_ID ?? '') ? join(getHudHome(env), 'panes', `${env.HERDR_PANE_ID}.json`) : null;
export function rememberClaudePane(input: unknown, env: NodeJS.ProcessEnv): void {
  const path = file(env),
    v = input as Record<string, unknown> | null;
  if (
    !path ||
    !v ||
    typeof v.session_id !== 'string' ||
    !/^[\w-]+$/.test(v.session_id) ||
    typeof v.transcript_path !== 'string' ||
    !isAbsolute(v.transcript_path)
  )
    return;
  const text = JSON.stringify({
    harness: 'claude',
    pane: env.HERDR_PANE_ID,
    session: v.session_id,
    transcript: v.transcript_path,
    cwd: v.cwd,
  });
  try {
    if (readBytes(path, 8192)?.toString('utf8') !== text + '\n') saveJson(path, JSON.parse(text));
  } catch {
    /* The bar remains usable without a binding. */
  }
}
export function claudePaneSession(env: NodeJS.ProcessEnv): { session: string; source: string } | undefined {
  try {
    const path = file(env);
    const v = JSON.parse(path ? (readBytes(path, 8192)?.toString('utf8') ?? '') : '');
    if (
      v.harness === 'claude' &&
      v.pane === env.HERDR_PANE_ID &&
      /^[\w-]+$/.test(v.session) &&
      isAbsolute(v.transcript) &&
      statSync(v.transcript).isFile()
    )
      return { session: v.session, source: realpathSync(dirname(v.transcript)) };
  } catch {
    /* No live transcript: retain the existing unbound panel. */
  }
}
