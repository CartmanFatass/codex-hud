/** Native defaults formerly supplied by pi-role frontmatter. Only Sonic is migrated so far. */
export const piRoleDefaults = {
  sonic: { model: 'mistral/deepseek-v4-1-flash-1017', thinking: 'high' },
  implementer: { model: 'openai/gpt-6.2-sol', thinking: 'high' },
  reviewer: { model: 'openai/gpt-6.2-sol', thinking: 'xhigh' },
  architect: { model: 'openai/gpt-6.2-astra', thinking: 'high' },
  general: {},
} as const;
