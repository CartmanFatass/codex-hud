/** Synthetic app-server boundary, shaped against openai/codex@d786ff91fad8e7ddab8653ee07bc6313a6fcb03d. */
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'normal';
const log = process.argv[3];
const send = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const note = (method, params) => send({ method, params });
const result = (id, result) => send({ id, result });
const turn = (id, status = 'inProgress', items = []) => ({
  id,
  rootTurnId: id,
  items,
  itemsView: 'full',
  status,
  error: null,
  startedAt: 1,
  completedAt: status === 'inProgress' ? null : 2,
  durationMs: null,
});
const item = (id, text) => ({
  type: 'agentMessage',
  id,
  text,
  phase: 'final_answer',
  memoryCitation: null,
  delivery: null,
  questions: null,
});
let ready = false,
  threadId = 'thread-owned',
  count = 0,
  currentTurn = null,
  approvalCount = 0;
const completed = (status = 'completed', id = currentTurn, text = `answer-${count}`) =>
  note('turn/completed', { threadId, turn: turn(id, status, [item(`item-${count}`, text)]) });
const approval = (id, turnId = currentTurn, method = 'item/commandExecution/requestApproval', extra = {}) =>
  send({
    id,
    method,
    params: {
      threadId,
      turnId,
      itemId: 'same-item',
      startedAtMs: 1000,
      approvalId: `callback-${id}`,
      kind: 'command',
      environmentId: null,
      command: 'printf synthetic',
      cwd: process.cwd(),
      reason: null,
      networkApprovalContext: { host: 'synthetic.invalid', protocol: 'https' },
      ...extra,
    },
  });
