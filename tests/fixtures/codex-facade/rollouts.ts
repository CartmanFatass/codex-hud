/** Synthetic Codex records, including the direct-stdio hud-mcp tool name. */
export const ROOT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const CHILD = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const GRANDCHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
export const FORK = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
export const TIME = Date.parse('2026-03-01T12:00:00Z');
export function row(type: string, payload: object, offset = 0): string {
  return JSON.stringify({ timestamp: new Date(TIME + offset).toISOString(), type, payload });
}
export function meta(id = ROOT, parent?: string): string {
  return row('session_meta', {
    id,
    cwd: '/synthetic/project',
    timestamp: new Date(TIME).toISOString(),
    cli_version: '0.synthetic',
    model_provider: 'openai',
    ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}),
  });
}
export function call(id = 'spawn-call', name = 'mcp__hud__delegate_spawn'): string {
  return row(
    'response_item',
    { type: 'function_call', call_id: id, name, arguments: '{"request_key":"synthetic"}' },
    1000
  );
}
export function output(id = 'spawn-call', run = 'run-synthetic'): string {
  return row(
    'response_item',
    {
      type: 'function_call_output',
      call_id: id,
      id: `message-${id}`,
      output: JSON.stringify({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              linkId: 'link-synthetic',
              runId: run,
              launchCorrelationId: 'launch-synthetic',
              claim: 'DO_NOT_RETAIN',
            }),
          },
        ],
      }),
    },
    2000
  );
}
export const initial = [
  meta(),
  row('turn_context', { model: 'gpt-synthetic', effort: 'high' }),
  row('event_msg', { type: 'task_started' }, 500),
  call(),
  output(),
  row(
    'event_msg',
    {
      type: 'plan_update',
      plan: [
        { step: 'Review synthetic fixture', status: 'completed' },
        { step: 'Run checks', status: 'in_progress' },
      ],
    },
    3000
  ),
  row(
    'event_msg',
    {
      type: 'token_count',
      info: {
        model_context_window: 100000,
        total_token_usage: { input_tokens: 25000, output_tokens: 1000, cached_input_tokens: 5000 },
        last_token_usage: { total_tokens: 30000 },
      },
      rate_limits: { primary: { used_percent: 25, window_minutes: 300, resets_at: 1772370000 } },
    },
    4000
  ),
  row(
    'response_item',
    {
      type: 'message',
      role: 'assistant',
      channel: 'commentary',
      content: [{ type: 'output_text', text: 'Synthetic progress 中文' }],
    },
    5000
  ),
  row(
    'response_item',
    {
      type: 'message',
      role: 'assistant',
      channel: 'analysis',
      content: [{ type: 'output_text', text: 'PRIVATE_SENTINEL' }],
    },
    6000
  ),
  row('event_msg', { type: 'task_complete' }, 7000),
];
export const resumed = [
  row('event_msg', { type: 'task_started' }, 10000),
  call('resume-call', 'mcp__hud__delegate_resume'),
  output('resume-call', 'run-resumed'),
  row('event_msg', { type: 'context_compacted' }, 11000),
  row(
    'event_msg',
    {
      type: 'token_count',
      info: {
        model_context_window: 100000,
        total_token_usage: { input_tokens: 27000, output_tokens: 1100 },
        last_token_usage: { total_tokens: 16000 },
      },
    },
    12000
  ),
];
