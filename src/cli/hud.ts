import type { HudIO } from './link-export.js';
import { CliError } from './private-home.js';

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdout = process.stdout;
    const onError = (error: Error) => reject(error);
    stdout.once('error', onError);
    try {
      stdout.write(text, (error) => {
        if (error) {
          // The callback can precede the error event; retain its one-shot listener.
          reject(error);
        } else {
          stdout.off('error', onError);
          resolve();
        }
      });
    } catch (error) {
      stdout.off('error', onError);
      reject(error);
    }
  });
}

/** Dispatch wait before importing any of the ordinary CLI's execution graph. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
  io: HudIO = {
    env: process.env,
    stdout: writeStdout,
    stderr: (text) => process.stderr.write(text),
  },
  received?: number
): Promise<number> {
  try {
    if (args[0] === 'import') {
      const { importCommand } = await import('./import.js');
      return await importCommand(args.slice(1), io);
    }
    if (args[0] === 'install') {
      const { installCommand } = await import('./install.js');
      return await installCommand(args, io);
    }
    if (args[0] === 'wait') {
      const { waitCommand } = await import('./wait.js');
      return await waitCommand(args.slice(1), io);
    }
    const cli = await import('./hud-main.js');
    return await cli.main(args, io, received);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${error.reason}\n`);
      return error.exitCode;
    }
    io.stderr('internal_or_output_failure\n');
    return 1;
  }
}
