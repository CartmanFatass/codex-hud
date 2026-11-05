import { makeLabPiPreparer } from './pi-preparer.mjs';
import { launchDigest } from '../../packages/hud-mcp/dist/src/core/run/control.js';
// Lab only: never changes the shared capability cell or production preparer.
export function makeChatPiPreparer(root, executable) {
  const base = makeLabPiPreparer(root, executable);
  return async (options) => {
    const prepared = await base(options);
    return Object.freeze({
      ...prepared,
      forRun: (args) => {
        const original = prepared.forRun(args);
        const input = { ...original.input, stdin: 'protocol', chatProtocol: 'pi-rpc-v0.73.1' };
        return { ...original, input, launchDigest: launchDigest(input), payload: { ...original.payload, input } };
      },
    });
  };
}
