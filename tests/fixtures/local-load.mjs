import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function syntheticProc(home, release = '6.8.0-synthetic') {
  const root = join(home, 'proc');
  const write = (name, text) => writeFileSync(join(root, name), text);
  mkdirSync(join(root, 'sys/kernel/random'), { recursive: true });
  write('sys/kernel/osrelease', `${release}\n`);
  write('sys/kernel/random/boot_id', '00112233-4455-6677-8899-aabbccddeeff\n');
  return { root, write };
}
