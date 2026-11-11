import { parseRosterRoot, rosterSelectionKey } from './selection.js';

export function externalRootHash(root: string): string {
  return rosterSelectionKey(parseRosterRoot(root));
}
