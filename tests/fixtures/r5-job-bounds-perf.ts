import * as fs from 'node:fs';
import { join } from 'node:path';

function diskSnapshot(path: string): string {
  return JSON.stringify(
    fs
      .readdirSync(path, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => [
        e.name,
        e.isDirectory() ? diskSnapshot(join(path, e.name)) : fs.readFileSync(join(path, e.name)).toString('base64'),
      ])
  );
}
export { diskSnapshot };
