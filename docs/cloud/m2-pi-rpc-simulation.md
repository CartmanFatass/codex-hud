# M2 versioned Pi RPC observation simulation

```sh
npm ci
npm run build
npm run build:test
node --test dist-test/tests/unit/pi-rpc-observation.test.js
node scripts/demo-pi-rpc.mjs
```

Node 22 >= 22.13 or Node 24. The demo sends invented decoded event objects into
HUD's actual `src/harness/pi/rpc-observation.ts` seam. It starts no process, contacts
no provider and changes no user settings. This is not a real Pi compatibility test.

## Two pinned official contracts

- Pi v0.73.1 resolves to commit
  [781152fc24841dc54b22284514604048ebe5e2c9](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/rpc.md).
  Its RPC docs describe `agent_end`, retry events and `compaction_*`, but no
  `agent_settled`. The observer reports `run_ended`; it never invents quiescence.
- Newer source commit
  [9b9cb30ae16e5802ba556b282b38fc41117ee5e1](https://github.com/earendil-works/pi/blob/9b9cb30ae16e5802ba556b282b38fc41117ee5e1/packages/coding-agent/docs/json.md)
  distinguishes low-level `agent_end` from session-level `agent_settled`, after
  automatic retry, overflow/compaction recovery and queued work. `aborted` is kept
  distinct. This is a source pin, not a released version number.
  Its [RPC docs](https://github.com/earendil-works/pi/blob/9b9cb30ae16e5802ba556b282b38fc41117ee5e1/packages/coding-agent/docs/rpc.md)
  say prompt response `data.disposition: handled` starts no run: do not wait for
  `agent_settled` for that prompt in that case. The observer requires matching
  prompt command/id. Handled/no-run describes only that prompt and leaves session
  quiescence unknown; only `agent_settled` can report session quiescence.

The constructor accepts an explicit verified source commit; it does not autodetect
versions from events. Every other value uses the unknown profile. Unknown versions
may show low-level activity but cannot claim settled, even if they emit that name.

## Behavior and integration seam

The owner of one isolated prompt/event stream calls `observe(decodedRecord, nowMs)`
and `tick(nowMs)` during idle periods, using a monotonic clock. Default observation
window is 30 seconds, configurable up to 5 minutes, with a 2,000-record ceiling.
These are observation limits, not provider execution deadlines or performance SLOs.
There is no internal timer: the demo advances a synthetic clock; a future stream
owner must schedule idle ticks. `close()` records transport closure. Stopping
observation does not abort, kill or retry Pi. Late events cannot reopen the observer.

Legacy clients can expose `run_ended` promptly while retaining unknown quiescence;
they are not made to await an unsupported event forever. Modern `agent_settled`
reports quiescence only, never task success. Retry/compaction activity clears quiet
state. Both aborted and handled/no-run outcomes remain distinct. Unrelated command
responses do not resolve the observed prompt. Agent, retry and compaction start
events clear prior quiescence. Turn/message/tool detail events are not interpreted
by this seam.

Only bounded counters, booleans and enumerated state are retained. Message bodies,
errors, command arguments and tool results are not copied/exported. Unknown and
malformed records are counted. The seam does not validate every native event payload,
parse JSONL bytes, prove event provenance or authorize managed HUD actions.

The stream owner must frame/limit input bytes, serialize prompt ownership, correlate
commands and supply transport/clock facts. A shared session's events cannot safely
be attributed to concurrent prompts solely from their event type. This module does
not send prompts, enable RPC, grant MCP identity, wire the panel or alter Pi launch.

## Validation and scope

Synthetic tests cover old/new/unknown profiles, agent_end followed by retry and
compaction, final settled/aborted, handled-response correlation, failed command,
transport close, malformed/unknown records, idle deadline, event ceiling and detached
snapshots. The demo runs the same actual HUD module for all three version profiles.
No live account is required. This is an integration seam and simulation slice, not
complete M2, native RPC launch or real-client verification. Existing Codex/Claude
work is unchanged; base is integration ba0934c707f2621b08e2442fd4c59c08f930544e.
