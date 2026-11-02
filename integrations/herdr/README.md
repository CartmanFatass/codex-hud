# Herdr integration

The optional implementation is `src/integrations/herdr/`. The core imports only
its existing interfaces. Compose one `HerdrClient` and `HerdrRegistry` per socket;
preflight and ordinary registry reads share single-flight, 3-second caches. There
is no poller or daemon. `HERDR_ENV=1` and `HUD_HERDR!=0` are required. Disabled,
missing, mismatched or unavailable Herdr returns an empty registry and a bounded
preflight diagnostic. Version pins are in `VERSION`; `cells.json` is the shared
empty manifest shape and grants no verified product capability.

`CliHerdrTransport` takes an explicit absolute socket and a **trusted full server
ProcessStamp**. On Linux it verifies the process before/after checking the exact
listening endpoint in `/proc/net/unix` and that process's socket FDs; filesystem
socket metadata is an additional incarnation anchor, not process identity. With
no trusted server stamp it refuses preflight. An inherited PID, socket path,
workspace ID, process-name match or successful ping does not supply that proof.
B11 must obtain the stamp from its trusted launcher/discovery. The constructor's
stamp is copied by the caller and must not be sourced from model input.

`HerdrRegistry` requires a trusted `HerdrSessionResolver` for positive records.
It returns `{sessionRef, harness}` with the independently verified harness stamp.
It must verify a complete `SessionRef` against the selected canonical source,
native session evidence and current process observation. Native session IDs and
cwd do not identify a source. Without a resolver, unresolved panes are omitted;
no fake session, source, managed run or parent edge is invented. Registry clocks
and occupant generations are separate; content revision does not change the
occupant. The shell, foreground group leader and actual harness are separate observations.
For agents, locator.process and the occupancy fingerprint use the independently
resolved harness stamp. Fresh action checks resolve it again; missing or replaced
harness evidence invalidates old locators even when a supervisor/session is stable.
The resolver receives an AbortSignal and has a 50ms deadline; it must stop its own
I/O when aborted. Source resolvers independently establish harness and source.

`HerdrHost.openSurface('tab', options)` creates an unfocused tab with explicit
cwd and repeated `--env KEY=value` arguments. Splits require an explicit parent
pane. Opening performs a bounded shell-readiness probe. `runInSurface` accepts
one `LaunchCommand` and quotes argv only at the final text hop. It invokes
`pane run` once, preserving the pane shell's foreground job topology (scheme 甲).
Managed surfaces latch the dispatch before creation; each surface latches launch
before the CLI call. A timeout or lost acknowledgement never resets either latch.
Only a preflight/validation failure before dispatch has `fallbackAllowed=true`.
The selector must freeze and re-digest a changed final profile before accepting
an intent; these adapters never launch a fallback or retry an accepted intent.

For H08, wait until the supervisor is registered and independently verified as the
foreground group leader AND the actual harness/source is independently resolved.
The immutable locator captures that intended harness process, never an earlier
startup shell or supervisor placeholder. Obtain a fresh surface observation and call
`host.recordLocator(runId, bindingGeneration, surface, supervisor, persist)`.
The real `persist` implementation is:

```ts
fixed => recordRunLocator(ledger, runId, supervisor, fixed)
```

`recordRunLocator` is exported by `src/ledger/index.ts`. It uses the existing
`runs.locator` column and full registered-writer checks, current run/generation
and slot checks. First write wins; the same value replays; a different one raises
`locator_conflict`. It stores only allowlisted locator fields, never an environment
table. Host/procfs work occurs before the short transaction. The ledger's existing
20 ms cumulative acquisition limit applies; there are no lock retries outside
that budget. B11 can supply `readLocator` to reconstruct a fresh surface from a
committed fixed locator after restart; no occupant generation is persisted or
borrowed from the run's binding generation.

`HerdrRunControl` delegates status, cancellation and reconciliation to the actual
core controller. Its immutable handles retain the original run and binding.
The trusted original launcher may supply a one-shot `InitialInputPermit`, only
after obtaining the fixed locator and the core's current `interaction.input`
permission. `sendInput` checks that permission, run/generation, live supervisor,
fixed locator and fresh occupant, then sends `agent prompt` once. A lost reply
consumes the grant. Never rebuild grants in recovery or construct a second
controller to retry. No general prompt, TTY cancellation or retirement is added.
Managed host focus/sendKeys also need a supplied core status reader and current
interaction permission and a fresh foreground group leader matching the registered
supervisor (scheme 甲); ordinary independently observed sessions can navigate
without a managed run.

Identity classification belongs in the **actual foreground launch environment**
(`HERDR_AGENT` on the harness/attach process, as in the existing launcher), not a
synthetic registry report. Late `attachIdentity` refuses with
`herdr_identity_requires_launch_env`.

`closeSurface` checks owned split/run/stamp/generation, the retained creation
shell and terminal, current foreground state and layout. Tab roots are refused.
Protocol 22 exposes only target-based `pane.close`, so every otherwise eligible
close refuses with `herdr_conditional_close_unavailable`: a client recheck cannot
exclude unrelated foreground work starting before destruction. No `pane.close`
or `tab.close` is dispatched. This follows B7 Oracle ruling 1 and NOTIFY §4.8's
leave-open rule. Visible MVP panes are closed by the user. A future positive close
needs an approved host-side foreground/occupant guard, the `surface.created`
producer, and lifecycle wiring outside B7.

Target-only focus/prompt also require B14 delivery-time replacement tests before
product capability promotion. Tests do not promote the empty manifest. B11/B4
must retain their normal `capability_unverified` gate. B3b-C owns future visible
control; no host closure is used for visible cancel or retirement here.

Run `npm run test:herdr`. See `tests/herdr/README.md` for private-instance isolation.
