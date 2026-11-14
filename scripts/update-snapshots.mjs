#!/usr/bin/env node
/**
 * Rewrites every frame snapshot under tests/fixtures from the current build, then prints which files changed.
 * Run as `npm run snapshots:update` (it builds dist and dist-test first). Review the diff before committing:
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
  'bar-themes.json': async () => {
    const bars = await import(join(root, 'dist-test/tests/fixtures/bar-themes.js'));
    const now = Date.now;
    process.env.COLORTERM = 'truecolor';
    Date.now = () => bars.THEME_NOW;
    try {
      const golden = JSON.parse(fs.readFileSync(fixture('bar-themes.json'), 'utf8'));
      const scene = bars.barThemeScene();
      for (const style of Object.keys(golden)) golden[style] = scene.render(style);
      scene.dispose();
      return golden;
    } finally {
      Date.now = now;
    }
  },
};
const only = process.argv.slice(2);
const changed = [];
for (const [name, make] of Object.entries(writers)) {
  if (only.length && !only.includes(name)) continue;
  const text = JSON.stringify(await make(), null, 2) + '\n';
  if (fs.readFileSync(fixture(name), 'utf8') !== text) {
    fs.writeFileSync(fixture(name), text);
    changed.push(name);
  }
}
console.log(changed.length ? `updated: ${changed.join(', ')}` : 'all snapshots already current');
