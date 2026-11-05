/** Optional source-type check against a separately installed official SDK; never runs Pi. */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PI_FOOTER_VERSION } from '../dist/harness/pi/footer.js';

if (process.argv.length !== 3) {
  console.error('Usage: node scripts/check-pi-footer-sdk.mjs SDK_PREFIX');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = realpathSync(join(process.argv[2], 'node_modules/@earendil-works/pi-coding-agent'));
const pkg = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'));
if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== PI_FOOTER_VERSION) {
  throw new Error(`Expected official @earendil-works/pi-coding-agent ${PI_FOOTER_VERSION}`);
}
const program = ts.createProgram([join(root, 'extensions/pi/hud-footer.ts')], {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  baseUrl: root,
  paths: { '@earendil-works/pi-coding-agent': [join(sdk, 'dist/index.d.ts')] },
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (file) => file,
      getNewLine: () => '\n',
    })
  );
  process.exit(1);
}
console.log(
  `Pi footer entry type-check passed against official SDK ${pkg.version}; no Pi process or provider was started.`
);
