// Explicitly selected disposable test integration, not a shipped capability.
export { createRunFactPort } from '../../dist/core/run/ledger-port.js';
import { PiChatProtocol } from '../../dist/harness/pi/chat-protocol.js';
export function createChatProtocol(name) {
  if (name !== 'pi-rpc-v0.73.1') throw Error('unsupported_chat_protocol');
  return new PiChatProtocol();
}
