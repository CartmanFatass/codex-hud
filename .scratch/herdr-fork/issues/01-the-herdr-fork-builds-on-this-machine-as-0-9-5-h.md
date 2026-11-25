# 01: The herdr fork builds on this machine as 0.9.5-hud and never self-updates

**Status:** done
**Owner try:** no
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Plan: `.scratch/herdr-fork/plan.md` (read it). Repo: `~/projects/herdr-hud`, branch `hud` at upstream e8d7d970, remote `upstream` with push disabled; never push anywhere. Install Zig 0.16.0 user-local (e.g. `~/.local/opt/zig-0.16.0`, linked into `~/.local/bin`; verify the download checksum against ziglang.org's published index) and make the pinned Rust toolchain work (`rust-toolchain.toml` pins 1.96.1; rustup is present: install 1.96.1 or bump the pin to the installed 1.97.1, whichever builds). Lock self-update: `herdr update` and `herdr channel set` refuse with `self-update is disabled in the HUD herdr fork` (`src/update.rs` ~2184, `src/cli.rs` ~190), `version_check` defaults false (`src/config/model.rs`), build reports `0.9.5-hud.<sha>` (`src/build_info.rs`, `HERDR_BUILD_CHANNEL=hud`). Add `HUD-FORK.md` at the repo root: what the fork changes, how to build, how to install (main session only), how to take an upstream commit. Keep Apache-2.0 LICENSE/NOTICE and mark modified files per the license. Do not replace `~/.local/bin/herdr` and do not touch the running herdr server: install is main's step with owner confirmation.

- [x] `cargo build --release` succeeds in ~/projects/herdr-hud; the built binary prints 0.9.5-hud.<sha> for --version
- [x] The built binary's `update` and `channel set` refuse with the fork message and change nothing
- [x] Upstream's own test suite for the touched crates passes (`cargo test` or the justfile's test target), or the report lists pre-existing failures on unmodified upstream
- [x] HUD-FORK.md exists; LICENSE/NOTICE kept; nothing pushed; ~/.local/bin/herdr untouched

## Comments

- 2026-11-25 main: done in ~/projects/herdr-hud commit 042dbe83 (job jf644d80d2401c39b): 0.9.5-hud.042dbe83, Rust 1.96.1, Zig 0.16.0 checksum-verified at ~/.local/opt; Zig deps seeded via curl (local proxy breaks Zig HTTP). Pre-existing upstream failure tests/client_mode.rs sigwinch_refreshes_host_palette_without_resizing; 11 integration binaries not reached (incl. live_handoff): run before install.
