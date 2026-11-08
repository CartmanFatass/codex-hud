// In-process stand-in used only when JEV_RUNTIME_FAKE=1. It never opens Chrome.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserPort } from '../agent.js';
import type { DecisionProvider } from '../decide.js';
import type { PageState } from '../model.js';

const PAGE = {
  url: 'https://example.invalid/fixture',
  title: 'Fixture',
  text: 'synthetic page',
  actions: [],
  fingerprint: 'fixture',
  marker: 'stable',
  readyState: 'complete',
} as PageState & { readyState: string };

/** Blocks in `observe` while `$HUD_HOME/jev-runtime/hold` exists. */
export function fakeBrowser(hudHome: string): BrowserPort {
  const hold = join(hudHome, 'jev-runtime', 'hold');
  let closed = false;
  return {
    async fresh() {
      return true;
    },
    async observe() {
      while (!closed && existsSync(hold)) await delay(15);
      if (closed) throw new Error('closed');
      return PAGE;
    },
    async act() {
      return { executed: 'fixture' };
    },
    async close() {
      closed = true;
      const block = join(hudHome, 'jev-runtime', 'close-hold');
      while (existsSync(block)) await delay(15);
    },
  };
}

export function fakeProvider(): DecisionProvider {
  return {
    id: 'typesafe',
    model: 'fake',
    async decide(request) {
      const ids = request.questions[0]?.choices.map((choice) => choice.value) ?? ['DONE'];
      const probabilities: Record<string, number> = {};
      for (const id of ids) probabilities[id] = id === 'DONE' ? 1 : 0;
      if (!('DONE' in probabilities)) probabilities.DONE = 1;
      return {
        answers: [{ name: 'operation', kind: 'choice', choice: 'DONE', probabilities, confidence: 1 }],
        usage: {},
        latencyMs: 1,
        raw: { model: 'fake' },
      };
    },
    async judge(request) {
      return {
        answers: request.statements.map((statement) => ({
          name: statement.name,
          kind: 'predicate' as const,
          probability: statement.name === 'loading' || statement.name === 'needs_human' ? 0.05 : 0.95,
        })),
        usage: {},
        latencyMs: 1,
        raw: { model: 'fake' },
      };
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
