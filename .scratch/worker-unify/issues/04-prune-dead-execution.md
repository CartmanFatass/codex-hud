# 04: Delete the dead execution code

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** `.scratch/worker-unify/spec.md` decision 5, from oracle report §2 A5 (verify each item again; the
report is from 2026-11-17 morning). Only code with no production caller goes; nothing the panel shows changes.

- [ ] `src/roles/routing.ts`, `roles.ts`, `adapters.ts`: move the live identity/error helpers `selection.ts` still
      imports, then delete the old routing/slot/adapter machinery and the tests that only exercise it.
- [ ] `src/roles/selection.ts`: keep `parseRosterRoot`, `formatRosterRoot` and the root-key hash; delete
      `saveRosterSelection`, `loadRosterSelection`, `resolveRoster`.
- [ ] `src/roles/association.ts`: delete `writeAssociation`; keep `parseAssociation` and `completeNativeRef`.
- [ ] `src/roles/job-receipt.ts`, `job-store.ts`: delete what only the dead writer used.
- [ ] `src/roles/pi-dispatch.ts`: delete `observeDispatch`, `waitDispatch`; keep the parsers live collectors use.
- [ ] `src/roles/herdr-run.ts`: delete `tabCreateArgs`, `agentStartArgs`, `promptArgs`, `waitArgs` if still uncalled.
- [ ] Keep: `JobObservationCollector`, `TaskObservationCollector`, `native-calls.ts`, `managed/host-ipc.ts` and any
      reader the panel uses.
- [ ] Full suite green; `rg` shows no production import of a deleted symbol; the report lists every deleted file and
      export.

## Comments
