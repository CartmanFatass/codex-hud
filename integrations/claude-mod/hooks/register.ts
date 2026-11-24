// The HUD mod for a Claude Code main session: slims what HUD adds to the conversation.
import type { Register } from 'claude-code';
import { registerAdvisor } from './advisor';
import { registerBand } from './band';
import { registerCommands } from './commands';
import { newTurn } from './compact';
import { registerWake } from './wake';

export const register: Register = (on) => {
  // Lines already delivered this turn, over every channel (Monitor rows and MCP `changes`).
  const turn = newTurn();
  registerWake(on, turn);
  registerAdvisor(on);
  registerBand(on);
  registerCommands(on);
};
