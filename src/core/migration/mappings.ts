/** Explicit, versioned allowlist of presentation settings understood by settings.ts. */
import { fail, jsonObject, LIMIT } from './private-files.js';
export const MAPPING = 'codex-display-v1';
export const SETTINGS_FILE = 'hud-settings.json';
const enumOf =
  (...values: unknown[]) =>
  (value: unknown) =>
    values.includes(value);
const boolean = (value: unknown) => typeof value === 'boolean';
const range = (low: number, high: number) => (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high;
const rules: Record<string, (value: unknown) => boolean> = {
  density: enumOf('focus', 'balanced', 'full'),
  theme: enumOf('terminal', 'mocha', 'latte', 'titanium', 'none'),
  glyphs: enumOf('glyph', 'text', 'both'),
  icons: enumOf('unicode', 'nerd', 'emoji', 'text'),
  look: enumOf('tab', 'band', 'tile', 'frame', 'pill'),
  motion: enumOf('full', 'reduced'),
  context: enumOf('used', 'remaining'),
  agentColors: enumOf('name', 'mark', 'off'),
  statusline: boolean,
  sort: enumOf('active', 'created'),
  mouse: boolean,
  tasks: boolean,
  changes: boolean,
  activity: boolean,
  details: boolean,
  refreshMs: range(100, 60_000),
  treeWidth: (v) => v === 0 || range(16, 200)(v),
  finishedLingerMs: (v) => v === 0 || range(10_000, 86_400_000)(v),
  agentsPane: enumOf('open', 'closed'),
  changesPane: enumOf('open', 'closed'),
  detailsPane: enumOf('open', 'closed'),
  timelinePane: enumOf('open', 'closed'),
  timelineStyle: enumOf('rail', 'indent', 'lanes'),
  timelineHours: enumOf(1, 3, 6, 12, 24),
  panelStyle: enumOf('rich', 'compact'),
  paneLayout: enumOf('stack', 'tabs'),
  language: enumOf('auto', 'en', 'zh'),
  statusCard: enumOf('min', 'status', 'full'),
  agentLog: boolean,
  cardCorners: enumOf('square', 'round'),
  cardRoleCounts: boolean,
  cardLabel: boolean,
  cardOriginalName: boolean,
  cardSummary: boolean,
  cardRelations: boolean,
  cardAction: boolean,
  cardSubagents: boolean,
  cardSubagentSummary: boolean,
  cardSubagentScope: enumOf('live', 'important', 'all'),
  cardModel: boolean,
  cardReviews: boolean,
  cardClock: boolean,
  cardRate: boolean,
  cardContext: boolean,
};
export interface SettingChange {
  key: string;
  before: unknown;
  after: unknown;
}
export function transform(
  source: Buffer,
  current: Buffer | null
): { bytes: Buffer; changes: SettingChange[]; excludedKeys: number } {
  const input = jsonObject(source);
  const target = current ? jsonObject(current) : {};
  const changes: SettingChange[] = [];
  let selected = 0;
  for (const [key, validate] of Object.entries(rules)) {
    if (!Object.hasOwn(input, key)) continue;
    selected++;
    let value = input[key];
    if (key.endsWith('Pane') && value === 'folded') value = 'closed';
    if (!validate(value)) fail('migration_invalid_setting');
    if (Object.hasOwn(target, key) && !validate(target[key])) fail('migration_invalid_target_setting');
    if (target[key] !== value) {
      changes.push({ key, before: Object.hasOwn(target, key) ? target[key] : null, after: value });
      target[key] = value;
    }
  }
  if (!selected) fail('migration_no_compatible_settings');
  const bytes = changes.length ? Buffer.from(JSON.stringify(target, null, 2) + '\n') : current!;
  if (bytes.length > LIMIT) fail('migration_input_limit');
  return { bytes, changes, excludedKeys: Object.keys(input).length - selected };
}
