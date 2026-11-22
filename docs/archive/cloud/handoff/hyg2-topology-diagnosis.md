# HYG2 read-only diagnosis: five process/topology failures

## Finding

The five previously unexplained failures have a concrete common cause in this execution environment: the running kernel does not provide `/proc/<pid>/task/<tid>/children`. `/proc/config.gz` explicitly reports `# CONFIG_PROC_CHILDREN is not set`. The interface is absent even for a currently live shell whose process directory, task directory, and both stat files exist.

The Linux man-page source confirms that, since Linux 4.2, this interface is governed by CONFIG_PROC_CHILDREN: https://kernel.googlesource.com/pub/scm/docs/man-pages/man-pages/+/refs/tags/man-pages-6.11/man/man5/proc_tid_children.5 . The kernel configuration source describes that option as including the task children file: https://kernel.googlesource.com/pub/scm/linux/kernel/git/torvalds/linux/+/285767604576148fc1be7fcd112e4a90eb0d6ad2/fs/proc/Kconfig .

Exact failure paths:
- `tests/unit/b3h-production.test.ts:102`: each of the three H05 role cases directly reads the missing children file and throws ENOENT. The intended SIGKILL at line117 has not been reached.
- `tests/unit/run-light-leader.test.ts:54–68`: `auxiliaryStamps()` reads the same interface; its catch returns an empty array.
- `tests/unit/run-light-leader.test.ts:851–853`: both waiter/forwarder cases search that empty array, obtain undefined, and fail `assert.ok(target)`. Their intended SIGKILL at line854 has not been reached.

This explains the five observed failure points without inferring helper death from ENOENT. It does not establish that the underlying lifecycle/fault-boundary behaviors pass on a capable environment.

## Pinned baseline/current comparison

Tests began only after the dispatcher explicitly confirmed the performance series had finished.

Baseline:
- Revision: f1e2a8408fbc6ddef181978e8a2d9fd5831242e9
- Tree: 84fd5e55643891c83f97a79f32fe2fe949b2476e
- 1006 archived source blobs verified against Git before and after execution.

Current HYG2 tested source:
- Revision: dced9114e9d15977fef07fa52c1a329a58dfa505
- Tree: 380b637c6cc867cde2a62d38789743e65f694b62
- 1010 archived source blobs verified against Git before and after execution.
- This is the source-equivalent local revision previously verified against published HYG2 fix4e120f5. The affected tests, process.ts, group-leader.ts and integration fixture have identical blob IDs in baseline and current.

Both revisions were exported into separate scratch snapshots. Installed dependencies were shared read-only through a symlink; tracked source was not edited. The package-lock.json SHA-256 is identical in both snapshots: 98a7e2d3f5256810fe477812be64b35411aeede8b34f91e648d62e96c39e3294. TypeScript5.9.3 built both dist and dist-test successfully, exit0 for both build commands on each snapshot.

Diagnostic command, run separately for each revision and runtime:

node --test --test-concurrency=1 --test-name-pattern='^H05 real-ledger|^only (waiter|forwarder) death' dist-test/tests/unit/b3h-production.test.js dist-test/tests/unit/run-light-leader.test.js

Results:
- Baseline, Node22.23.4: 5 tests,0 pass,5 fail,0 skipped; exit1.
- Baseline, Node24.22.1: 5 tests,0 pass,5 fail,0 skipped; exit1.
- Current, Node22.23.4: 5 tests,0 pass,5 fail,0 skipped; exit1.
- Current, Node24.22.1: 5 tests,0 pass,5 fail,0 skipped; exit1.

Every run reproduces the same three H05 ENOENT failures and two missing-target assertions. These are targeted diagnostic selections, not substitutes for the full README check set.

## Runtime and isolation

Host d14215e6cbaa; Linux6.18.57 x86_64. Each snapshot used temporary HOME/HUD_HOME and workspace-backed TMPDIR. NODE_OPTIONS, NODE_USE_ENV_PROXY, NO_COLOR and FORCE_COLOR were unset for the offline diagnostic runs. No security settings, sandbox rules, sockets or ptrace policies were changed or bypassed; no socket/ptrace tests were selected.

Runtime binaries:
- Node24.22.1: /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node
  SHA-256:61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d
- Node22.23.4: /workspace/scratch/6daef0397a95/hyg2-node22/node_modules/node/bin/node
  SHA-256:94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90

Installed dependencies: @iarna/toml2.2.5, chokidar5.0.0, readdirp5.0.0, @types/node20.19.29, undici-types6.21.0, typescript5.9.3, prettier3.9.9.

The original checkout still has only its pre-existing unstaged node_modules/.package-lock.json modification. No repository files, commits, branches, or environment security settings were changed by this diagnosis. Scratch source exports, build artifacts and evidence files were created solely for the authorized comparison.

## Raw capability evidence

