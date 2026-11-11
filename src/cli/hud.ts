export interface HudIO {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void | Promise<void>;
  stderr: (text: string) => void;
}
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

/** Import the selected owner-facing command. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
  io: HudIO = {
    env: process.env,
    stdout: writeStdout,
    stderr: (text) => process.stderr.write(text),
  }
): Promise<number> {
  try {
    if (args[0] === 'import') {
      const { importCommand } = await import('./import.js');
      return await importCommand(args.slice(1), io);
    }
    const cli = await import('./hud-main.js');
    return await cli.main(args, io);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${error.reason}\n`);
      return error.exitCode;
    }
    io.stderr('internal_or_output_failure\n');
    return 1;
  }
}
