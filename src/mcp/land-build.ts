/** Verify that the integration checkout's tested main build matches the landed checkout's inputs exactly. */
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { worktreeGit as git } from '../collectors/worktrees.js';

const INPUTS = ['src', 'tsconfig.json', 'package.json', 'package-lock.json', 'scripts/build.mjs', 'scripts/dist-lock.mjs'];
const COMMIT_INPUTS = [...INPUTS, 'node_modules'];
const MAIN_BUILD_CMDS = new Set(['npm run build', 'node scripts/build.mjs', 'node scripts/build.mjs --target main']);

export const isMainBuildCommand = (cmd: string) => MAIN_BUILD_CMDS.has(cmd.trim());
const inside = (base: string, target: string) => {
  const rel = relative(base, target);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
};
const sameFile = (a: string, b: string) => {
  const sa = fs.statSync(a, { throwIfNoEntry: false }), sb = fs.statSync(b, { throwIfNoEntry: false });
  if (!sa?.isFile() || !sb?.isFile()) return false;
  return fs.realpathSync(a) === fs.realpathSync(b) || (sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b)));
};
const sameDirs = (a: string, b: string) => {
  const sa = fs.statSync(a, { throwIfNoEntry: false }), sb = fs.statSync(b, { throwIfNoEntry: false });
  if (!sa && !sb) return true;
  if (!sa?.isDirectory() || !sb?.isDirectory()) return false;
  const la = fs.readdirSync(a).sort(), lb = fs.readdirSync(b).sort();
  return la.length === lb.length && la.every((name, i) => name === lb[i]);
};
function sharedLinks(intNm: string, mainNm: string): string[] {
  if (!fs.existsSync(intNm) || !fs.existsSync(mainNm)) return [];
  if (fs.realpathSync(intNm) === fs.realpathSync(mainNm)) return [fs.realpathSync(mainNm)];
  const roots: string[] = [];
  const check = (rel: string) => {
    const a = join(intNm, rel), b = join(mainNm, rel);
    if ((fs.lstatSync(a, { throwIfNoEntry: false })?.isSymbolicLink() || fs.lstatSync(b, { throwIfNoEntry: false })?.isSymbolicLink()) &&
        fs.existsSync(a) && fs.existsSync(b) && fs.realpathSync(a) === fs.realpathSync(b)) roots.push(fs.realpathSync(a));
  };
  for (const e of fs.readdirSync(intNm, { withFileTypes: true })) {
    if (e.name.startsWith('@') && e.isDirectory()) for (const s of fs.readdirSync(join(intNm, e.name), { withFileTypes: true })) check(join(e.name, s.name));
    else check(e.name);
  }
  return roots;
}
async function cleanInputs(cwd: string, filters: string[]) {
  return !(await git(cwd, [...filters, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...INPUTS])) &&
    !(await git(cwd, ['ls-files', '-v', '-z', '--', ...INPUTS])).split('\0').some(row => /^[a-zS] /.test(row));
}

export async function canPublishTestedBuild(opts: {
  main: string; integration: string; testedSha: string; mainHeadSha: string; gateCommands: string[]; cmd: string; filters: string[];
}): Promise<boolean> {
  const { main, integration, testedSha, mainHeadSha, gateCommands, cmd, filters } = opts;
  if (!isMainBuildCommand(cmd) || !gateCommands.some(isMainBuildCommand)) return false;
  try {
    const intDist = join(integration, 'dist'), infoPath = join(integration, '.tsbuild/main.tsbuildinfo');
    if (!fs.lstatSync(intDist, { throwIfNoEntry: false })?.isDirectory()) return false;
    if (![join(intDist, 'index.js'), join(intDist, 'tree-page.js'), infoPath, join(main, 'scripts/build.mjs')]
      .every(f => fs.lstatSync(f, { throwIfNoEntry: false })?.isFile())) return false;
    const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cmd.trim() === 'npm run build' && [main, integration].some(d => readJson(join(d, 'package.json')).scripts?.build !== 'node scripts/build.mjs')) return false;
    const tc = readJson(join(main, 'tsconfig.json')), underSrc = (p: unknown) => typeof p === 'string' && /^(?:\.\/)?src(?:\/|$)/.test(p);
    if (tc.extends !== undefined || !Array.isArray(tc.include) || !tc.include.length || !tc.include.every(underSrc) ||
        (tc.files !== undefined && (!Array.isArray(tc.files) || !tc.files.every(underSrc)))) return false;
    if (await git(main, ['diff', '--name-only', '-z', testedSha, mainHeadSha, '--', ...COMMIT_INPUTS]) ||
        await git(integration, ['diff', '--name-only', '-z', testedSha, 'HEAD', '--', ...COMMIT_INPUTS]) ||
        !(await cleanInputs(main, filters)) || !(await cleanInputs(integration, filters))) return false;
    for (const f of ['tsconfig.json', 'package.json', 'scripts/build.mjs', 'scripts/dist-lock.mjs',
      'node_modules/typescript/package.json', 'node_modules/typescript/lib/tsc.js']) {
      if (!sameFile(join(integration, f), join(main, f))) return false;
    }
    const lockA = fs.existsSync(join(integration, 'package-lock.json')), lockB = fs.existsSync(join(main, 'package-lock.json'));
    if (lockA !== lockB || (lockA && !sameFile(join(integration, 'package-lock.json'), join(main, 'package-lock.json'))) ||
        !sameDirs(join(integration, 'node_modules/@types'), join(main, 'node_modules/@types'))) return false;
    const info = readJson(infoPath);
    if (!Array.isArray(info.fileNames) || info.version !== readJson(join(main, 'node_modules/typescript/package.json')).version) return false;
    const infoDir = dirname(infoPath), intReal = fs.realpathSync(integration), mainReal = fs.realpathSync(main);
    const intSrc = join(intReal, 'src'), intNm = join(intReal, 'node_modules'), mainNm = join(mainReal, 'node_modules');
    const shared = sharedLinks(intNm, mainNm);
    for (const file of info.fileNames) {
      if (typeof file !== 'string') return false;
      const abs = resolve(infoDir, file);
      if (inside(intSrc, abs) || shared.some(r => inside(r, abs))) continue;
      const nmRel = inside(intNm, abs);
      if (!nmRel || !sameFile(abs, join(mainNm, nmRel))) return false;
    }
    return true;
  } catch { return false; }
}
