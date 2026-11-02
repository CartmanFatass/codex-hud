// A real CLI-core process whose ready message is scheduled during a notify drain.
import { runWait, parseWait } from '../../dist/cli/run-wait.js';
import { CliError } from '../../dist/cli/runtime.js';
const home = process.argv[2];
if (!home) {
  // Standalone check command reuses the owned real-SQLite/backlog fixture.
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-name-pattern',
      'B11 large-history wait pages',
      fileURLToPath(new URL('../../dist-test/tests/unit/b11-cli.test.js', import.meta.url)),
    ],
    { stdio: 'inherit' }
  );
  process.exitCode = result.status ?? 1;
} else
  try {
    process.exitCode = await runWait(
      parseWait(['run-a', '--notify', '--timeout-ms', '0']),
      home,
      {
        env: { HUD_HOME: home },
        stdout: (value) => process.stdout.write(value),
        stderr: (value) => process.stderr.write(value),
      },
      {
        afterWait: async () => {
          setImmediate(() => process.send({ draining: true }));
        },
      }
    );
  } catch (error) {
    process.stderr.write((error instanceof CliError ? error.reason : 'internal_error') + '\n');
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
