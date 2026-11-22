import { renameSync, writeFileSync } from 'node:fs';

// Publish complete fixture contents to concurrent readers of the target path.
export function writeFixtureFile(file, data, options) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, options);
  renameSync(tmp, file);
}
