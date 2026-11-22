# Local pi launch (C1 slice)

`hud pi launch` starts the installed `pi` on PATH in the current working directory.
Terminal stdin/stdout/stderr are inherited. Native arguments go after `--`:

```sh
hud pi launch
hud pi launch -- --continue
hud pi launch -- --session /absolute/session.jsonl
hud pi launch -- --print "Summarize this repository"
hud pi launch --executable /absolute/path/to/pi -- --help
```

HUD passes argument bytes unchanged with `shell: false`, never concatenates a shell
command, and never retries the child. Pi chooses interactive/print behavior from
its own native flags and terminal streams. Existing pi configuration, extensions,
MCP configuration and credentials remain pi's responsibility. No configuration is
installed or changed by this launcher. The child can of course perform whatever
the user requested of pi; this is not a read-only command or a sandbox.

Inherited `HUD_CLAIM`, `HUD_RUN`, `HUD_LINK`, `HUD_MCP_REGISTRY_DIR`,
`HUD_RUN_PORT_MODULE`, `PI_SESSION_ID` and `PI_SESSION_FILE` are removed, so a new
local process does not receive the parent's managed run claim or stale session
markers. Other environment values, including native pi configuration paths, are
preserved. HUD does not log arguments or credentials. No ledger is opened and no
claim, binding or capability verification is produced.

This is local user initiation, **not** managed `delegate_spawn`/`delegate_resume`.
Passing `--session` or `--continue` asks pi to resume natively; it is not a HUD
identity proof. This command does not register hud-mcp with pi or declare any
managed pi capability verified. Managed launch/supervision, MCP identity and panel
collection are separate integration work, not prerequisites for using this wrapper.

## Sources and validation scope

Official pi documentation inspected at commit
`9b9cb30ae16e5802ba556b282b38fc41117ee5e1`:
- [CLI](https://github.com/earendil-works/pi/blob/9b9cb30ae16e5802ba556b282b38fc41117ee5e1/packages/coding-agent/docs/cli.md): argv, working-directory behavior, print/JSON/RPC, continue/resume/session.
- [Environment](https://github.com/earendil-works/pi/blob/9b9cb30ae16e5802ba556b282b38fc41117ee5e1/packages/coding-agent/docs/environment-variables.md): session markers describe the calling pi shell-tool session.

Validation uses synthetic executables and mocked launch boundaries, including the
actual built `bin/hud` dispatcher. No real pi provider/account/model request is
needed for these tests. Real pi interactive compatibility is **not tested**; the
installed pi's `--help` is authoritative for its version. Native output and
numeric exit codes pass through. The existing foreground helper forwards only
SIGINT/SIGTERM to the direct child, maps those child signal exits to 130/143 and
other signal exits to 1. It does not provide process-group control or general
signal transparency. Executable launch failure is reported as `pi_launch_failed`
(exit 4). Invalid HUD launcher options return exit 2.
