// tsc does not emit snapshot.js. Copy the verbatim asset next to the compiled module.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'src', 'jev', 'snapshot.js');
const requested = process.argv[2] ?? 'dist';
const destination =
  requested === 'dist'
    ? join(root, 'dist', 'jev', 'snapshot.js')
    : requested === 'dist-test'
      ? join(root, 'dist-test', 'src', 'jev', 'snapshot.js')
      : requested;
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
