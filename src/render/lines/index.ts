/**
 * Line renderers.
 *
 * These belong to the older multi-line HUD. The current status bar is built
 * from `../layout/bar-modules.ts` instead, and takes only `formatTokenCount`
 * from here. Anything else in this directory is kept for the expanded and
 * overview layouts and is not on the single-line path.
 */

export { renderIdentityLine } from './identity-line.js';
export { renderProjectLine } from './project-line.js';
export { renderEnvironmentLine, renderEnvironmentCompact } from './environment-line.js';
export { renderUsageLine } from './usage-line.js';
export { renderSessionLine } from './session-line.js';
export { 
  renderToolsLine, 
  renderTodosLine, 
  renderTokenLine,
  renderQuotaLine,
  renderSessionDetailLine,
  collectActivityLines,
  formatTokenCount,
} from './activity-line.js';
