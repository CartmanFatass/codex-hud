import type { ReaderParserState } from './types/observation.js';

export function initialParserState(): ReaderParserState {
  return {
    pendingBytes: [],
    discardingOversize: false,
    usageMessageIds: [],
    compactBoundary: null,
    openToolWaits: [],
    rateBaseline: null,
    gaps: [],
    skipped: {},
  };
}
