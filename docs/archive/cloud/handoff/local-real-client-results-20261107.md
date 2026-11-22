# Local real-client results (2026-11-07)

First runs of the native thin path (`aa4b9dd` plus local fixes) against real installed clients, using the
[local validation kit](local-validation-kit.md). Platform: WSL2, Node 24.22.1. Each test was one headless parent
session driven by short scripted prompts; children did one harmless file write in a scratch directory. Parent
and child models: Codex `gpt-6-luna` medium on the owner's `codex2` test account; Claude `claude-haiku-5-5`;
Pi's own default. Jev used the shared Chrome (headless, CDP 9222) on `https://example.com`.

## Results

| Check (validation guide) | Codex (LV2) | Claude (LV3) | Pi (LV4) | Jev (LV5) |
| --- | --- | --- | --- | --- |
| 2. create, send, observe, read | PASS | PASS | PASS | PASS (`jev_create`/`run`/`snapshot`/`list`) |
| 3. parent exits, host continues | PASS | PASS | PASS | PASS (owned tab stays open) |
| 3. same parent resumes, lists, reads | PASS | PASS | PASS | PASS |
| 1. another native session is refused | PASS | PASS | PASS | PASS |
| 2. explicit resume of the child | PASS | PASS | PASS (with `sessionId` in the native ref) | n/a |
| 7. explicit close, host drains | PASS (≤ 1.2 s) | PASS (≤ 2.1 s) | PASS (≤ 5 s) | tab closed; host does **not** exit (F7) |

Not covered yet: Claude background-waiter wake, Codex queue wake as a deliberate test, native permission
request routing (`managed_requests`/`managed_respond`; no request arose), Jev blocked/CAPTCHA handoff, and the
terminal HUD rows (check 6). The Pi extension wake did fire during LV4 (`hud_wake` custom message, extra parent
turn).

## Findings

- **F1, fixed in this commit.** The hud-mcp build never emitted `src/managed/host-entry.ts`, the process the
  native host starts from, so every `managed_create`/`jev_create` failed with `native_host_start_failed`. The
  tests ran on a copied build artifact. The fix adds the entry to the hud-mcp program, adds a test that starts
  the default entry, and makes packaging require it.
- **F2, Codex wake turn cannot call the tools.** A Codex parent turn whose `turn_trigger` is `queue` gets
  `identity_unverified` on every hud call (`packages/hud-mcp/src/resolvers.ts`, the `exec` source branch). The
  Codex wake path delivers through `codex queue`, so a parent woken that way may be unable to act in that turn.
  The `codex queue` receipt was also `unknown/timeout` twice out of three.
- **F3, child environment.** Codex passes MCP servers a filtered environment, so the host and its Codex child had
  no proxy and the child's turn timed out until proxy variables were added for the session. Children also load
  the user's full MCP/plugin set (8 MCP servers per Codex child, 7–15 s startup; Claude and Pi likewise).
- **F4, Jev interpreter and credentials.** The bridge runs `python3` unless `HUD_JEV_PYTHON` is set, which does
  not have the installed Jev package. The Agent's model credentials must be in the environment when the
  session's host first starts; a later export never reaches the already running host.
- **F5, `record_dir` forces Jev screenshots;** one 5 s screenshot IPC timeout occurred under load.
- **F6, hosts started by read-only calls stay alive.** A session whose first call is `managed_list`/`jev_list`
  starts a host that never exits without an explicit close (documented bootstrap behaviour, but a read leaves a
  process behind).
- **F7, Jev hosts do not drain.** After an explicit `jev_close` of the last instance the bridge exits but the host
  keeps its listening socket open (observed > 3 minutes); `managed_close` drains correctly.
- **F8, heavy responses.** `managed_status` for Claude returns the full SDK initialization result (~38 KB); a
  parent printing results verbatim ran into a 600 s limit.
- **Test-only notes.** A Pi resume reference needs `sessionId` (`sessionFile` alone is refused; this matches the
  skill). The Claude child ran in the user's `bypassPermissions` mode, so no permission request was raised.
  `--allowedTools` did not stop a headless Claude parent from using Bash/Read.
