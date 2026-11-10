#!/usr/bin/env node
// The mutant driver copies this adapter alone, running from the explicit test checkout.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const local = new URL('./herdr.mjs', import.meta.url);
const { runHerdr } = await import(existsSync(local) ? local : pathToFileURL(process.cwd() + '/tests/fakes/herdr.mjs'));
await runHerdr('panel');