const lines = readline.createInterface({ input: process.stdin });
if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {
    if (log) appendFileSync(log, JSON.stringify({ signal: 'SIGTERM' }) + '\n');
  });
  // Fixture-owned bound keeps a non-cooperative process alive beyond the client's release deadline.
  setTimeout(() => process.exit(0), 900);
}
lines.on('line', (line) => {
  const m = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(m) + '\n');
  if ('result' in m) {
    if (['session-request', 'connection-request'].includes(mode)) return;
    if (++approvalCount === (mode === 'approvals' ? 2 : 1)) completed();
    return;
  }
  if (m.method === 'initialize') {
    const data =
      JSON.stringify({
        id: m.id,
        result: { userAgent: mode === 'future-version' ? 'synthetic-codex/999.0.0' : 'synthetic-codex/0' },
      }) + '\n';
    process.stdout.write(data.slice(0, 9));
    setTimeout(() => process.stdout.write(data.slice(9)), 2);
    return;
  }
  if (m.method === 'initialized') {
    ready = true;
    return;
  }
  if (!ready) process.exit(3);
  if (m.method === 'thread/loaded/list') {
    result(m.id, { data: [threadId], nextCursor: null });
    return;
  }
  if (m.method === 'thread/read') {
    result(m.id, {
      thread: {
        id: threadId,
        status: { type: mode === 'busy-resume' ? 'active' : 'idle' },
        turns: [turn('historical-turn', 'completed', [item('history-item', 'stored native answer')])],
        future: true,
      },
    });
    return;
  }
  if (m.method === 'turn/steer') {
    result(m.id, { turnId: m.params.expectedTurnId });
    return;
  }
  if (m.method.startsWith('thread/')) {
    if (m.method === 'thread/resume') threadId = mode === 'resume-mismatch' ? 'wrong-thread' : m.params.threadId;
    if (m.method === 'thread/fork') threadId = mode === 'fork-mismatch' ? m.params.threadId : 'thread-forked';
    const thread = {
      id: threadId,
      ...(mode === 'no-session-id' ? {} : { sessionId: 'session-distinct' }),
      forkedFromId: m.method === 'thread/fork' ? m.params.threadId : null,
      status: { type: mode === 'busy-resume' ? 'active' : 'idle' },
      turns: [],
    };
    note('thread/started', { thread });
    if (mode === 'pre-binding-active') note('turn/started', { threadId, turn: turn('unowned-turn') });
    if (mode === 'unowned-turn') setTimeout(() => note('turn/started', { threadId, turn: turn('unowned-turn') }), 20);
    if (mode === 'unowned-active')
      setTimeout(() => note('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } }), 20);
    result(m.id, {
      thread,
      cwd: mode === 'workspace-mismatch' ? '/synthetic-wrong-workspace' : m.params.cwd,
      approvalPolicy: mode === 'native-effective-settings' ? 'never' : (m.params.approvalPolicy ?? 'on-request'),
      approvalsReviewer: 'guardian_subagent',
      sandbox: {
        type: {
          'read-only': 'readOnly',
          'workspace-write': 'workspaceWrite',
          'danger-full-access': 'dangerFullAccess',
        }[mode === 'native-effective-settings' ? 'danger-full-access' : (m.params.sandbox ?? 'workspace-write')],
        networkAccess: false,
      },
      model: 'synthetic',
      modelProvider: 'synthetic',
      serviceTier: null,
      disabledPluginIds: [],
      instructionSources: [],
      reasoningEffort: null,
    });
    if (mode === 'session-request')
      send({
        id: 'session-question',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId,
          turnId: null,
          serverName: 'synthetic-server',
          mode: 'form',
          _meta: null,
          message: 'Synthetic question',
          requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
        },
      });
    if (mode === 'connection-request')
      send({ id: 'connection-request', method: 'future/connectionRequest', params: { nativeValue: true } });
    return;
  }
  if (m.method === 'turn/interrupt') {
    result(m.id, {});
    if (mode !== 'cancel-no-terminal')
      setTimeout(() => completed(mode === 'cancel-race' ? 'completed' : 'interrupted'), 30);
    return;
  }
  if (m.method !== 'turn/start') process.exit(4);
  if (!Array.isArray(m.params.input[0].text_elements)) process.exit(5);
  count++;
  currentTurn = `turn-${count}`;
  if (mode === 'exit-after-send') process.exit(7);
  if (mode === 'malformed') {
    process.stdout.write('{bad}\n');
    return;
  }
  if (mode === 'oversized') {
    process.stdout.write('x'.repeat(1024 * 1024 + 1));
    return;
  }
  if (mode === 'invalid-utf8') {
    process.stdout.write(Buffer.from([255, 10]));
    return;
  }
  if (mode === 'truncated') {
    process.stdout.write('{"id":');
    process.stdout.end();
    return;
  }
  if (mode === 'rpc-reject') {
    send({ id: m.id, error: { code: -32602, message: 'synthetic rejection' } });
    return;
  }
  if (mode === 'silent') return;
  if (mode === 'late-ack') {
    setTimeout(() => result(m.id, { turn: turn(currentTurn) }), 250);
    return;
  }
  if (mode === 'stderr-volume') process.stderr.write('synthetic diagnostic\n'.repeat(4000));
  if (mode === 'status-system-error')
    note('thread/status/changed', { threadId, status: { type: 'systemError', future: true } });
  if (mode === 'legacy-request' || mode === 'legacy-foreign') {
    result(m.id, { turn: turn(currentTurn) });
    send({
      id: 'legacy',
      method: 'execCommandApproval',
      params: {
        conversationId: mode === 'legacy-foreign' ? 'foreign' : threadId,
        callId: 'native-call',
        command: ['printf', 'synthetic'],
        cwd: process.cwd(),
        reason: null,
      },
    });
    return;
  }
  // Notifications can precede the turn/start response, including completion and approvals.
  note('turn/started', { threadId, turn: turn(currentTurn) });
  if (mode === 'pre-ack') completed();
  if (mode === 'pre-ack-overflow')
    for (let i = 0; i < 65; i++)
      note('item/agentMessage/delta', { threadId, turnId: currentTurn, itemId: 'item', delta: 'x' });
  if (mode === 'approvals') {
    approval(7);
    approval('7');
  }
  if (mode === 'pre-ack-resolved') {
    approval('pre-ack');
    note('serverRequest/resolved', { threadId, requestId: 'pre-ack' });
  }
  result(m.id, { turn: turn(mode === 'reused-turn' ? 'turn-1' : currentTurn) });
  if (['pre-ack', 'pre-ack-overflow', 'approvals'].includes(mode)) return;
  if (mode === 'late-approval') {
    approval('late');
    setTimeout(() => completed(), 20);
    return;
  }
  if (mode === 'waiting-request') {
    approval('waiting');
    return;
  }
  if (mode === 'approval-turn-mismatch') {
    approval('wrong', 'foreign-turn');
    return;
  }
  if (mode === 'request-thread-mismatch') {
    approval('wrong', currentTurn, 'item/commandExecution/requestApproval', { threadId: 'foreign-thread' });
    return;
  }
  if (mode === 'request-resolved') {
    approval('resolved');
    setTimeout(() => note('serverRequest/resolved', { threadId, requestId: 'resolved' }), 20);
    return;
  }
  if (mode === 'resolved-exact') {
    approval(7);
    approval('7');
    setTimeout(() => {
      note('serverRequest/resolved', { threadId: 'foreign-thread', requestId: '7' });
      note('serverRequest/resolved', { threadId, requestId: 7 });
    }, 20);
    return;
  }
  if (mode === 'request-exit') {
    approval('exiting');
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (mode === 'reused-resolved-request') {
    approval('reused');
    if (count === 1)
      setTimeout(() => {
        note('serverRequest/resolved', { threadId, requestId: 'reused' });
        completed();
      }, 20);
    return;
  }
  if (mode === 'reused-request') {
    approval('reused');
    if (count === 1) setTimeout(() => completed(), 20);
    return;
  }
  if (mode === 'duplicate-approval') {
    approval('duplicate');
    approval('duplicate');
    return;
  }
  if (mode === 'user-input') {
    send({
      id: 'question',
      method: 'item/tool/requestUserInput',
      params: {
        threadId,
        turnId: currentTurn,
        itemId: 'question-item',
        questions: [
          {
            id: 'question',
            header: 'Synthetic',
            question: 'Synthetic question',
            isOther: false,
            isSecret: false,
            options: null,
          },
        ],
        isBlocking: false,
        autoResolutionMs: null,
      },
    });
    return;
  }
  if (mode === 'permission-request') {
    send({
      id: 'permissions',
      method: 'item/permissions/requestApproval',
      params: { threadId, turnId: currentTurn, itemId: 'permission-item', permissions: { network: { enabled: true } } },
    });
    return;
  }
  if (mode === 'future-request') {
    send({ id: 'future', method: 'future/request', params: { threadId, turnId: currentTurn, native: ['unmodified'] } });
    return;
  }
  if (mode === 'file-approval') {
    approval('file', currentTurn, 'item/fileChange/requestApproval', { grantRoot: '/synthetic/project' });
    return;
  }
  if (mode === 'foreign-events') {
    note('turn/completed', {
      threadId: 'foreign-thread',
      turn: turn(currentTurn, 'completed', [item('foreign', 'wrong answer')]),
    });
    completed('completed', 'foreign-turn', 'wrong answer');
    setTimeout(() => completed(), 30);
    return;
  }
  if (['hold', 'cancel-no-terminal', 'cancel-race'].includes(mode)) {
    note('error', { threadId, turnId: currentTurn, willRetry: true, error: { message: 'synthetic retry' } });
    note('item/completed', { threadId, turnId: currentTurn, item: item(`item-${count}`, 'not a terminal result') });
    return;
  }
  if (mode === 'delayed-result') {
    setTimeout(() => completed(), 60);
    return;
  }
  if (mode === 'failed') {
    completed('failed');
    return;
  }
  if (mode === 'interrupted') {
    completed('interrupted');
    return;
  }
  if (mode === 'unknown-notification')
    note('future/newNotification', { threadId, turnId: currentTurn, value: 'ignored' });
  note('item/agentMessage/delta', { threadId, turnId: currentTurn, itemId: `item-${count}`, delta: `answer-${count}` });
  note('item/completed', { threadId, turnId: currentTurn, item: item(`item-${count}`, `answer-${count}`) });
  completed();
});
