/** Display identity for a roster root: source namespace and session id, without a thread id. */

const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

export interface RosterRoot {
  readonly namespace: string;
  readonly sessionId: string;
}

export function formatRosterRoot(root: RosterRoot): string {
  return `${root.namespace}/${root.sessionId}`;
}

export function parseRosterRoot(value: string): RosterRoot {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash !== value.lastIndexOf('/')) throw new Error('invalid_value: root');
  const namespace = value.slice(0, slash);
  const sessionId = value.slice(slash + 1);
  if (!NAMESPACE.test(namespace) || !SESSION.test(sessionId) || namespace.includes('..') || sessionId.includes('..')) {
    throw new Error('invalid_value: root');
  }
  return { namespace, sessionId };
}
