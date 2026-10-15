import type { CardVisibility } from './card-visibility.js';

/** Presets own only these thirteen content switches, never scope, corners or generation permissions. */
export const CARD_PRESET_KEYS = ['cardLabel','cardOriginalName','cardSummary','cardRelations','cardAction',
  'cardSubagents','cardSubagentSummary','cardRoleCounts','cardModel','cardReviews','cardClock','cardRate','cardContext'] as const;
export type CardPresetKey = typeof CARD_PRESET_KEYS[number];
export type CardPresetSettings = Pick<CardVisibility,CardPresetKey>;
export const CARD_PRESETS = ['minimal','progress','monitor','custom'] as const;
export type CardPreset = typeof CARD_PRESETS[number];

const minimal: CardPresetSettings = {
  cardLabel:true,cardOriginalName:false,cardSummary:true,cardRelations:false,cardAction:false,
  cardSubagents:false,cardSubagentSummary:false,cardRoleCounts:false,cardModel:false,cardReviews:false,
  cardClock:false,cardRate:false,cardContext:false,
};
const presets: Record<Exclude<CardPreset,'custom'>,CardPresetSettings> = {
  minimal,
  progress:{...minimal,cardAction:true,cardSubagents:true,cardSubagentSummary:true},
  monitor:{...minimal,cardAction:true,cardSubagents:true,cardSubagentSummary:true,cardRelations:true,
    cardRoleCounts:true,cardModel:true,cardReviews:true,cardClock:true,cardRate:true,cardContext:true},
};

/** Derived from every owned switch, including switches currently hidden by a dependency. No saved preset identity. */
export function identifyCardPreset(settings:CardPresetSettings):CardPreset {
  return (['minimal','progress','monitor'] as const).find(preset =>
    CARD_PRESET_KEYS.every(key => settings[key] === presets[preset][key])) ?? 'custom';
}

/** Return a new settings object changing only content switches. Custom is an identity/no-op, not a fourth configuration. */
export function applyCardPreset<T extends CardPresetSettings>(settings:T,preset:CardPreset):T {
  return preset === 'custom' ? settings : {...settings,...presets[preset]};
}
