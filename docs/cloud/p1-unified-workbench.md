# Unified synthetic HUD workbench

This is a fixed cloud lab, not a provider client or production capability. A fresh private temporary SQLite ledger contains one simulated Claude-labelled parent and two bound synthetic Codex/Pi children through the existing launch, supervisor and lab handshake paths. A third unbound synthetic Pi request is available as a cancellation target. The panel uses `LinkTickCollector` and the existing delegation renderer and Inspector. The separate **SIMULATED Jobs** section comes from `FakeJevBrowser`; it is not a ledger session or managed edge.

```sh
npm run build
npm run build:hud-mcp
npm run build:test
node scripts/workbench/unified.mjs
```

In a terminal use `j`/`k` or arrow keys to select; `i` opens Inspector, `l` shows selected owned-run stdout, `c` asks the existing service to cancel the selected owned run, `r` refreshes, and `q` exits. Selection follows stable node identities. An accepted cancellation is a request, not proof of termination; the screen continues to display observed ledger state. Logs and cancellation are restricted to run IDs accepted by this world. There is no resume/open action and no access to user sessions or arbitrary files.

For a finite machine-readable exercise use `node scripts/workbench/unified.mjs --json`. It selects and inspects Pi and Codex, reads owned logs, requests cancellation of the fixed hold target, verifies rejection of an unowned run, and emits the real panel projection and separate fake job. `node --test tests/workbench/unified.test.mjs` tests this path. `python3 tests/workbench/unified-tty.py` exercises actual terminal input and restoration.

The Pi ordinary observation is read from the synthetic v3 session with the real `PiAdapter`; it is labelled a sample, not a committed observation. Codex transcript coverage remains unloaded unless independently observed. The fake Jev job models a lost response and shows the exact synthetic holder/generation as uncertain; no real browser, account, network request, job table or session relationship is created.

The launcher supplies an allowlisted worker environment before importing lab code. The world owns its temporary root, uses a bounded graceful cleanup attempt and then signals only process scopes/stamps it can still corroborate. It does not sweep by process name. Pi/Codex session identities and the parent authority are explicitly synthetic; no live-client identity, production Pi capability, task success or billing claim follows from this demo. Existing unresolved adjacent B45 ledger-busy results are not converted into a full-suite-green claim.
