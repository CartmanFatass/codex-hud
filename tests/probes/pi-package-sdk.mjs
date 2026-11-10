/** Compile the exact public SDK seams used by the JS entry against installed pi. */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { piPackage } from '../fakes/pi-package.mjs';
const pkg = piPackage();
if (!pkg || pkg.version !== '1.5.1') throw Error('NOT_VERIFIED: installed pi 1.5.1 not found');
const dir = fs.mkdtempSync(join(tmpdir(), 'hud-a5-sdk-'));
try {
  fs.writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const events = [
    'session_start',
    'session_shutdown',
    'session_before_switch',
    'session_before_fork',
    'session_before_tree',
    'session_tree',
    'model_select',
    'thinking_level_select',
    'agent_start',
    'agent_end',
    'agent_settled',
    'message_end',
    'session_compact',
    'session_compact_failed',
    'session_info_changed',
  ];
  const witness = `import type { ExtensionAPI, ExtensionContext } from ${JSON.stringify(join(pkg.root, 'dist/index.js'))};
import type { PiPackageContext } from ${JSON.stringify(resolve('dist/harness/pi/package-context.js'))};
declare const pi: ExtensionAPI;
declare const ctx: ExtensionContext;
const projected: PiPackageContext = ctx;
const header = projected.sessionManager.getHeader();
ctx.ui.setStatus('hud-delegation', undefined);
ctx.ui.notify(header?.id ?? 'pending', 'info');
${events.map((e) => `const remove_${e}: () => void = pi.on('${e}', async (_event, c) => { const native: PiPackageContext = c; void native; }); void remove_${e};`).join('\n')}
pi.registerCommand('hud', { description: 'local', handler: async (args, c) => { const native: PiPackageContext = c; void native; void args; } });
pi.registerTool({name:'hud_read',label:'hud_read',description:'proxy',parameters:{type:'object'},execute:async (id, args, signal, onUpdate, c) => { const native: PiPackageContext = c; void native; void id; void args; void signal; void onUpdate; return {content:[{type:'text',text:'local'}],details:undefined,isError:false}; }});
`;
  fs.writeFileSync(join(dir, 'witness.ts'), witness);
  fs.writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        types: ['node'],
        typeRoots: [resolve('node_modules/@types')],
      },
      files: ['witness.ts'],
    })
  );
  const r = spawnSync(
    process.execPath,
    [resolve('node_modules/typescript/bin/tsc'), '-p', join(dir, 'tsconfig.json')],
    { encoding: 'utf8', timeout: 120000 }
  );
  console.log(r.stdout + r.stderr);
  assert.equal(r.status, 0, 'installed SDK declaration incompatibility');
  console.log(
    'PASS installed pi ' +
      pkg.version +
      ': context/mode/status/command/tool and ' +
      events.length +
      ' event declarations'
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
