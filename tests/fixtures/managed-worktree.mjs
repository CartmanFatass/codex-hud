import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
export function initRepo(parent) {
  const root = join(fs.realpathSync(parent), 'demo');
  fs.mkdirSync(root);
  git(root, 'init', '-qb', 'trunk');
  git(root, 'config', 'user.name', 'Synthetic');
  git(root, 'config', 'user.email', 'synthetic@invalid');
  fs.writeFileSync(join(root, 'tracked.txt'), 'base\n');
  fs.writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return root;
}
