import * as fs from 'node:fs';
import { dirname, join, delimiter, resolve } from 'node:path';
/** Locate installed pi, including the managed PATH shim, without launching a CLI. */
export function piPackage() {
  const candidates = process.env.PI_PACKAGE_DIR ? [resolve(process.env.PI_PACKAGE_DIR)] : [];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try {
      const exe = fs.realpathSync(join(dir, 'pi'));
      candidates.push(resolve(dirname(exe), '..'), resolve(dirname(exe), '../..'));
      const install = resolve(dirname(exe), '../install');
      const version = fs.readFileSync(join(install, 'current-version'), 'utf8').trim();
      if (/^[A-Za-z0-9._+-]+$/.test(version))
        candidates.push(join(install, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent'));
    } catch {
      /* next PATH candidate */
    }
  }
  for (const root of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent' && fs.existsSync(join(root, 'dist/core/extensions/loader.js')))
        return { root, version: pkg.version };
    } catch {
      /* unavailable */
    }
  }
  return null;
}
