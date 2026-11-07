---
name: hud-delegate
description: Use hud-mcp's managed_* tools to create, read, resume and communicate with owned native Codex, Claude or Pi sessions. Covers native events and requests, live cursors, explicit interruption/close, and the existing Claude background waiter, Codex queue and Pi extension notification paths. Also identifies the thin Jev tools. Use only when the user's task scope and confirmation rules permit the requested work.
---

# Native sessions through hud-mcp

HUD connects the calling native session to official harness APIs. The caller decides what to ask, how to answer
native requests and whether the work meets the user's goal. HUD does not decide task success or automatically
approve, retry, interrupt or close native work.

The default MCP entry advertises `managed_*` and `jev_*`. Use the server's `tools/list` schemas. Tool names may be
prefixed by the MCP server name in your harness. Historical delegation tools and their ledger workflow are not the
current entry's API.

## 1. Profile and source

- Native backend profiles are `id` entries in `<HUD_HOME>/native.json`. If that file is absent, the defaults are
  `codex`, `claude` and `pi`, using the user's installed executables. The file can configure executable, args,
  environment and explicit native options. Do not silently change permission settings.
- `<HUD_HOME>/delegate.json` is retained for trusted caller-source registration and ordinary launcher configuration;
  its profile names are not automatically backend profile IDs in `native.json`.
- HUD authenticates the native caller on every tool invocation. Do not pass an owner, caller identity or invented
  MCP call ID. Missing source identity is an error to resolve, not a reason to share another parent's connection.
- Supply the task's absolute workspace. Native references, profile IDs and source files returned by HUD identify
  existing owned sessions; they are not interchangeable paths into another session.

## 2. Create, then send once

```json
{
  "tool": "managed_create",
  "arguments": {
    "profileId": "codex",
    "workspace": "/absolute/project",
    "origin": { "kind": "new" }
  }
}
```

Creation does not send a prompt. A successful transport response is `{ok:true,value:...}`. Save
`value.connectionId`, `value.nativeRef` when available, and `value.throughSeq`. An SDK may not supply its native ID
until it receives input; use the returned `connectionId` in the meantime.

```json
{
  "tool": "managed_send",
  "arguments": {
    "connectionId": "<returned connection ID>",
    "text": "Implement the requested change in this workspace and report the commands and results you checked."
  }
}
```

Keep a pre-send observation cursor so a fast result is not skipped. Send returns the official receipt and
correlation when available, not a verdict on the task. `managed_ask` is a convenience that sends once and waits:
its `value` contains `receipt` and `observation`. Its optional `waitMs` is 0–120000; expiration ends only the wait.

A lost response is not permission to repeat input. HUD has no durable request-key replay guarantee. First inspect
`managed_list`, `managed_requests`, native state/history and the available correlation. Decide whether another
input is appropriate only after checking what the provider actually received.

Input options select explicit native behavior, not HUD's guess:

- Codex: ordinary send starts a turn. To steer, use
  `options:{"mode":"steer","expectedTurnId":"<observed native turn ID>"}`.
- Pi: use the public prompt/steer/follow-up options; for example
  `options:{"streamingBehavior":"followUp"}` on a prompt. Do not infer completion from `agent_end`;
  `agent_settled` is the corresponding settled observation.
- Claude: ordinary sends enter the public SDK input stream. Only documented adapter options are supported.

## 3. Read observations and native history

- `managed_list{}` returns this parent's connection observations and persisted direct relationships. A relationship
  is not proof that the old process remains alive.
- `managed_status{connectionId}` reads the connection observation and official native state.
- `managed_read{connectionId,options?}` reads the backend's public state/history. Examples are Codex's default
  thread read, Pi `options:{"method":"get_entries"}`, and Claude
  `options:{"method":"getSessionMessages","offset":0,"limit":20}`. Native payloads and errors retain their
  own semantics. An outer `ok:true` is not task success and does not override a native error payload.
- `managed_wait{connectionId,afterSeq,waitMs}` reads bounded live events and pending requests without resending.
  Omitting both target fields observes all children of the authenticated native owner.
- A target can instead be the exact returned `nativeRef`. Prefer `connectionId` for pending callbacks or when
  multiple historical connections refer to one native session.

A wait page has `events`, `requests`, `throughSeq` and `truncated`. Inspect the page before retaining `throughSeq`
as your next `afterSeq`. Keep separate cursors for different connection filters; advancing an owner-wide cursor
from a filtered page can skip another child's events. If `truncated:true`, the live buffer omitted data, possibly
an oversized event. Read official history rather than assuming the missing output says nothing.

These cursors belong to the live host, not durable native history. After a host restart, use the resumed connection's
new cursor and official history. A native-history cursor such as Pi's entry ID is separate from HUD's `afterSeq`.
A returned observation may be a request, an output, an actual disconnection or a process exit. Do not convert
silence, a wait deadline or a disconnected pipe into an invented task result.

## 4. Handle native requests, including during startup

