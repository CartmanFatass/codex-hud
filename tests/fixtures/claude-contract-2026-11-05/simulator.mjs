// Synthetic documentation-derived process. Not Claude Code, not a compatibility oracle.
// Hook records are written to a test-only side channel, never to stdout or a transcript.
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const bare = args.includes('--bare');
const output = process.env.SYNTHETIC_HOOK_OUTPUT;
if (!output) throw new Error('synthetic hook output path required');
const discovery = process.env.SYNTHETIC_DISCOVERY_OUTPUT;
if (!discovery) throw new Error('synthetic discovery output path required');
writeFileSync(
  discovery,
  JSON.stringify({ projectHooks: !bare, projectMcp: !bare, explicitMcp: args.includes('--mcp-config') })
);
const session_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const common = {
  session_id,
  transcript_path: '/synthetic/project/session.jsonl',
  cwd: '/synthetic/project',
  permission_mode: 'default',
};
const hooks = bare
  ? []
  : [
      { ...common, hook_event_name: 'SessionStart', source: 'startup' },
      { ...common, hook_event_name: 'SubagentStart', agent_id: 'synthetic', agent_type: 'general-purpose' },
      {
        ...common,
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        agent_id: 'synthetic',
        agent_type: 'general-purpose',
        agent_transcript_path: '/synthetic/project/session/subagents/agent-synthetic.jsonl',
        last_assistant_message: 'Synthetic result',
        background_tasks: [],
        session_crons: [],
      },
      // A resumed agent can trigger SubagentStart again with the same identity.
      { ...common, hook_event_name: 'SubagentStart', agent_id: 'synthetic', agent_type: 'general-purpose' },
      {
        ...common,
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        agent_id: 'internal',
        agent_type: '',
        agent_transcript_path: '/synthetic/project/session/subagents/agent-internal.jsonl',
        last_assistant_message: '',
        background_tasks: [],
        session_crons: [],
      },
    ];
writeFileSync(output, hooks.map((h) => JSON.stringify(h)).join('\n') + (hooks.length ? '\n' : ''));
const stream =
  [
    { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Synthetic 中文' } } },
    { type: 'synthetic_future_event', note: 'unknown fields are not a protocol violation' },
    { type: 'result', result: 'Synthetic 中文', session_id, total_cost_usd: 0 },
  ]
    .map((x) => JSON.stringify(x))
    .join('\n') + '\n';
// Split across bytes, including inside a multibyte character: a consumer must buffer UTF-8.
const bytes = Buffer.from(stream);
const split = bytes.indexOf(Buffer.from('中')) + 1;
process.stdout.write(bytes.subarray(0, split));
setImmediate(() => process.stdout.end(bytes.subarray(split)));
