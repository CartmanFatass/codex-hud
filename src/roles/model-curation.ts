/**
 * Which of pi's models the Control plane's picker offers by default. pi lists ~170 `provider/model` ids; the owner uses a
 * few lines of them, so the default view is, per provider in the include list, the models its patterns name, and of those
 * only the newest of each family. Pure: the discovered list and the catalog's `pi.include` come in, groups come out.
 */
/** Provider -> `*`/`?` patterns on the model name after `provider/`; `catalog.pi.include` in the shipped catalog or the owner's `harnesses.json`. */
export type ModelInclude = Record<string, string[]>;
export interface ModelGroup {
  provider: string;
  /** Full `provider/model` ids, in the discovered order. */
  models: string[];
}

const providerOf = (id: string) => (id.includes('/') ? id.slice(0, id.indexOf('/')) : '');
const nameOf = (id: string) => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);
const globRe = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/**
 * A model name split into its family (the words), its version (`gpt-6.1-sol` is 6.1, `claude-opus-4-5` is 4.5, `deepseek-v4-1-flash`
 * is 4.1) and its date stamp (`-20251101`, `-2025-11-01`, or a bare `-1017`); the family is the name with those removed.
 */
export function modelParts(name: string): { family: string; version: number[]; date: string } {
  let date = '';
  const rest = name.toLowerCase().replace(/(?:^|-)(\d{4})-(\d{2})-(\d{2})(?=-|$)/, (_m, y: string, m: string, d: string) => {
    date = y + m + d;
    return '';
  });
  const family: string[] = [], version: number[] = [];
  for (const word of rest.split('-').filter(Boolean)) {
    if (/^\d{4,}$/.test(word)) date ||= word;
    else if (/^v?\d+(?:\.\d+)*$/.test(word)) version.push(...word.replace(/^v/, '').split('.').map(Number));
    else {
      // A version glued to the name (`o1`, `qwen3`, `llama3.1`): the name is the family.
      const glued = /^([a-z]+)(\d+(?:\.\d+)*)$/.exec(word);
      family.push(glued ? glued[1]! : word);
      if (glued) version.push(...glued[2]!.split('.').map(Number));
    }
  }
  return { family: family.join('-'), version, date };
}
const byVersion = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};
type Parts = ReturnType<typeof modelParts>;
/** Is `a` a newer model of its family than `b`? The higher version; at one version an undated id beats a dated snapshot; then the later date. */
const newer = (a: Parts, b: Parts) => {
  const v = byVersion(a.version, b.version);
  if (v) return v > 0;
  return !a.date !== !b.date ? !a.date : Number(a.date) > Number(b.date);
};
/** The newest of each family, in the order given. */
function newestPerFamily(ids: string[]): string[] {
  const best = new Map<string, Parts & { id: string }>();
  for (const id of ids) {
    const parts = modelParts(nameOf(id)), held = best.get(parts.family);
    if (!held || newer(parts, held)) best.set(parts.family, { ...parts, id });
  }
  const kept = new Set([...best.values()].map((b) => b.id));
  return ids.filter((id) => kept.has(id));
}

/**
 * The picker's providers with their models. Default: the providers of `include` (in its order), each reduced to what its
 * patterns name and then to the newest of each family; `all` lists every provider (A-Z) with every model. A model in
 * `keep` (a role's current one) is always there, even when the curation would hide it.
 */
export function curateModels(ids: readonly string[], include: ModelInclude, keep: readonly string[] = [], all = false): ModelGroup[] {
  const by = new Map<string, string[]>();
  for (const id of ids) by.set(providerOf(id), [...(by.get(providerOf(id)) ?? []), id]);
  for (const id of keep) if (!by.get(providerOf(id))?.includes(id)) by.set(providerOf(id), [...(by.get(providerOf(id)) ?? []), id]);
  const providers = all ? [...by.keys()].sort() : [...new Set([...Object.keys(include), ...keep.map(providerOf)])];
  return providers.flatMap((provider) => {
    const names = by.get(provider) ?? [], patterns = (include[provider] ?? []).map(globRe);
    const shown = all ? names : newestPerFamily(names.filter((id) => patterns.some((re) => re.test(nameOf(id)))));
    const models = names.filter((id) => shown.includes(id) || keep.includes(id));
    return models.length ? [{ provider, models }] : [];
  });
}
