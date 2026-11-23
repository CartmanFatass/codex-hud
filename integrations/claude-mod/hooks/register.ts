// The HUD mod for a Claude Code main session: slims what HUD adds to the conversation.
import type { Register } from 'claude-code';
import { registerBand } from './band';
import { registerCommands } from './commands';
import { mergeNotice, newTurn, reportRead } from './compact';
import { registerWake } from './wake';

export const register: Register = (on) => {
  // Lines already delivered this turn, over every channel (Monitor rows and MCP `changes`).
  const turn = newTurn();
  registerWake(on, turn);
  registerBand(on);
  registerCommands(on);

  // Fallback job notices: repeated HUD lines in a Monitor row shrink to what is new. Other rows pass untouched.
  on('session.append', { origin: { kind: 'task-notification' } }, ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    const content = e.message.content.map((block) => {
      const text = block.type === 'text' && typeof block.text === 'string' ? mergeNotice(block.text, turn) : undefined;
      return text === undefined ? block : { ...block, text };
    });
    return next(content.some((block, i) => block !== e.message.content[i]) ? { ...e, message: { ...e.message, content } } : e);
  });

  // Reports are read through hud_read, not from the file. A worker (HUD_JOB_DIR set) has no hud_read: it may read.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const hint = reportRead(e.file_path);
    return hint && !(await $.env.get('HUD_JOB_DIR')) ? { deny: hint } : next(e);
  });
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const hint = reportRead(e.command, true);
    return hint && !(await $.env.get('HUD_JOB_DIR')) ? { deny: hint } : next(e);
  });
};
