import { EXPORT_HELP, EXPORT_USAGE, linkExport, type HudIO } from './link-export.js';

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

export async function main(
  args: readonly string[] = process.argv.slice(2),
  io: HudIO = {
    env: process.env,
    stdout: writeStdout,
    stderr: (text) => process.stderr.write(text),
  }
): Promise<number> {
  try {
    if (
      (args.length === 1 && args[0] === '--help') ||
      (args.length === 2 && args[0] === 'link' && args[1] === '--help') ||
      (args.length === 3 && args[0] === 'link' && args[1] === 'export' && args[2] === '--help')
    ) {
      await io.stdout(EXPORT_HELP);
      return 0;
    }
    if (args[0] !== 'link' || args[1] !== 'export') {
      io.stderr(`invalid_command: ${EXPORT_USAGE}\n`);
      return 2;
    }
    return await linkExport(args.slice(2), io);
  } catch {
    io.stderr('internal_or_output_failure\n');
    return 1;
  }
}
