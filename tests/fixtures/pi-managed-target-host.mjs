#!/usr/bin/env node
// SYNTHETIC Pi 1.4.0 persisted-print callback host. No model, account or provider.
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@earendil-works/pi-coding-agent')
      return { url: 'data:text/javascript,export const VERSION="1.4.0";', shortCircuit: true };
    return next(specifier, context);
  },
});
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const root = value('--session-dir');
const resumed = args.includes('--session');
const file = resumed ? value('--session') : join(root, `synthetic-${process.env.HUD_RUN}.jsonl`);
const id = resumed ? JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).id : `synthetic-${process.env.HUD_RUN}`;
let brief = '';
for await (const chunk of process.stdin) brief += chunk;
if (!brief.includes('delegate_whoami') || !brief.includes('delegate_report')) throw Error('missing_managed_brief');
if (!resumed) writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id }) + '\n');
appendFileSync(file, JSON.stringify({ type: 'message', synthetic: true }) + '\n');
process.title = 'pi'; // Real supported Pi erases procfs argv, but not process.argv.
const handlers = new Map(),
  tools = new Map();
const ctx = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => id, getSessionFile: () => file, getSessionDir: () => root },
};
const extension = await import(pathToFileURL(value('-e')));
extension.default({
  on: (event, handler) => handlers.set(event, handler),
  registerTool: (tool) => tools.set(tool.name, tool),
  registerCommand() {},
});
await handlers.get('session_start')({ reason: resumed ? 'resume' : 'startup' }, ctx);
try {
  let who;
  for (let attempt = 0; attempt < 10; attempt++) {
    who = (await tools.get('delegate_whoami').execute(`who-${attempt}`, {}, undefined, undefined, ctx)).details;
    if (who.state !== 'pending') break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  if (!who.ok || who.state === 'pending') throw Error('handshake_never_bound');
  let nested;
  try {
    await tools.get('delegate_spawn').execute(
      'nested',
      {
        backend: process.env.HUD_MCP_PROFILE,
        role: 'worker',
        brief: file,
        cwd: process.cwd(),
        mode: 'headless',
        request_key: 'forbidden-nested',
      },
      undefined,
      undefined,
      ctx
    );
  } catch (error) {
    nested = JSON.parse(error.message);
  }
  if (nested?.code !== 'nested_delegation_not_supported') throw Error('nested_refusal_not_proved');
  const reported = (
    await tools
      .get('delegate_report')
      .execute(
        'report',
        { runId: process.env.HUD_RUN, status: 'completed', summary: 'Synthetic managed Pi completed' },
        undefined,
        undefined,
        ctx
      )
  ).details;
  if (!reported.ok) throw Error('report_failed');
  process.stdout.write(
    JSON.stringify({ synthetic: true, sessionId: id, resumed, who, report: reported, nested }) + '\n'
  );
} finally {
  await handlers.get('session_shutdown')({}, ctx);
}
