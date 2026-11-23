#!/usr/bin/env node
/**
 * Rewrites every frame snapshot under tests/fixtures from the current build, then prints which files changed.
 * Run as `npm run snapshots:update` (it builds the app and TypeScript fixtures first). Review the diff before committing:
 * a snapshot that changed without a deliberate UI change is a regression, not a refresh.
 */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TZ = 'UTC';
const root = process.cwd();
const fixture = (name) => join(root, 'tests/fixtures', name);
const load = (name) => import(new URL(`../tests/fixtures/${name}`, import.meta.url));
async function withHome(fn) {
  const home = fs.mkdtempSync(join(tmpdir(), 'snapshots-'));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const writers = {
  'card-details-frames.json': async () => {
    const { cardFixture, colourFrames } = await load('card-details.mjs');
    return withHome((h) => colourFrames(cardFixture(h)));
  },
  'home-jobs-frames.json': async () => {
    const { jobFrames } = await load('home-jobs.mjs');
    return jobFrames();
  },
  'control-usage-frames.json': async () => {
    const { dispatchFrames } = await load('control-usage.mjs');
    return dispatchFrames();
  },
  'native-tree-frames.json': async () => {
    const { nativeFixture, nativeFrames } = await load('native-tree.mjs');
    return withHome((h) => nativeFrames(nativeFixture(h)));
  },
  'home-progress-frames.json': async () => {
    const { homeFixture, homeFrames } = await load('home-progress.mjs');
    return withHome(async (h) => homeFrames({ root: h, ...(await homeFixture(h)) }));
  },
  'kept-pages-frames.json': async () => {
    const { pageFixture, pageFrames } = await load('kept-pages.mjs');
    return withHome((h) => pageFrames(pageFixture(h)));
  },
  'split-frames.json': async () => {
    const { splitFixture, splitFrames } = await load('split-layout.mjs');
    return withHome(async (h) => splitFrames(await splitFixture(join(h, 'busy')), await splitFixture(join(h, 'idle'), { idle: true })));
  },
  'project-frames.json': async () => {
    const { projectFixture, projectFrames } = await load('project-page.mjs');
    return withHome(async (h) => projectFrames({ root: h, ...(await projectFixture(h)) }));
  },
  'project-list-frames.json': async () => {
    const { listFixture, listFrames } = await load('project-list.mjs');
    return withHome(async (h) => listFrames(await listFixture(h)));
  },
  'ticket-frames.json': async () => {
    const { ticketFixture, ticketFrames } = await load('project-tickets.mjs');
    return withHome(async (h) => ticketFrames({ root: h, ...(await ticketFixture(h)) }));
  },
  'bar-widths.json': async () => {
    const { widthFrames } = await import(join(root, 'dist-test/fixtures/bar-widths.js'));
    return widthFrames();
  },
};
const only = process.argv.slice(2);
const changed = [];
for (const [name, make] of Object.entries(writers)) {
  if (only.length && !only.includes(name)) continue;
  // Private Use glyphs (the Nerd icons) are written as \u escapes: valid JSON, and no tool strips them from the file.
  const text = JSON.stringify(await make(), null, 2).replace(/[\uE000-\uF8FF]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`) + '\n';
  if (fs.readFileSync(fixture(name), 'utf8') !== text) {
    fs.writeFileSync(fixture(name), text);
    changed.push(name);
  }
}
console.log(changed.length ? `updated: ${changed.join(', ')}` : 'all snapshots already current');
