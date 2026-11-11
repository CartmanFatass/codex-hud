# Pi footer ownership (PI-FOOTER-PORT)

The historical `extensions/pi/hud-footer.ts` opt-in, its three-row renderer and
`/hud-footer` command are retired. The ordinary HUD pi package now owns the pi
footer and editor frame, through the authorised p10k-footer port. There is one
footer, not a second selectable historical one.

See the [current pi activation reference](../reference.md#pi-package-activation-r6a-a5)
and [package owner runbook](../../integrations/pi/package/README.md) for explicit
activation, the mandatory p10k backup/removal step, palettes and marks, settings
import, segment controls, `/hud footer off` native restoration and rollback. Neither
startup nor installation discovers/imports old p10k settings automatically.

The separate `createPiDelegationSummaryProvider` API and native identity types
remain available from `dist/harness/pi/footer.js` for existing core consumers.
That explicit read-only provider still requires `HUD_HOME` and
`HUD_PI_SOURCE_ROOT`, verifies the native session file/directory against the
configured source root and reads only a matching bounded committed summary.
It conveys no identity/capability grant. The ordinary package's visible
role-work segment uses its existing exact-root role-summary reader instead.

Owning checks: `pi-footer.test.ts` (exact original ANSI parity table),
`pi-package.test.mjs` (startup/footer-off/reload/shutdown, independent panel controls and six proxies),
`plugin-independence.test.mjs` (explicit section-only import), and the retained
provider test in `delegation-summary.test.ts`. Render cost is opt-in in
`tests/perf/pi-footer.test.ts`. Use temporary HOME/HUD_HOME/CODEX_HOME and unset
HERDR variables for all checks; no provider or owner settings are needed.
