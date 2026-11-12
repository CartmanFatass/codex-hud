/** Shared default statusline settings. No plugin discovery and no imported executable configuration. */
import { join, isAbsolute } from 'node:path';
import { getHudHome } from '../hud-home.js';
import { readJson, record } from './storage.js';
export interface ParitySettings {
  lineLayout: 'compact';
  showSeparators: boolean;
  display: {
    showTools: false;
    showAgents: boolean;
    showTodos: boolean;
    showDuration: boolean;
    showConfigCounts: boolean;
    showSkills: boolean;
    showEffortLevel: boolean;
  };
  gitStatus: { enabled: boolean; showDirty: boolean; showAheadBehind: boolean; showFileStats: false };
  widthMargin: number;
  forward?: string[];
}
export const displayKeys = [
  'showTools',
  'showAgents',
  'showTodos',
  'showDuration',
  'showConfigCounts',
  'showSkills',
  'showEffortLevel',
] as const;
export const gitKeys = ['enabled', 'showDirty', 'showAheadBehind', 'showFileStats'] as const;
export function paritySettings(value: unknown): ParitySettings {
  const v = record(value),
    d = record(v.display),
    g = record(v.gitStatus);
  if (v.lineLayout !== undefined && v.lineLayout !== 'compact') throw new Error('unsupported: lineLayout');
  if (v.showSeparators !== undefined && typeof v.showSeparators !== 'boolean')
    throw new Error('invalid: showSeparators');
  for (const [obj, keys, prefix] of [
    [d, displayKeys, 'display'],
    [g, gitKeys, 'gitStatus'],
  ] as const)
    for (const key of keys)
      if (obj[key] !== undefined && typeof obj[key] !== 'boolean') throw new Error(`invalid: ${prefix}.${key}`);
  if (d.showTools === true) throw new Error('unsupported: display.showTools=true');
  if (g.showFileStats === true) throw new Error('unsupported: gitStatus.showFileStats=true');
  const widthMargin = v.widthMargin ?? 4;
  if (!Number.isInteger(widthMargin) || Number(widthMargin) < 0 || Number(widthMargin) > 100)
    throw new Error('invalid: widthMargin');
  const forward = v.forward;
  if (
    forward !== undefined &&
    (!Array.isArray(forward) ||
      !forward.length ||
      forward.length > 32 ||
      !forward.every((a) => typeof a === 'string' && a.length <= 4096 && !/[\0\r\n]/.test(a)) ||
      !isAbsolute(forward[0]))
  )
    throw new Error('invalid: forward argv (absolute executable required)');
  return {
    lineLayout: 'compact',
    showSeparators: v.showSeparators === true,
    display: {
      showTools: false,
      showAgents: d.showAgents === true,
      showTodos: d.showTodos === true,
      showDuration: d.showDuration === true,
      showConfigCounts: d.showConfigCounts === true,
      showSkills: d.showSkills === true,
      showEffortLevel: d.showEffortLevel === true,
    },
    gitStatus: {
      enabled: g.enabled !== false,
      showDirty: g.showDirty !== false,
      showAheadBehind: g.showAheadBehind === true,
      showFileStats: false,
    },
    widthMargin: Number(widthMargin),
    ...(forward ? { forward: forward as string[] } : {}),
  };
}
export function loadParitySettings(env: NodeJS.ProcessEnv): ParitySettings | null {
  try {
    const v = readJson(join(getHudHome(env), 'config.json'));
    return v && Object.hasOwn(v, 'statusline') ? paritySettings(v.statusline) : null;
  } catch {
    return null;
  }
}
