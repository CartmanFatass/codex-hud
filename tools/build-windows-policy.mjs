import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The compiler is a build-time argument only, never a launch-time env selector.
const compiler = process.argv[2] ?? 'go';
const source = resolve('tools/windows-policy/main.go');
const directory = resolve('dist/windows-policy');
mkdirSync(directory, { recursive: true });
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const toolchain = execFileSync(compiler, ['version'], { encoding: 'utf8', timeout: 10000 }).trim();
if (!/^go version go\d+\.\d+/.test(toolchain)) throw new Error('Go compiler required');
for (const arch of ['amd64', 'arm64']) {
  const binary = `${directory}/observer-${arch}.exe`;
  execFileSync(compiler, ['build', '-trimpath', '-ldflags=-s -w -buildid=', '-o', binary, source], {
    timeout: 120000,
    env: {
      ...process.env,
      GOOS: 'windows',
      GOARCH: arch,
      CGO_ENABLED: '0',
      GO111MODULE: 'off',
      GOWORK: 'off',
      GOTOOLCHAIN: 'local',
      GOPROXY: 'off',
      GOSUMDB: 'off',
    },
    stdio: 'inherit',
  });
  writeFileSync(
    `${binary}.json`,
    JSON.stringify({ protocol: 1, arch, sourceSha256: digest(source), artifactSha256: digest(binary), toolchain }) +
      '\n'
  );
}