`managed_requests{}` lists live native callbacks. A request can arrive while `managed_create` or native resume is
still waiting for its adapter to initialize. Another MCP call can list/wait for that request and respond using its
`connectionId` and `requestId`; it need not wait for the original create reply.

Read `kind` and the original `payload`. The caller and its harness apply their own confirmation and permission
rules. Reply through:

```json
{
  "tool": "managed_respond",
  "arguments": {
    "connectionId": "<request's connection ID>",
    "requestId": "<exact returned request ID>",
    "result": { "<native response field>": "<native response value>" }
  }
}
```

The placeholder object is not a generic approval format: use that backend request's documented response shape.
HUD forwards the JSON unchanged. `forwarded:true,nativeAcknowledged:false` records callback routing, not proof the
provider accepted a decision. If the native request was withdrawn or its native timeout elapsed, reread current
requests; do not fabricate a replacement allow/deny or repeatedly answer an expired ID.

## 5. Existing native notification paths

The default main adds a `wake` transport observation to tool responses. This is not a delivery/read guarantee;
`modelReadAcknowledged:false` is explicit. `none` or `unavailable` means you must not rely on that channel. Even a
queue helper's accepted exit does not establish that the model has read the message. Use a bounded `managed_wait`
when you need the result in the current turn.

- **Claude:** tool responses include `backgroundWaiter.argv`, an argument vector, plus instructions. Ordinary MCP
  replies do not wake Claude. Start this command with Claude's real native background-task facility, such as
  `run_in_background`; normal foreground execution is not an equivalent notification mechanism. Safely quote each
  argv element if the tool accepts a shell command rather than an argument vector.
- A create response's waiter argv includes that connection and its pre-input cursor. Keep this vector before
  sending. The underlying command is `hud run wait --native-owner '<returned owner JSON>' --connection '<ID>'
  --after-seq <cursor> --notify`. Use the returned owner JSON, not an identity guessed from cwd or configuration.
- For subsequent waiters reuse the last page you actually inspected. `--json` can replace `--notify` when you need
  the waiter's structured page and `throughSeq`. Do not pass both. `--timeout-ms` bounds only the waiter. A normal
  background command exit produces the harness notification; a deadline does not mean the child finished.
- **Codex:** the trusted registration selects the actual parent's executable, native thread and CODEX_HOME for
  the existing `codex queue` path. A native result/request can notify that parent. Do not assume a closed or
  unloaded parent has consumed it; use the reported transport fact and read the child when the parent returns.
- **Pi:** explicitly load the packaged wake entrypoint in the target parent session with
  `pi -e /path/to/runtime/integrations/pi/hud-wake.ts` (alongside your `hud-delegate` extension).
  The entrypoint loads `dist/harness/pi/wake-extension.js` from that same build; a source checkout must be built first.
  `hud-delegate` does not auto-register wake, so load the wake entrypoint only once. Its native
  `sendMessage` follow-up can trigger the parent turn. A closed parent has no live extension to receive it.

There is no `advice.wake.armCommand`, notification retry ledger or model-read acknowledgment in this path. Wake
messages tell you which native session/request to read; they do not instruct you to accept an approval or declare
the user's task complete.

## 6. Resume, interrupt and close explicitly

To reconnect an owned native session, use `managed_create` with the original `profileId`, original `workspace`, and
`origin:{"kind":"resume","source":<returned nativeRef>}`. HUD reuses a still-live matching connection; after an
observed transport end it invokes the official resume API. After host restart the same direct relation permits
native-history recovery. This does not resurrect the old OS process, tools or callbacks.

Use `origin.kind:"fork"` only when explicitly requesting a new native session from that owned source. The source
profile and locator remain the recorded ones. Pi's `sessionFile` must not be substituted; omitting it lets HUD use
the recorded official file. A different file, profile or source workspace is rejected before native dispatch.

- `managed_cancel{connectionId,nativeTurnId?}` invokes only the public native interrupt. Codex requires the actual
  native turn ID. An interrupt receipt is not proof every background tool has exited.
- `managed_close{connectionId}` explicitly calls the backend's public close operation. Its receipt describes only
  what that API reported. It does not delete native history or silently kill a process tree.
- Parent exit, MCP EOF, waiter expiration and HUD panel closure do not close these child connections. There is no
  automatic retirement or report requirement. The caller decides whether to continue or close after reviewing the
  native results and the user's instructions.

## 7. Existing Jev Agent wrapper

The same authenticated source can call `jev_create{url,goals,...}` and retain its returned `instanceId` and actual
owned browser target. `jev_run{instanceId}` invokes the installed Agent's run generator and returns native
snapshots. `jev_snapshot`, `jev_command`, `jev_list` and explicit `jev_close` wrap the existing Agent API; they do
not define a second browser policy or task engine. A blocked/CAPTCHA page, native error, lost observer or timeout
never implicitly calls close. Keep the page for the user's authorized verification/handoff rather than replacing
it or retrying the agent blindly. Historical Jev relations alone do not restore a dead Agent instance.
