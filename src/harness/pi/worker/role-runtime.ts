import { readFileSync } from 'node:fs';
import { selectionAdvisorInstructions } from '../../../roles/selection-advisor-prompt.js';
import { sessionProtocolTools, sonicProtocolTools, type WorkerContract } from './contract.js';
import type { WorkerPi } from './host.js';

const workerTools = /^(read|bash|edit|write|grep|find|ls|deepseek_search|deepseek_fetch|mcp|ast_grep_.*|lens_.*|lsp_navigation|module_report|project_report|project_scan|read_enclosing|read_symbol|symbol_search|pi_lens_activate_tools)$/;
const readOnlyTools = /^(read|bash|write|grep|find|ls|deepseek_search|deepseek_fetch|mcp|ast_grep_search|ast_grep_outline|lens_diagnostics|lsp_navigation|module_report|project_report|read_enclosing|read_symbol|symbol_search)$/;
const disallowed = /^(ask_orchestrator|ask_user_question|ask_user|question|questionnaire|askuserquestion|call_reviewer|call_sonic|rate_helper)$/i;
function fail(reason: string): never { console.error(`[hud-worker] ${reason}`); process.exit(2); }

export function roleRuntime(pi: WorkerPi, contract: WorkerContract, fatal = fail, advisor = false) {
  const sonic = contract.role === 'sonic', protocol = advisor ? ['hud_report'] : sonic ? sonicProtocolTools : sessionProtocolTools;
  const instructions = readFileSync(new URL(`../../../../packages/hud-mcp/instructions/${contract.instructions}.md`, import.meta.url), 'utf8').trim();
  pi.on('session_start', (_event, ctx) => {
    const resumeId = process.env.HUD_RESUME_SESSION_ID;
    if (resumeId && (!contract.session || ctx.sessionManager.getSessionId() !== resumeId || ctx.sessionManager.getSessionFile() !== contract.session))
      fatal('Pi did not open the recorded session');
    const model = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
    const observed = contract.model?.includes('/') ? model : ctx.model?.id;
    if (contract.model && contract.model !== observed) fatal(`Requested model ${contract.model}, active model ${model}`);
    if (contract.thinking && contract.thinking !== pi.getThinkingLevel()) fatal(`Requested thinking ${contract.thinking}, active level ${pi.getThinkingLevel()}`);
    const all = pi.getAllTools().map(tool => tool.name);
    const tools = contract.guard ? readOnlyTools : workerTools;
    const ordinary = advisor ? [] : contract.explicitTools ? pi.getActiveTools() : all.filter(name => tools.test(name));
    pi.setActiveTools([...new Set([...ordinary, ...protocol])].filter(name =>
      !disallowed.test(name) && !(sonic && (name === 'hud_sonic' || name === 'hud_ask'))));
    if (!protocol.every(name => pi.getActiveTools().includes(name))) fatal('Missing required HUD worker protocol tools');
    if (ctx.mode === 'tui' && ctx.ui?.setStatus) {
      ctx.ui.setStatus('role', ctx.ui.theme.fg('accent', `role:${contract.role}${contract.guard ? ' (read-only)' : ''}`));
    }
  });
  pi.on('before_agent_start', ({ systemPromptOptions }) => {
    // Pi projects a returned systemPrompt over all system messages in the provider
    // request, including previously recorded messages on a native resume.
    if (advisor) return { systemPrompt: selectionAdvisorInstructions };
    if (!systemPromptOptions) return;
    systemPromptOptions.sections.role = instructions;
    systemPromptOptions.skills = systemPromptOptions.skills.filter(skill => skill.name !== 'helper-pane');
  });
}
