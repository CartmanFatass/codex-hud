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

/** Load the selected command under the startup lock; run it after releasing the lock. */
export async function prepareMain(
  args: readonly string[] = process.argv.slice(2),
  io: HudIO = {
    env: process.env,
    stdout: writeStdout,
    stderr: (text) => process.stderr.write(text),
  }
): Promise<() => Promise<number>> {
  let run: () => Promise<number>;
  try {
    if (args[0] === 'import') {
      const { importCommand } = await import('./import.js');
      run = () => importCommand(args.slice(1), io);
    } else {
      const cli = await import('./hud-main.js');
      run = () => cli.main(args, io);
    }
  } catch (error) {
    run = () => { throw error; };
  }
  return async () => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CliError) {
        io.stderr(`${error.reason}\n`);
        return error.exitCode;
      }
      io.stderr('internal_or_output_failure\n');
      return 1;
    }
  };
}

export async function main(args?: readonly string[], io?: HudIO): Promise<number> {
  return (await prepareMain(args, io))();
}
