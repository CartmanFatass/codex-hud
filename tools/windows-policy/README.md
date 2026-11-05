The WSL policy observer uses this native helper instead of parsing localized
`reg.exe` errors. It reads only the two `ClaudeCode\Settings` registry values
(64-bit HKLM/HKCU view) and system folder locations through Windows APIs. It
does not read credentials, run profiles/helpers, fetch policy, or change settings.

Build the x64 and ARM64 artifacts and receipts with:

```sh
npm run build:windows-policy -- /absolute/path/to/go
```

Go 1.27.3 cross-compilation was checked on the cloud Linux host. The build uses
only the Go standard library, disables module/network resolution, and emits
ignored files under `dist/windows-policy`. Include both the executable and its
JSON receipt when assembling a deployment, alongside the helper source. A normal
TypeScript build does not install a compiler or download/build this optional
Windows component. Missing artifacts produce an explicit unverified reason.

The default adapter trusts the loaded HUD installation and pins the helper's
source/artifact hashes and file identities before/after invocation. It checks
the `/init` binfmt interpreter, a protected WSL interop socket tied to an observed
ancestor, and a unique procfs drive mapping for OS-reported system folders. It
does not infer Windows ACLs from Linux owner bits, guess `/mnt/c`, or execute a
host-discovered system binary. Unsupported socket layouts, mount aliases,
shadows, paths, helper revisions and transport errors fail closed.

This is source support, not Windows/WSL runtime or product-cell qualification.
Account/provider state, remote policy/connectors, configuration selection and
effective merging remain explicitly unknown. All WSL and ordinary-provider
candidates remain barred from capability matching and launch.
