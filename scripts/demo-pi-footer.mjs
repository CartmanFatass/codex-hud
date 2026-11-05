/** Credential-free simulation of the actual extension entry and public footer factory. */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PI_FOOTER_SOURCE } from '../dist/harness/pi/footer.js';

const source = readFileSync(new URL('../extensions/pi/hud-footer.ts', import.meta.url), 'utf8');
const compiled = ts
  .transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  })
  .outputText.replace('../../dist/harness/pi/footer.js', new URL('../dist/harness/pi/footer.js', import.meta.url).href);
const extension = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const handlers = new Map();
const commands = new Map();
let footer;
let input = 1200;
let leaf = 'synthetic-leaf-a';
let context = { tokens: 4700, contextWindow: 200000, percent: 2.35 };
let subscriptions = 0;
const ctx = {
  mode: 'tui',
  hasUI: true,
  model: { id: 'synthetic-model', provider: 'synthetic' },
  thinkingLevel: 'high',
  sessionManager: {
    getSessionId: () => 'synthetic-session-a',
    getSessionFile: () => '/synthetic/pi/a.jsonl',
    getSessionDir: () => '/synthetic/pi',
    getLeafId: () => leaf,
    getBranch: () => [
      {
        type: 'message',
        id: leaf,
        message: {
          role: 'assistant',
          usage: {
            input,
            output: 400,
            cacheRead: 3000,
            cacheWrite: 500,
            cost: { total: 0.025 },
          },
        },
      },
    ],
  },
  getContextUsage: () => context,
  isIdle: () => false,
  ui: {
    notify: () => {},
    setFooter: (factory) => {
      footer?.dispose();
      footer = factory?.(
        { requestRender: () => {} },
        { fg: (_color, text) => text },
        {
          getGitBranch: () => 'synthetic-main',
          getExtensionStatuses: () => new Map([['other-extension', 'other status retained']]),
          onBranchChange: () => {
            subscriptions++;
            return () => {
              subscriptions--;
            };
          },
        }
      );
    },
  },
};
extension.default({
  on: (event, handler) => handlers.set(event, handler),
  registerCommand: (name, command) => commands.set(name, command),
});
handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
const scenes = [{ name: 'current native branch, width 100', lines: footer.render(100) }];
context = { tokens: null, contextWindow: 200000, percent: null };
handlers.get('session_compact')({ type: 'session_compact' }, ctx);
scenes.push({ name: 'after compaction, context unknown, width 100', lines: footer.render(100) });
leaf = 'synthetic-leaf-b';
input = 50;
handlers.get('session_tree')({ type: 'session_tree', newLeafId: leaf }, ctx);
scenes.push({ name: 'different native branch, width 56', lines: footer.render(56) });
await commands.get('hud-footer').handler('off', ctx);
if (footer !== undefined || subscriptions !== 0) throw new Error('footer cleanup failed');
console.log(
  JSON.stringify({ simulation: true, officialSource: PI_FOOTER_SOURCE, scenes, restoredDefault: true }, null, 2)
);
