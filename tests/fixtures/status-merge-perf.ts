import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type MergeInput } from '../../src/core/status/merge.js';

interface Step {
  input: MergeInput;
  nowMs: number;
  ruleVersion: string;
  expected: Record<string, unknown>;
}
interface Fixture {
  id: string;
  title: string;
  steps: Step[];
  otherNodes?: Step[];
  parentChild?: { parentRef: unknown; childRef: unknown };
}
const fixtureDir = resolve('tests/fixtures/status-merge');
const fixtures = readdirSync(fixtureDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({
    name,
    fixture: JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8')) as Fixture,
  }));
const fixture = (id: string) => structuredClone(fixtures.find((f) => f.fixture.id === id)!.fixture);
export { Step, Fixture, fixtureDir, fixtures, fixture };
