// The judge observation carries page structure: observed actions as elements and
// bounded visible h1–h3 headings. The stability marker stays page-derived.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { BrowserPort } from '../../src/jev/agent.js';
import { awaitStates, type JudgmentProvider, type JudgmentRequest } from '../../src/jev/judge.js';
import { actionSpace, type PageState } from '../../src/jev/model.js';
import { observeBrowser } from '../../src/jev/runtime/executor.js';
import { fakeBrowser } from '../../src/jev/runtime/fake.js';
import { searchPage } from './jev-page.js';

const HUD_HOME = join(tmpdir(), 'jev-judge-structure');
const HEADING_TEXT_LIMIT = 200;
const HEADING_LIMIT = 12;

type Evaluator = (expression: string) => unknown;

/** The existing fake browser, observing a synthetic page through an optional evaluate stand-in. */
function pageBrowser(page: PageState, evaluate?: Evaluator): BrowserPort & { evaluate?: Evaluator } {
  const browser = fakeBrowser(HUD_HOME) as BrowserPort & { evaluate?: Evaluator };
  browser.observe = async () => structuredClone(page);
  if (evaluate) browser.evaluate = async (expression: string) => evaluate(expression);
  return browser;
}

/** A stamped readyState keeps the observation to one evaluate call: the headings read. */
function stamped(page: PageState): PageState {
  return { ...page, readyState: 'complete' } as PageState;
}

test('actions become the same element records actionSpace builds', async () => {
  const page = stamped(searchPage());
  const observation = await observeBrowser(pageBrowser(page)).observe();
  const [expected] = actionSpace(page.actions);
  assert.ok(expected.length > 0);
  assert.deepEqual(observation.elements, expected);
});

test('headings are in document order with levels, bounded to 12 of 200 characters', async () => {
  const expressions: string[] = [];
  // Hidden headings never reach this array: the evaluate expression itself skips an
  // element with the `hidden` attribute, `display:none`, `visibility:hidden`, or no
  // rendered box (a `display:none` ancestor). The stand-in below returns only visible
  // headings, so this test pins the bounded shape and the single evaluate read, not
  // DOM visibility.
  const returned = Array.from({ length: 15 }, (_, index) => ({
    level: (index % 3) + 1,
    text: `Heading ${index + 1} ${'x'.repeat(300)}`,
  }));
  const observation = await observeBrowser(
    pageBrowser(stamped(searchPage()), (expression) => {
      expressions.push(expression);
      return returned;
    })
  ).observe();

  assert.equal(expressions.length, 1);
  assert.match(expressions[0], /h1, h2, h3/);
  assert.match(expressions[0], /node\.hidden/);
  assert.match(expressions[0], /getComputedStyle/);
  assert.match(expressions[0], /getClientRects/);

  const headings = observation.facts.headings as Array<{ level: number; text: string }>;
  assert.equal(headings.length, HEADING_LIMIT);
  assert.deepEqual(
    headings.map((heading) => heading.level),
    [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]
  );
  for (const heading of headings) assert.equal(heading.text.length, HEADING_TEXT_LIMIT);
  assert.equal(headings[0]?.text.startsWith('Heading 1 '), true);
});

test('a missing or failing evaluate leaves no headings and still observes', async () => {
  const page = stamped(searchPage());

  const missing = await observeBrowser(pageBrowser(page)).observe();
  assert.deepEqual(missing.facts.headings, []);
  assert.equal(missing.page.url, page.url);

  const failing = await observeBrowser(
    pageBrowser(page, () => {
      throw new Error('synthetic evaluate failure');
    })
  ).observe();
  assert.deepEqual(failing.facts.headings, []);
  assert.equal(failing.page.url, page.url);

  const malformed = await observeBrowser(pageBrowser(page, () => ({ not: 'an array' }))).observe();
  assert.deepEqual(malformed.facts.headings, []);
});

test('the stability marker is identical with and without headings and elements', async () => {
  const marker = [1, 'https://example.test/', 0, 0, 1280, 900, 'Search', 'Search', [], 0];
  const withStructure = stamped({ ...searchPage(), marker });
  const withoutStructure = stamped({ ...searchPage(), marker, actions: [] });

  const first = await observeBrowser(
    pageBrowser(withStructure, () => [{ level: 1, text: 'Example Domain' }])
  ).observe();
  const second = await observeBrowser(pageBrowser(withoutStructure)).observe();

  assert.deepEqual(first.facts.marker, marker);
  assert.deepEqual(first.facts.marker, second.facts.marker);
  assert.equal(JSON.stringify(first.facts.marker), JSON.stringify(second.facts.marker));
});

test('the judge request carries elements and facts.headings', async () => {
  const page = stamped(searchPage());
  const headings = [
    { level: 1, text: 'Example Domain' },
    { level: 2, text: 'More information' },
  ];
  const requests: JudgmentRequest[] = [];
  const provider: JudgmentProvider = {
    async judge(request) {
      requests.push(request);
      return {
        answers: request.statements.map((statement) => ({
          name: statement.name,
          kind: 'predicate' as const,
          probability: statement.name === 'loading' || statement.name === 'needs_human' ? 0.05 : 1,
        })),
        usage: {},
        latencyMs: 1,
        raw: { model: 'fake' },
      };
    },
  };

  const outcome = await awaitStates(
    [{ name: 'page_ready', statement: 'The page is ready.' }],
    observeBrowser(pageBrowser(page, () => headings)),
    provider,
    { maxMs: 5_000, maxCalls: 2, pollMs: 1 }
  );

  assert.equal(outcome.statements[0]?.verdict, 'pass');
  assert.ok(requests.length >= 1);
  const request = requests[0] as JudgmentRequest;
  assert.deepEqual(request.elements, actionSpace(page.actions)[0]);
  assert.deepEqual(request.facts.headings, headings);
});

test('the evaluate expression is valid JavaScript and skips hidden headings on a synthetic DOM', async () => {
  // Fakes above never run the expression; this one does, so a syntax slip cannot hide behind a [] fallback.
  const node = (tagName: string, text: string, opts: { hidden?: boolean; display?: string; boxes?: number } = {}) => ({
    tagName,
    textContent: text,
    hidden: opts.hidden ?? false,
    style: { display: opts.display ?? 'block', visibility: 'visible' },
    getClientRects: () => ({ length: opts.boxes ?? 1 }),
  });
  const nodes = [
    node('H1', '  Example   Domain '),
    node('H2', 'hidden', { hidden: true }),
    node('H2', 'none', { display: 'none' }),
    node('H3', 'no box', { boxes: 0 }),
    node('H2', 'x'.repeat(5_000)),
    ...Array.from({ length: 20 }, (_, i) => node('H3', `Section ${i}`)),
  ];
  const sandbox = {
    document: { querySelectorAll: () => nodes },
    window: { getComputedStyle: (n: (typeof nodes)[number]) => n.style },
  };
  let raw: unknown;
  const page = stamped(searchPage());
  const observation = await observeBrowser(
    pageBrowser(page, (expression) => (raw = runInNewContext(expression, sandbox)))
  ).observe();

  assert.ok(Array.isArray(raw));
  assert.equal((raw as unknown[]).length, HEADING_LIMIT);
  const headings = observation.facts.headings as { level: number; text: string }[];
  assert.deepEqual(headings[0], { level: 1, text: 'Example Domain' });
  assert.equal(headings[1]?.text.length, HEADING_TEXT_LIMIT);
  assert.equal(headings[2]?.text, 'Section 0');
  assert.ok(headings.every((h) => !['hidden', 'none', 'no box'].includes(h.text)));
});
