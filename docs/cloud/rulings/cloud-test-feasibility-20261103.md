**Oracle recommendation: cloud verification is feasible for the normal synthetic checks, but no complete, ready-to-run cloud route is currently verified or authorized. Keep all three packages unaccepted and unmerged.**

Inspected `universal-hud` at `2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e`. This assessment was read-only: no tests, workflows, jobs, repository edits, permission changes or denied-capability retries.

### What is actually available

- **Current cloud executor:** suitable for permitted builds, static checks, rendering tests and performance evidence. It cannot complete the unchanged full gate: AF_UNIX and ptrace are denied, and `CONFIG_PROC_CHILDREN` is absent. The pinned baseline/current diagnosis reproduced all five children-interface failures on both Node 22 and 24. They fail before their intended fault-injection assertions, so diagnosis is not a pass. [Diagnosis](https://github.com/CartmanFatass/codex-hud/blob/dots/hyg2/docs/cloud/handoff/hyg2-topology-diagnosis.md)
- **GitHub Actions:** real, previously operational infrastructure, not merely hypothetical. Repository history contains six runs, all `main` pushes; no open PR or run for `universal-hud` or the package branches was found. The latest run, October 31, used GitHub-hosted Ubuntu 24.04 on Azure. Its integration job passed 26 suites, skipped one; the overall run failed two color-sensitive unit assertions in the Node 22/`NO_COLOR=1` job. These are old-main results, not acceptance evidence for current work. [Run](https://github.com/CartmanFatass/codex-hud/actions/runs/41185989688)
- **Another connected cloud executor:** none discovered. The environment catalog returned the local desktop only, with an empty saved-cloud-environment list. A new remote VM, saved environment or self-hosted runner is speculative until provided and verified.

### Why existing CI cannot be used unchanged

The only workflow on the inspected branch is [`.github/workflows/ci.yml`](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/.github/workflows/ci.yml):

1. Triggers are pushes to `main` and pull requests, with no `workflow_dispatch`. Ordinary package-branch pushes do not start it. Touching `main` is prohibited.
2. It is not the full README gate. It lacks explicit hud-mcp build/tests, format checking, diff checking and the strict package performance series. Visual tests occur indirectly within `npm test`, subject to earlier failure short-circuiting.
3. Its main test matrix includes Node 18/20, while the current cloud contract requires Node 22 ≥22.13 or Node 24.
4. It runs `npm run test:integration`, whose script enumerates real-tmux suites. Those remain explicitly classified as local-only by `AGENTS.md`. Opening a PR simply to trigger this workflow would therefore launch additional work beyond the currently permitted synthetic check set.
5. Connector read access works. Rerun tools exist but require Actions write permission, which the observed repository role/install metadata does not establish. No dispatch tool is exposed. Rerunning an old `main` job would not test the required branch anyway.

### Recommended conditional route

Approve a **separate synthetic-only verification workflow on a dedicated non-main branch**, rather than trigger or repurpose the existing CI blindly.

Its required scope:

- Use an ordinary GitHub-hosted **Linux x86-64 VM** with Python and Bash, pinned compatible Node 22/24 patches, and unchanged tests. x86-64 matters: the ptrace tests otherwise skip by architecture.
- Establish the permitted runner’s AF_UNIX, child tracing and `/proc/.../children` capabilities first. Existing Actions history does **not** prove current ptrace or children-interface availability.
- Do not alter sysctls, security settings, kernel configuration, seccomp, privileges or sandbox policies. Stop on any denial rather than add a workaround.
- Run the entire [README check set](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/cloud/README.md), plus each package’s required checks, on exact recorded SHAs/trees. Use temporary `HOME`/`HUD_HOME`, synthetic data, and PID-owned cleanup.
- Preserve every result and named-flake rerun. Separately record stages not reached after failure.
- Run B10B baseline/candidate performance serially on the **same VM**, with three declared fresh-process runs per runtime and unchanged benchmark/provenance requirements. Separate jobs get separate machines, so they cannot automatically supply a matched-host comparison.
- Eventually verify the exact accepted integration tree. Package-local results cannot replace that gate.

GitHub documents standard hosted runners as fresh VMs and warns that images change over time, supporting runner/version recording rather than assumed capability. [Runner documentation](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)

Do not assume adding `workflow_dispatch` only to a feature branch solves triggering: GitHub’s documentation requires default-branch presence for this event. A deliberately approved branch-push workflow avoids needing a `main` change. [Trigger documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

### Required owner decisions / authorization

1. **Authorize the concrete CI work:** workflow file and dedicated branch, push/trigger scope, exact package/integration targets, and synthetic-only public logs/artifacts. This is outside the performance package’s file whitelist and beyond this read-only assessment.
2. **Confirm permitted executor capability**, rather than authorize evasion of current denials. A separate sanctioned CI environment must have its own permitted execution scope.
3. **If connector access is insufficient:** obtain the necessary action-time permission for any expanded persistent GitHub access, or have the owner perform the workflow setup. No unapproved tokens, permission expansion or credential work.
4. **No contract decision is needed merely to move ordinary synthetic checks to a suitable Linux cloud VM.** However, abandoning local testing leaves formal WSL P-06-7 qualification and real Herdr/logged-in CLI/Jev/live-configuration acceptance outstanding. Replacing those with cloud evidence changes supported-platform or acceptance policy and requires an explicit owner decision. Current cloud results cannot be relabeled as that qualification.

The [STATE merge rule](https://github.com/CartmanFatass/codex-hud/blob/2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e/docs/handoff/STATE.md) remains unchanged: Oracle acceptance, verified report and complete green checks on the integration tree. A capable runner resolves an execution blocker; it does not resolve remaining product failures, performance findings or acceptance requirements.