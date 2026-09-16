/** Parent linkage appears in either top-level metadata or thread_spawn. */
export function sessionParentId(meta: { parent_thread_id?: string; source?: unknown }): string | undefined {
  if (meta.parent_thread_id) return meta.parent_thread_id;
  if (!meta.source || typeof meta.source !== 'object') return undefined;
  const source = meta.source as { subagent?: { thread_spawn?: { parent_thread_id?: unknown } } };
  const id = source.subagent?.thread_spawn?.parent_thread_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
