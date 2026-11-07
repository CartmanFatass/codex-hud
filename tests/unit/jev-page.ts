// Synthetic page shared by the Jev port tests. No secrets.

import { fingerprint } from '../../src/jev/browser.js';
import type { Answer } from '../../src/jev/decide.js';
import type { PageState } from '../../src/jev/model.js';

export const FIXTURE_GOAL = 'Find a book';
export const FIXTURE_CACHE_KEY = 'hud-jev:fixture';
export const FIXTURE_MODEL = 'jev-latest';

/** The page from upstream tests/test_agent.py. */
export function searchPage(): PageState {
  const state: PageState = {
    url: 'https://example.test/',
    title: 'Search',
    text: 'Search',
    scroll: { y: 0 },
    actions: [
      { id: 'e1', kind: 'fill', label: 'Search', role: 'textbox', value: '', node: 10 },
      { id: 'e2', kind: 'click', label: 'Open Search', role: 'textbox', value: '', node: 10 },
      { id: 'e3', kind: 'click', label: 'Go', role: 'button', value: '', node: 20 },
      { id: 'wait', kind: 'wait', label: 'Wait' },
    ],
  };
  state.fingerprint = fingerprint(state);
  return state;
}

export function choiceAnswer(name: string, ids: readonly string[], selected: string): Answer {
  const probabilities: Record<string, number> = {};
  for (const id of ids) probabilities[id] = id === selected ? 1 : 0;
  return { name, kind: 'choice', choice: selected, probabilities, confidence: 1 };
}