Complete contents of proc-capability.log:

READ-ONLY CAPABILITY OBSERVATION; NO TESTS RUN
UTC=2026-11-03T14:06:08Z
HOST=d14215e6cbaa
KERNEL=Linux 6.18.57 x86_64 GNU/Linux
SHELL_PID=2
COMMAND: ls -ld /proc/$SHELL_PID /proc/$SHELL_PID/task/$SHELL_PID
dr-xr-xr-x 9 agent agent 0 Nov  3 06:06 /proc/2
dr-xr-xr-x 7 agent agent 0 Nov  3 06:06 /proc/2/task/2
COMMAND: ls -l live-process stat, task stat, task children
ls: cannot access '/proc/2/task/2/children': No such file or directory
-r--r--r-- 1 agent agent 0 Nov  3 06:06 /proc/2/stat
-r--r--r-- 1 agent agent 0 Nov  3 06:06 /proc/2/task/2/stat
COMMAND: zcat /proc/config.gz | grep selected options
CONFIG_NAMESPACES=y
CONFIG_PID_NS=y
# CONFIG_CHECKPOINT_RESTORE is not set
CONFIG_PROC_FS=y
# CONFIG_PROC_CHILDREN is not set
COMMAND: git show baseline revision/tree
f1e2a8408fbc6ddef181978e8a2d9fd5831242e9
84fd5e55643891c83f97a79f32fe2fe949b2476e
docs(handoff): dots handoff: AGENTS.md, dispatch-only roles, run-2 package briefs
COMMAND: git show tested revision/tree
dced9114e9d15977fef07fa52c1a329a58dfa505
380b637c6cc867cde2a62d38789743e65f694b62
test(hygiene): reject buffered messages after helper failure
COMMAND: compare relevant blobs, baseline then tested
PATH=tests/unit/b3h-production.test.ts
3fb1c92adc228f86d7b176812499352bce56f91b
3fb1c92adc228f86d7b176812499352bce56f91b
PATH=tests/unit/run-light-leader.test.ts
823b738b944f6ac432cb980828b3eeef2b9a6954
823b738b944f6ac432cb980828b3eeef2b9a6954
PATH=src/core/run/process.ts
fb45508e044cc99e9cd13a6b7575ba10cd7c2bff
fb45508e044cc99e9cd13a6b7575ba10cd7c2bff
PATH=src/core/run/group-leader.ts
bb27681b892db6242884ac9a8285b8315c020e6a
bb27681b892db6242884ac9a8285b8315c020e6a
PATH=tests/int/fixture.mjs
fed584ac64c661b51cd2118dc48fb050e0710142
fed584ac64c661b51cd2118dc48fb050e0710142
COMMAND: git status --short
 M node_modules/.package-lock.json

## Complete evidence locations and hashes

Directory: /workspace/scratch/6daef0397a95/hyg2-diagnosis-20261103/

- proc-capability.log — SHA-25600107342d501cba4cf942a7b126037ac1f5ac0cc9d08d20d288873d9016f863b
- baseline-build.log — a0b3959f036d3489b03f57237503ee48e7366386d6bc05a30b47c5e0320d1aa8
- current-build.log — 049eadcc0b6b4c2b5305f6039c5dca42133657b8ff6635098f081e8fafc86cdf
- baseline-v22.23.4.log — dea9dbe240ad411fd2b6117d2205f3d6bf28b4c2aca9d8f792b4e463c379cf31
- baseline-v24.22.1.log — 13bc4d05299c9c271eb9c627ac6f94cee0b6172f92914f36b755dd8f0f84f4d8
- current-v22.23.4.log — 02b589f84a5d390a8271e59dfd86d180806b7fa897d2c92e12b5f7b25c7aa400
- current-v24.22.1.log — 93985b78380fc0181470a1c3e6dc58d5f5bf97954cd8a2d52b33d4a34bb576b5
- comparison-summary.log — 51661f60a60f73ffdba06519e8c1bcdfda64f7f7443f56e401ac3e73f666e2ef
- run-comparison.sh — 82e5f2520c79cf4399007fe031a504fb70d0280e2275a4246b090b26a8189ae1
- verify-snapshot.py — 0aad3cdb191ef02fb38d742887c6d293ca03bfde0470073893e6a1f9deda905f

SHA256SUMS contains the complete checksum list. Every comparison run embeds revision, tree, runtime path/version, host, command, isolation paths, kernel capability and exit code. Each source snapshot is verified again after its run.

## Disposition

No HYG2 code fix is indicated by these five failures. The unchanged tests require an authorized execution environment providing the task children interface; the separate socket/ptrace restrictions also remain to be resolved for the full suite. Do not enable security capabilities or change kernels under this diagnosis, weaken assertions, skip failing acceptance checks, or treat this diagnosis as an accept verdict. The full-green merge gate remains blocked.