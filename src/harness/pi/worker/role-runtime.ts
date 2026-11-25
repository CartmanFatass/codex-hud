import { readFileSync } from 'node:fs';
import { sonicProtocolTools, type SonicContract } from './contract.js';
import type { WorkerPi } from './host.js';

const sonicTools = /^(read|bash|edit|write|grep|find|ls|deepseek_search|deepseek_fetch|mcp|ast_grep_.*|lens_.*|lsp_navigation|module_report|project_report|project_scan|read_enclosing|read_symbol|symbol_search|pi_lens_activate_tools)$/;
const disallowed = /^(hud_sonic|hud_ask|ask_orchestrator|ask_user_question|ask_user|question|questionnaire|askuserquestion|call_reviewer|call_sonic|rate_helper)$/i;
function fail(reason: string): never { console.error(`[hud-worker] ${reason}`); process.exit(2); }

export function roleRuntime(pi: WorkerPi, contract: SonicContract, fatal = fail) {
  const instructions = readFileSync(new URL(`../../../../packages/hud-mcp/instructions/${contract.instructions}.md`, import.meta.url), 'utf8').trim();
  pi.on('session_start', (_event, ctx) => {
    const model = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
    const observed = contract.model.includes('/') ? model : ctx.model?.id;
    if (contract.model !== observed) fatal(`Requested model ${contract.model}, active model ${model}`);
    if (contract.thinking !== pi.getThinkingLevel()) fatal(`Requested thinking ${contract.thinking}, active level ${pi.getThinkingLevel()}`);
    const all = pi.getAllTools().map(tool => tool.name);
    const ordinary = contract.explicitTools ? pi.getActiveTools() : all.filter(name => sonicTools.test(name));
    pi.setActiveTools([...new Set([...ordinary, ...sonicProtocolTools])].filter(name => !disallowed.test(name)));
    if (!sonicProtocolTools.every(name => pi.getActiveTools().includes(name))) fatal('Missing required Sonic protocol tools');
  });
  pi.on('before_agent_start', ({ systemPromptOptions }) => {
    systemPromptOptions.sections.role = instructions;
    systemPromptOptions.skills = systemPromptOptions.skills.filter(skill => skill.name !== 'helper-pane');
  });
}
