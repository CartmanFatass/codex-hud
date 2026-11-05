# Cloud checks and local package preview

This M0/E5 delivery adds runnable development tools on base
`211f7e3604dba10691acdcbe006ea242071820ee`. It incorporates the accepted handbook
from `2501865a29c3e3a37e09518459af1f667f3866b2`; its original baseline and historical
roadmap remain visible. This is not a complete M0/M4 milestone, production
qualification, npm release, default installation or user-settings migration.

## Run without provider credentials

Use Linux and Node 22.x >=22.13 or Node 24. From the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/check-cloud.mjs --self-test
node scripts/pack-cloud-preview.mjs --self-test
node scripts/check-cloud.mjs
node scripts/pack-cloud-preview.mjs
```

Dependency download may need registry access. The two scripts make no provider
or network calls themselves and do not install dependencies. They spawn commands
with an explicit environment and temporary HOME, HUD_HOME, CLAUDE_CONFIG_DIR,
CODEX_HOME and TMPDIR. Ambient credentials, loader hooks and provider variables
are not inherited. Temporary SQLite lives on the workspace filesystem rather
than assuming `/tmp` supports its required WAL semantics.

`check-cloud.mjs` runs three real builds, an explicit focused test list, then the
nine existing M1/protocol/fake/footer demos. The list is in the script, not discovered
from arbitrary files. It covers Pi reading/launch, Claude last-confirmed panel
visibility, the configuration refusal boundary, versioned RPC/exec/app-server
transports, workbench rendering and the Jev fake. It does not run broad historical
performance loops, real tmux/Herdr/provider probes, or change capability manifests.

The routing composition follow-on, based on `82013aaf99c8f3507163a02bed0ce7e8e4a1ab90`,
adds the statusline settings, product CLI routing and Pi footer unit tests; five
explicit unified-workbench/private-channel test files; and the MCP Pi source-root
test. They use temporary synthetic data. Settings apply/restore tests operate only
inside their own temporary homes, never the user's configuration. The Pi delegation follow-on adds the three explicit `pi-delegation-*` unit files
(context, private channel and full synthetic host). Root `npm test` now builds
hud-mcp after `build:test`, so the full host never depends on stale MCP output.
Its six host cases explicitly require Linux, Node22.18+ (22.x) or Node24+,
`registerHooks` and enabled built-in TypeScript loading; other runtimes skip only
those cases while pure cleanup still runs. This fixture floor is separate from
the ledger's Node22.13 minimum. The optional installed-official
Pi no-model probe is not part of the default cloud command. The real-PTY
workbench script and broader MCP suite remain outside this focused command.

Each build/test command has a three-minute guard, each demo thirty seconds, and
captured output is limited to 2 MiB per command. The first failure stops later
steps, which are listed as NOT_RUN, not passed. Each command uses an owned process
group; a timeout or interruption signals that group only while direct-child
ownership remains known. After the direct child exits, the runner does not signal
a potentially reused process-group ID. It reports cleanup uncertainty separately
from direct-child exit and pipe close, and detaches its observation handles at the
bounded fallback. A timeout, missing reap receipt or uncertain cleanup is a failure.
These are defensive software timers, not hard OS deadlines or proof that arbitrary
detached children are gone. The inherited-pipe negative control cleans up its own
escaped fixture using its exact PID, process start stamp and unique marker.

## Result artifacts

Each invocation prints its unique directory under ignored
`tmp/cloud-development/`. Check output contains `results.json` and bounded logs.
The receipt records source HEAD, whether the checkout was dirty, Node/platform/
architecture/Git, lockfile SHA-256, commands, exit/signal/reap status, direct-child
exit, pipe close and cleanup uncertainty, elapsed time,
and PASS/FAIL/NOT_RUN. A dirty checkout is labelled rather than falsely identified
as the exact clean HEAD. Logs and examples are synthetic; no environment dump or
transcript export is made. Temporary homes are removed after the run.

The original `.github/workflows/ci.yml` is unchanged. The new
`cloud-development.yml` has read-only repository permission, no retained checkout
credential, Linux Node 22/24 jobs, a twenty-minute job guard, and seven-day result
artifacts. It runs on `dots/**` and integration pushes, and PRs targeting integration.
It also declares manual dispatch; GitHub only exposes dispatch once its workflow
is present on the repository's default branch. Adding the file or passing local
checks is not evidence of a hosted Actions run. Read the actual run before saying
that CI passed. The workflows do not upload a package to a registry.

## Exact preview selection

`pack-cloud-preview.mjs` compiles fresh outputs in its own temporary directory.
It never recursively packs the working directory or copies arbitrary existing
`dist` files. Its allowlist is:

- Root `package.json`, generated from the manifest's name/version/type/main/bin/
  license/dependencies. The preview adds `private:true`, omits scripts and dev
  dependencies, and declares the Node runtime this cloud path actually requires.
- Manifest-declared `bin/codex-hud`, `bin/hud`, `bin/hud-run`, `bin/hud-statusline`;
  plus the already opt-in `bin/hud-statusline-preview` file. Both aliases and paths
  are checked against the exact reviewed mapping; renamed, missing or extra
  aliases are rejected, even if they point to an otherwise allowed file.
- `README.md`, and the equivalent private `packages/hud-mcp/package.json`.
- `packages/hud-mcp/bin/hud-mcp.mjs` and its required `hud-claude-hook.mjs` helper.
- Fresh `.js` outputs corresponding to Git-tracked non-declaration `.ts` under
  `src/` and `packages/hud-mcp/src/`, at their existing runtime output paths.
- Explicitly required `dist/cli/statusline.js` and `dist/harness/pi/footer.js`
  outputs from their matching tracked sources. The exact
  `extensions/pi/hud-footer.ts` and `extensions/pi/hud-delegate.ts` entries are the
  only source-TS exceptions. Pi loads them explicitly and they import their
  packaged runtime modules. The bridge/context/channel outputs are required
  explicitly. Other extension files are not selected recursively. Loading it still requires
  a separately installed compatible Pi host; the preview never loads it itself.
- The explicit runtime `src/core/launch/codex-cells.json`, copied to both builds'
  expected paths, and generated `CLOUD-PREVIEW.json` provenance.

Every source/selected input must be a regular non-symlink file. The archive has
at most 5,000 files, 2 MiB per file and 50 MiB total uncompressed data. The final
tar listing must exactly match the generated inventory. `preview-manifest.json`
lists every entry, origin, mode, byte count and SHA-256, plus archive SHA-256 and
the build results. It is the exact per-run inventory, not an assumed glob.

Excluded: node_modules, tests/fixtures, other source TS, source maps/declarations,
untracked files, logs, credentials, settings, transcripts and installer/upgrade
scripts. There is no npm pack/publish/install, release tag, default configuration
change or implicit invocation of packaged entrypoints. Production dependencies
are declared but not bundled. Optional integrations and unrelated helper scripts
are not included. This is an inspectable runtime preview, not a tested standalone
installer. Review the inventory before using it for any later release process.

## Cloud validation recorded on 2026-11-05

On Linux x64, Node 24.22.1, the implementation workspace passed all three builds,
169 focused tests and eight synthetic demos. The local archive contained 421
allowlisted files with exact tar-inventory comparison. After the runner's bounded
inherited-pipe cleanup fix, its negative controls, success/failure receipt smoke
and both preview builds/archive verification passed again. Those development
receipts correctly identify the base SHA plus a dirty checkout, not a clean
published commit. The final engine-range check limits the preview to Node 22.13+
within 22.x or Node 24.x.

This records cloud-computer validation, not a hosted GitHub Actions run. Node 22,
live provider accounts and standalone package installation were not exercised in
that run. The Node 22/24 workflow matrix must produce its own exact-SHA receipts.

## 当前交付边界

这个入口在云端运行真实构建、合成场景和自有模拟子进程，并输出可核对的源码版本、
命令结果与包文件清单。它不需要真实 Claude/Codex/Pi 账号，也不会把模拟通过写成
生产能力已验证。打包只生成本地预览，不发布 npm、不安装到用户目录、不切换默认设置。

已有可运行切片见 [M1 starter](../cloud/m1-simulation-demo.md)、
[Claude print](../cloud/m2-claude-print-transport.md)、
[Codex exec](../cloud/m2-codex-exec-transport.md)、
[app-server](../cloud/m2-codex-app-server-transport.md)、
[Pi RPC](../cloud/m2-pi-rpc-transport.md)、
[普通 Pi 观察](../cloud/pi-ordinary-observation.md) 和
[合成 workbench](../cloud/m2-vertical-workbench.md)。这些切片不等于完整 M1/M2/M3。
