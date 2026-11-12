/** Shared read-only Git policy: owner configuration is trusted, repository commands are not. */
export function safeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const locations = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']);
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_') || locations.has(key))),
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
  };
}
export const SAFE_GIT_ARGS = [
  '--no-pager', '--no-optional-locks',
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'protocol.allow=never', '-c', 'core.untrackedCache=false',
];
export const FILTER_CONFIG_ARGS = ['config', '--show-scope', '-z', '--get-regexp', '^filter\\.'];

/** Git's scoped NUL output is scope\0key\nvalue\0. Never execute a partially discovered policy. */
export function filterOverrides(text: string): string[] {
  const records = text.split('\0'), names = new Set<string>();
  if (records.pop() !== '' || records.length % 2) throw new Error('Unsafe filter configuration');
  for (let i = 0; i < records.length; i += 2) {
    if (records[i] === 'global' || records[i] === 'system') continue;
    const key = records[i + 1].split('\n', 1)[0];
    const match = /^filter\.([\w.-]+)\.[^.]+$/.exec(key);
    if (!match) throw new Error('Unsafe filter configuration');
    names.add(match[1]);
  }
  return [...names].flatMap((name) => [
    '-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`,
    '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`,
  ]);
}

export async function neutralizeFilters(run: (cwd: string, args: string[]) => Promise<string>, cwd: string): Promise<string[]> {
  let text: string;
  try { text = await run(cwd, FILTER_CONFIG_ARGS); }
  catch (error) {
    if ((error as { code?: number }).code === 1) return [];
    throw error;
  }
  return filterOverrides(text);
}
