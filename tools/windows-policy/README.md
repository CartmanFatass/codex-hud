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
the `/init` binfmt interpreter, a protected WSL interop socket tied directly to a
live listener owned by that `/init` process, and a unique procfs drive mapping for OS-reported system folders. It
does not infer Windows ACLs from Linux owner bits, guess `/mnt/c`, or execute a
host-discovered system binary. Unsupported socket layouts, mount aliases,
shadows, paths, helper revisions and transport errors fail closed.

A daemonized or reparented tmux does not have to descend from the interop server.
The observer joins the pathname's listening UNIX inode to the server's fd table,
checks its executable and process stamp, compares the server's socket mount view,
and repeats those observations. If procfs access is denied, ownership is unknown.
On the normal non-sticky `0777` `/run/WSL` layout, this evidence is diagnostic only:
the separately launched `/init` can reconnect through a rebound pathname. The
observer reports the directory mode and listener-observation status with
`authority: none`, refuses Windows helper execution, and continues local config
diagnostics. A connection-bound peer guarantee is still needed to execute through
that writable transport; pre/post checks are not a substitute.

This is source support, not Windows/WSL runtime or product-cell qualification.
Account/provider state, remote policy/connectors, configuration selection and
effective merging remain explicitly unknown. All WSL and ordinary-provider
candidates remain barred from capability matching and launch.
