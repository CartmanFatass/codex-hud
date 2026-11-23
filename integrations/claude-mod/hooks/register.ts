// The HUD mod for a Claude Code main session: slims what HUD adds to the conversation.
// It never changes what HUD's MCP server returns to other clients, only how this session stores it.
import type { Register } from 'claude-code';
import { compactResult, mergeNotice, newTurn, reportRead } from './compact';

export const register: Register = (on) => {
  // Lines already delivered this turn, over every channel (Monitor rows and MCP `changes`).
  let turn = newTurn();

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) turn = newTurn();
    return next(e);
  });

  // (1) HUD tool results: compact text for the model; the server's own reply is untouched.
  on('tool.call', { tool: /^mcp__(?:\w*_)?hud__hud_/ }, async ($, e, next) => {
    const ran = await next(e);
    if (ran.deny !== undefined || ran.isError || ran.text === undefined) return ran;
    const text = compactResult(ran.text, e.agentId === undefined ? turn : newTurn());
    return text === undefined ? ran : { result: text };
  });

  // (2) Job notices: repeated HUD lines in a Monitor row shrink to what is new. Other rows pass untouched.
  on('session.append', { origin: { kind: 'task-notification' } }, ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    const content = e.message.content.map((block) => {
      const text = block.type === 'text' && typeof block.text === 'string' ? mergeNotice(block.text, turn) : undefined;
      return text === undefined ? block : { ...block, text };
    });
    return next(content.some((block, i) => block !== e.message.content[i]) ? { ...e, message: { ...e.message, content } } : e);
  });

  // (3) Reports are read through hud_read, not from the file. A worker (HUD_JOB_DIR set) has no hud_read: it may read.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const hint = reportRead(e.file_path);
    return hint && !(await $.env.get('HUD_JOB_DIR')) ? { deny: hint } : next(e);
  });
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const hint = reportRead(e.command, true);
    return hint && !(await $.env.get('HUD_JOB_DIR')) ? { deny: hint } : next(e);
  });
};
