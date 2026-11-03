````markdown
# Synthetic verification attempt: environment evidence

Repository: `CartmanFatass/codex-hud`. Captured on 2026-11-03, approximately 14:23–14:26 UTC.

**Outcome: no repository checkout or test run was obtained. No commit or tree was tested.** The branch and tree IDs below are GitHub API metadata, not test results. The full README check set and the package-specific checks remain outstanding.

## Remote refs and trees

GitHub API `GET /repos/CartmanFatass/codex-hud/branches?per_page=100`, verified again at 14:25:50 UTC, returned these heads. Their tree IDs were read with `GET /repos/CartmanFatass/codex-hud/git/commits/<sha>`.

| Ref | Commit | Tree |
|---|---|---|
| `dots/b10b-s3f` | `bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60` | `f9bcdc5c069156d655ca7d3cd7a08590e74b8eec` |
| `dots/hyg2` | `2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31` | `50438e87a1915d5e739a4a4d926cc9b1e7e85724` |
| `dots/runz1` | `86ca8887fcfb331750ec6dc5518d69134cb795e4` | `da3e386e3512736f3078d0fd9c7b85a868f83f6d` |
| `universal-hud` | `6caeed9e8e675aeb3833f33aa227c4bba7714ab7` | `6ab46713e4d53c008a0fcc1a7d06950276d19c4b` |

During this attempt, `universal-hud` advanced from commit `b7b2bc9ea655ba092ae9a62a60d210597059a5fa`, tree `9c045d7bab3546e3a39fd32e32f2f25a18acee43`, to the commit above. The new commit's parent is the previous commit, and its subject is `Record authorization for later local tests`. The five requested instruction files were read again at the new pinned commit. The three WIP heads did not change between the two checks.

## Available executor

Windows 10.0.26300, x64; PowerShell 7.6.5; Node `v24.22.1`; npm `11.19.1`; Git `2.55.0.windows.3`. The Codex Cloud environment listing returned `{ "environments": [], "nextCursor": null }`.

The following output was returned by `wsl.exe --list --verbose` (exit 1, elapsed 0.253 s; decoded from the returned UTF-16 text):

```text
Access is denied.
Error code: Wsl/EnumerateDistros/Service/E_ACCESSDENIED
```

No WSL retry or security-setting change was attempted.

The following native runtime capability probe was run (exit 1, elapsed 0.183 s):

```powershell
node -e "console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,getuid:typeof process.getuid})); try { process.getuid(); } catch (error) { console.error(error.toString()); process.exitCode = 1; }"
```

Raw output:

```text
{"platform":"win32","arch":"x64","node":"v24.22.1","getuid":"undefined"}
TypeError: process.getuid is not a function
```

For example, `tests/unit/run-control.test.ts` invokes `process.getuid()` at module initialization, and the RUNZ1 brief specifically requires Linux real-process tests. This is an environment capability probe, not a test failure or evidence that any branch passes or fails.

## Git access probe

The GitHub connector read the repository and instruction files. The native Git reference lookup was run with a synthetic HOME and USERPROFILE in the writable task workspace, isolated Git configuration, and prompting disabled:

```powershell
$syntheticHome = Join-Path (Get-Location).Path 'verification-home'
New-Item -ItemType Directory -Path $syntheticHome -Force | Out-Null
$env:HOME = $syntheticHome
$env:USERPROFILE = $syntheticHome
$env:XDG_CONFIG_HOME = Join-Path $syntheticHome '.config'
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = 'NUL'
$env:GIT_TERMINAL_PROMPT = '0'
git ls-remote --heads https://github.com/CartmanFatass/codex-hud.git refs/heads/dots/b10b-s3f refs/heads/dots/hyg2 refs/heads/dots/runz1 refs/heads/universal-hud
exit $LASTEXITCODE
```

Exit 128, elapsed 0.308 s. Raw output:

```text
fatal: unable to access 'https://github.com/CartmanFatass/codex-hud.git/': schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e) - No credentials are available in the security package
```

This was a ref lookup, not a clone or test. No checkout was attempted afterward. The connector reported no GitHub Actions workflow runs for any of the three WIP head commits; existing CI is not a substitute for the requested checks.

## Outstanding verification

For each pinned WIP head, the full unchanged check set in `docs/cloud/README.md` remains unrun: build, build:test, build:hud-mcp, npm test, test:core, test:visual, test:hud-mcp, format:check, check:fixtures, and git diff --check. B10B-S3F also requires its three-run `B10B_PERF=1` performance series; RUNZ1 requires the Linux real-process acceptance checks and its scan-cost measurement. Use isolated temporary workspaces with synthetic HOME and HUD_HOME and capture the exact commands, environment, raw output, exits, commit, tree, and performance details. No local-only harness, Herdr, live statusline, user-home data, security setting, implementation, branch, or staging operation was changed by this attempt.
````