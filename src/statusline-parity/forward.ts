/** Explicit locally authored argv only; never a shell. The detached worker owns its deadline. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function forwardInput(argv: readonly string[] | undefined, bytes: Buffer, env: NodeJS.ProcessEnv): void {
  if (!argv?.length || bytes.length > 64 * 1024) return;
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./forward-worker.js', import.meta.url)), JSON.stringify(argv)],
      {
        env,
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      }
    );
    child.on('error', () => {});
    child.stdin!.on('error', () => {});
    child.stdin!.end(bytes);
    // No inherited output descriptors, timers, or referenced pipe can keep this render alive.
    (child.stdin as typeof child.stdin & { unref?: () => void })?.unref?.();
    child.unref();
  } catch {
    /* Forward is best-effort and never changes the statusline result. */
  }
}
