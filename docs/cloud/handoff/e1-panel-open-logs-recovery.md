# E1 panel Open and Logs recovery handoff

This is a bounded cloud-functional candidate, not live Herdr or provider qualification. It extends the shared-summary/settings-migration base without chat UI adaptation, settings activation or capability promotion. See [feature behavior and reproduction](../e1-panel-open-logs.md).

## Review corrections

The first recovery review rejected two artifact-read behaviors:

- Valid metadata padded by 8 MiB was read synchronously without a byte bound.
- Replacing a log with a different same-directory private regular file was accepted on refresh.

The corrected panel path reads metadata through a fixed 64 KiB limit plus one overflow byte, with size checks before and after the bounded descriptor read. Oversized metadata is rejected before JSON parsing; growth after the first stat cannot trigger an unbounded read. The existing recovery/writer API remains unchanged. Metadata may still be atomically updated, with the selected run identity revalidated.

Each successfully read stdout/stderr stream retains its device/inode identity for that viewer. Refresh, paging and stream switching reject replacement or disappearance. Same-inode append and truncation remain supported. No pager, arbitrary command, transcript replay or new launch authority is introduced.

## Recorded checks

Node 24.22.1, Linux x64, synthetic fixtures and isolated temporary homes:

- Main, test and hud-mcp TypeScript builds: PASS.
- Final serial scoped suite: 104 PASS, 2 FAIL, no skips. All five new artifact-safety regressions passed. The failures were existing host-worker timing paths: an initial availability check and a 500 ms fixed-run ledger-read deadline.
- One isolated rerun of the panel suite, with source and deadlines unchanged: 15 PASS, 0 FAIL, no skips. The original failed run is retained and is not relabelled as a pass.
- Product composition demo, fixture hygiene, scoped formatting and diff checks: PASS.
- The new regressions include preexisting oversized metadata, growth after stat, metadata refusal before Open focus, regular stdout/stderr replacement, legitimate append/truncate, and bounded-read instrumentation.

The executable correction tree is `5a342e6ab6863c9ec08ff50b11d1f5f90b4a278a`; this handoff is a documentation-only addition. The prior reviewed source tree was `444f9e1f5b5881089afd4ab0ebcb7ae8d6c61451`.

## Limits

The 500 ms worker request and 3 s availability windows are implementation deadlines, not hard native-call preemption guarantees. Cleanup can remain pending after a delayed native call; replacement workers do not overlap that cleanup. Real Herdr, authenticated provider sessions, broad historical suites, formal performance qualification and hosted CI are not established by these checks. The cloud-check entrypoint does not yet enumerate the new panel suite; its scoped local evidence above is separate. No merge to main, default activation, global installation or release is included.
