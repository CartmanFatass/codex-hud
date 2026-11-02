// Owns a temporary real SQLite fixture; no harness/model/network calls.
import { handshakeFixture } from '../../dist-test/tests/unit/b45-handshake-fixture.js';
import { HudMcpServer, serveStdioProcess } from '../../dist-test/packages/hud-mcp/src/server.js';
import { ReadControlService } from '../../dist-test/packages/hud-mcp/src/read-control.js';
const f = await handshakeFixture();
const service = new ReadControlService(f.ledger, f.root, () => {
  process.send?.({ armed: true });
  return {
    unavailable: false,
    close() {
      process.send?.({ closed: true });
    },
  };
});
const server = new HudMcpServer(
  {
    resolve: async () => ({
      ok: true,
      sessionRef: f.parent.ref,
      processKey: f.parent.authority.evidence.processKey,
      evidenceDigest: 'synthetic',
      callId: 'synthetic',
    }),
  },
  {
    invoke: async (_s, _tool, args, _start, signal) =>
      _tool === 'delegate_status'
        ? { ok: true, payload: 'x'.repeat(1024 * 1024) }
        : service.wait(
            args,
            () => f.parent.authority,
            { clientToolTimeoutMs: 180000, responseMarginMs: 1000, verified: true },
            signal
          ),
  }
);
let discardPendingOutput = false;
try {
  process.send?.({ ready: true });
  ({ discardPendingOutput } = await serveStdioProcess(server));
} finally {
  service.close();
  await f.close();
  process.disconnect?.();
}

if (discardPendingOutput) process.exit(0);
