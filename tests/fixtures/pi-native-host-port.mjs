/** Synthetic non-socket host port only. The extension, stdio transport, native
 * source resolver and registry remain real; this is NOT IPC/provider coverage. */
import { registerHooks } from 'node:module';
const source = `
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export class NativeHostClient {
  constructor(home) { this.home = home; }
  async invoke(owner, method, args) {
    assert.equal(owner.harness, 'pi');
    assert.equal(typeof owner.sourceId, 'string');
    assert.ok(owner.sourceId.length > 0);
    assert.match(owner.sessionId, /^synthetic-/);
    assert.equal(owner.threadId, null);
    appendFileSync(join(this.home, 'synthetic-native-port.jsonl'), JSON.stringify({owner,method,args})+'\\n');
    if (method === 'wake_register') {
      assert.equal(args.target.adapter, 'pi_extension');
      assert.ok(args.target.socketPath.startsWith(join(this.home, 'wake') + '/pi-'));
      return {adapter:'pi_extension', last:null, modelReadAcknowledged:false};
    }
    if (method === 'list') return {connections:[], relations:[]};
    if (method === 'create') throw new Error('native_profile_not_configured');
    if (method === 'close') throw new Error('native_connection_not_owned');
    throw new Error('unsupported_synthetic_port_method');
  }
}
`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/managed/host-ipc.js'))
      return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
    return next(specifier, context);
  },
});
