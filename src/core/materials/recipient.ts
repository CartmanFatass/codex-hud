import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fingerprint, type ResolvedRecipient } from './index.js';

export interface MaterialRoute {
  backend: 'api' | 'agy' | 'off';
  endpoint?: string;
  model?: string;
  reasoning?: boolean;
}
/** A key is deliberately absent. Unknown CLI downstream targets require a trusted profile. */
export function resolveRecipient(
  route: MaterialRoute,
  account?: string,
  trustedProfile?: string
): ResolvedRecipient | null {
  if (!route.model) return null;
  if (route.backend === 'agy')
    return trustedProfile
      ? {
          recipientId: fingerprint(['cli', 'agy', trustedProfile]),
          model: route.model,
        }
      : null;
  if (route.backend !== 'api' || !account) return null;
  try {
    const url = new URL(route.endpoint!);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return null;
    return {
      recipientId: fingerprint(['api', url.protocol, url.hostname, url.port, url.pathname, account]),
      model: route.model,
    };
  } catch {
    return null;
  }
}

/** Even a composition-supplied account resolver cannot detach a grant from the selected transport. */
export function bindResolvedRecipient(
  route: MaterialRoute,
  resolved: ResolvedRecipient | null
): ResolvedRecipient | null {
  if (!resolved?.recipientId || resolved.model !== route.model) return null;
  if (route.backend === 'agy')
    return { ...resolved, recipientId: fingerprint(['resolved-cli', 'agy', resolved.recipientId]) };
  if (route.backend !== 'api') return null;
  try {
    const url = new URL(route.endpoint!);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // The trusted resolver identifies any provider/account routing in query parameters; credential values never enter identity.
    return {
      ...resolved,
      recipientId: fingerprint([
        'resolved-api',
        url.protocol,
        url.hostname,
        url.port,
        url.pathname,
        resolved.recipientId,
      ]),
    };
  } catch {
    return null;
  }
}

/** A trusted CLI profile is still tied to the concrete executable and observable launch context. */
export class CliRecipientBinding {
  private observed = false;
  private snapshot?: {
    executable: string;
    stamp: string;
    path: string | undefined;
    context: string[];
    credentials: Array<string | undefined>;
  };
  private readonly profileKeys = [
    'HOME',
    'XDG_CONFIG_HOME',
    'GEMINI_CLI_HOME',
    'CLOUDSDK_CONFIG',
    'AGY_PROFILE',
    'AGY_ACCOUNT',
    'AGY_CONFIG',
    'AGY_HOME',
    'AGY_ENDPOINT',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ];
  private readonly credentialKeys = ['AGY_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  capture(env: NodeJS.ProcessEnv): void {
    if (this.observed) return;
    this.observed = true;
    const executable = resolveCliExecutable(env);
    if (!executable) return;
    try {
      const stat = fs.statSync(executable);
      this.snapshot = {
        executable,
        stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
        path: env.PATH,
        context: this.profileKeys.map((key) => env[key] ?? ''),
        credentials: this.credentialKeys.map((key) => env[key]),
      };
    } catch {
      /* Changed during capture: no executable permission. */
    }
  }
  bind(recipient: ResolvedRecipient | null, env: NodeJS.ProcessEnv): ResolvedRecipient | null {
    const snapshot = this.snapshot;
    if (
      !snapshot ||
      !recipient ||
      env.PATH !== snapshot.path ||
      resolveCliExecutable(env) !== snapshot.executable ||
      this.profileKeys.some((key, index) => (env[key] ?? '') !== snapshot.context[index]) ||
      this.credentialKeys.some((key, index) => env[key] !== snapshot.credentials[index])
    )
      return null;
    try {
      const stat = fs.statSync(snapshot.executable);
      if (`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` !== snapshot.stamp) return null;
      return {
        ...recipient,
        recipientId: fingerprint([
          'cli-executable-v1',
          recipient.recipientId,
          snapshot.executable,
          snapshot.stamp,
          snapshot.path,
          snapshot.context,
        ]),
      };
    } catch {
      return null;
    }
  }
  executable(): string | undefined {
    return this.snapshot?.executable;
  }
}

export function resolveCliExecutable(env: NodeJS.ProcessEnv): string | null {
  if (!env.PATH) return null;
  for (const directory of env.PATH.split(path.delimiter)) {
    try {
      const file = fs.realpathSync(path.resolve(os.tmpdir(), directory || '.', 'agy'));
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* Next PATH entry, using the same cwd as the transport. */
    }
  }
  return null;
}
