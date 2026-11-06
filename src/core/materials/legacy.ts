/** Read-only compatibility view. No settings migration and no implicit universal-source grant. */
import { resolveHudEnv } from '../../utils/hud-env.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writePrivateFile } from '../../collectors/small-model.js';
import { getCodexHome } from '../../utils/codex-path.js';
import { makeSourceId, sessionRefKey } from '../identity.js';
import { parseOutboundPolicy } from '../export.js';
import type { OutboundPurpose } from '../types/export.js';
import { fingerprint, type MaterialAuthority, type MaterialSubject, type ResolvedRecipient } from './index.js';
import type { LegacySubject, MaterialPlan } from './request.js';
import { resolveCliExecutable, type CliRecipientBinding, type MaterialRoute } from './recipient.js';

const setting: Partial<Record<OutboundPurpose, string>> = {
  brief: 'briefAgents',
  recap: 'briefMain',
  progress: 'agentProgress',
  digest: 'resultDigest',
  label: 'agentLabels',
  title: 'agentLabels',
  cause: 'failureCause',
  changes: 'changeSummary',
  approval: 'approvalDescription',
};
const historicalDefaults: Record<string, boolean> = {
  briefAgents: true,
  agentProgress: true,
  agentLabels: true,
  briefMain: false,
  resultDigest: false,
  failureCause: false,
  changeSummary: false,
  approvalDescription: false,
};
function readJson(file: string): Record<string, unknown> | null {
  try {
    if (fs.statSync(file).size > 65536) return null;
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
function under(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
/** Only the existing original-home model-cache composition may ask for the compatibility view. */
export class LegacyCodexBridge {
  private baseline?: {
    raw: Record<string, unknown>;
    route: MaterialRoute;
    home: string;
    sourceId: string;
    file: string;
    path: string | undefined;
    credential?: string;
    executable?: string;
    executableStamp?: string;
    sourceEnvironment: string;
  };
  private tried = false;
  constructor(
    private readonly dir: string | null,
    private readonly env: NodeJS.ProcessEnv,
    private readonly connection: () => {
      route: MaterialRoute;
      matches: (raw: Record<string, unknown>) => boolean;
      credential?: string;
    },
    private readonly cliRecipient?: CliRecipientBinding
  ) {}

  private capture(): typeof this.baseline {
    if (this.tried) return this.baseline;
    this.tried = true;
    if (!this.dir || path.basename(this.dir) !== 'model-cache' || path.basename(path.dirname(this.dir)) !== 'hud')
      return undefined;
    try {
      const home = fs.realpathSync(this.env.CODEX_HOME || getCodexHome());
      if (path.resolve(this.dir) !== path.join(home, 'hud', 'model-cache')) return undefined;
      // An alternate sessions tree is not a grant for the original source.
      if (this.env.CODEX_SESSIONS_PATH && fs.realpathSync(this.env.CODEX_SESSIONS_PATH) !== path.join(home, 'sessions'))
        return undefined;
      const file = resolveHudEnv(this.env, 'HUD_SETTINGS_PATH') || path.join(home, 'hud-settings.json');
      const raw = readJson(file);
      const connection = this.connection();
      if (!raw || !['api', 'agy'].includes(String(raw.briefing)) || !connection.matches(raw)) return undefined;
      if (connection.route.backend === 'api') {
        const url = new URL(connection.route.endpoint!);
        if (url.username || url.password || url.search || url.hash) return undefined;
      }
      let executable: string | undefined;
      let executableStamp: string | undefined;
      if (connection.route.backend === 'agy') {
        executable = resolveCliExecutable(this.env) ?? undefined;
        if (executable) {
          const stat = fs.statSync(executable);
          executableStamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        }
        if (!executable) return undefined;
      }
      this.baseline = {
        raw,
        route: connection.route,
        home,
        sourceId: makeSourceId('codex', home),
        file,
        path: this.env.PATH,
        credential: connection.credential,
        executable,
        executableStamp,
        sourceEnvironment: JSON.stringify([
          this.env.CODEX_HOME,
          this.env.CODEX_SESSIONS_PATH,
          resolveHudEnv(this.env, 'HUD_SETTINGS_PATH'),
          this.env.HUD_HOME,
        ]),
      };
    } catch {
      /* No provable original-home grant. */
    }
    return this.baseline;
  }
  private localContext?: { home: string; sourceId: string; environment: string };
  private identityContext(): { home: string; sourceId: string } | null {
    if (!this.dir || path.basename(this.dir) !== 'model-cache' || path.basename(path.dirname(this.dir)) !== 'hud')
      return null;
    try {
      const home = fs.realpathSync(this.env.CODEX_HOME || getCodexHome());
      const environment = JSON.stringify([this.env.CODEX_HOME, this.env.CODEX_SESSIONS_PATH]);
      if (this.localContext && (this.localContext.home !== home || this.localContext.environment !== environment))
        return null;
      if (path.resolve(this.dir) !== path.join(home, 'hud', 'model-cache')) return null;
      if (this.env.CODEX_SESSIONS_PATH && fs.realpathSync(this.env.CODEX_SESSIONS_PATH) !== path.join(home, 'sessions'))
        return null;
      this.localContext ??= { home, sourceId: makeSourceId('codex', home), environment };
      return this.localContext;
    } catch {
      return null;
    }
  }
  identifyNative(selected: readonly LegacySubject[], purpose: OutboundPurpose): MaterialSubject[] | null {
    const context = this.identityContext();
    if (!context || !selected.length) return null;
    const subjects: MaterialSubject[] = [];
    try {
      const sessions = fs.realpathSync(path.join(context.home, 'sessions'));
      for (const subject of selected) {
        if (subject.current && !subject.current()) return null;
        if (
          !subject.rolloutPath ||
          (subject.origin !== undefined && subject.origin !== 'native') ||
          ((subject.ref || subject.universal) && subject.origin !== 'native') ||
          (subject.universal && !subject.ref)
        )
          return null;
        if (subject.chargeFor) {
          const child = subject.chargeFor;
          if (
            (child.origin !== undefined && child.origin !== 'native') ||
            ((child.ref || child.universal) && child.origin !== 'native') ||
            (child.universal && !child.ref) ||
            child.parentSessionId !== subject.sessionId
          )
            return null;
          if (
            child.ref &&
            sessionRefKey(child.ref) !==
              sessionRefKey({
                harness: 'codex',
                sourceId: context.sourceId,
                sessionId: child.sessionId,
                threadId: null,
              })
          )
            return null;
        }
        const file = fs.realpathSync(subject.rolloutPath);
        if (!under(sessions, file)) return null;
        const fd = fs.openSync(file, 'r');
        let header: Record<string, any>;
        let line: string;
        try {
          const bytes = Buffer.alloc(1024 * 1024);
          const n = fs.readSync(fd, bytes, 0, bytes.length, 0);
          line = bytes.subarray(0, n).toString('utf8').split('\n', 1)[0];
          const record = JSON.parse(line);
          if (record.type !== 'session_meta' || !record.payload) return null;
          header = record.payload;
        } finally {
          fs.closeSync(fd);
        }
        if ((header.id ?? header.session_id) !== subject.sessionId) return null;
        if (subject.parentSessionId) {
          const top = header.parent_thread_id;
          const nested = header.source?.subagent?.thread_spawn?.parent_thread_id;
          if (top !== undefined && (typeof top !== 'string' || !top)) return null;
          if (nested !== undefined && (typeof nested !== 'string' || !nested)) return null;
          if (top && nested && top !== nested) return null;
          if ((nested ?? top) !== subject.parentSessionId) return null;
        }
        const ref = {
          harness: 'codex' as const,
          sourceId: context.sourceId,
          sessionId: subject.sessionId,
          threadId: null,
        };
        if (subject.ref && sessionRefKey(subject.ref) !== sessionRefKey(ref)) return null;
        subjects.push({
          ref,
          origin: 'native',
          field: purpose,
          kind: 'public_text',
          recordFingerprint: fingerprint([ref, subject.parentSessionId ?? null, file]),
          read: () => 'authorized legacy public material',
        });
      }
    } catch {
      return null;
    }
    return subjects;
  }
  localLabelFile(file: string): boolean {
    const context = this.identityContext();
    if (!context || !this.dir || path.resolve(file) !== path.join(this.dir, 'labels.json')) return false;
    try {
      return (
        fs.realpathSync(this.dir) === path.join(context.home, 'hud', 'model-cache') &&
        fs.realpathSync(file) === path.join(this.dir, 'labels.json')
      );
    } catch {
      return false;
    }
  }
  observeConfiguration(): void {
    this.capture();
  }
  recipient(route: MaterialRoute): ResolvedRecipient | null {
    const baseline = this.capture();
    if (
      !baseline ||
      route.backend !== baseline.route.backend ||
      route.endpoint !== baseline.route.endpoint ||
      this.env.PATH !== baseline.path ||
      !route.model ||
      this.connection().credential !== baseline.credential ||
      JSON.stringify([
        this.env.CODEX_HOME,
        this.env.CODEX_SESSIONS_PATH,
        resolveHudEnv(this.env, 'HUD_SETTINGS_PATH'),
        this.env.HUD_HOME,
      ]) !== baseline.sourceEnvironment
    )
      return null;
    try {
      if (fs.realpathSync(this.env.CODEX_HOME || getCodexHome()) !== baseline.home) return null;
    } catch {
      return null;
    }
    if (baseline.executable) {
      try {
        const stat = fs.statSync(baseline.executable);
        if (`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` !== baseline.executableStamp) return null;
      } catch {
        return null;
      }
    }
    const recipient = {
      recipientId: fingerprint([
        'legacy-codex-recipient-v1',
        baseline.sourceId,
        route.backend,
        route.endpoint,
        route.backend === 'agy' ? [baseline.path, baseline.executable, baseline.executableStamp] : 'original-account',
      ]),
      model: route.model,
    };
    return route.backend === 'agy' ? (this.cliRecipient?.bind(recipient, this.env) ?? null) : recipient;
  }
  executable(): string | undefined {
    return this.baseline?.executable;
  }
  prepare(
    plan: MaterialPlan,
    route: MaterialRoute
  ): {
    subjects: MaterialSubject[];
    requiredRefs: string[];
    authority: MaterialAuthority;
    recipient: ResolvedRecipient;
  } | null {
    const baseline = this.capture();
    const recipient = this.recipient(route);
    const key = setting[plan.purpose];
    if (!baseline || !recipient || !key || !plan.legacy?.length) return null;
    const purposes = [...new Set([plan.purpose, ...(plan.legacyPurposes ?? [])])];
    const enabled = (raw: Record<string, unknown>) =>
      purposes.every((purpose) => {
        const feature = setting[purpose];
        return !!feature && (Object.hasOwn(raw, feature) ? raw[feature] : historicalDefaults[feature]) === true;
      }) &&
      raw.briefingPaused !== true &&
      raw.briefing === baseline.raw.briefing;
    const subjects = this.identifyNative(plan.legacy, plan.purpose);
    if (!subjects) return null;
    const selected = [...plan.legacy];
    const requiredRefs = subjects.map((subject) => sessionRefKey(subject.ref));
    for (const optional of plan.legacyOptional ?? []) {
      const identified = this.identifyNative([optional], plan.purpose);
      if (identified) {
        subjects.push(...identified);
        selected.push(optional);
      }
    }
    const refs = new Set(subjects.map((subject) => sessionRefKey(subject.ref)));
    const policyFile = path.join(
      this.env.HUD_HOME || path.join(os.homedir(), '.hud'),
      'sources',
      baseline.sourceId,
      'outbound.json'
    );
    const marker = path.join(this.dir!, 'materials-v1', `${baseline.sourceId}.policy-authoritative`);
    const authority: MaterialAuthority = {
      scope: (sourceId) =>
        sourceId === baseline.sourceId
          ? {
              revision: 0,
              local: true,
              allows: (p, purpose) =>
                purpose === plan.purpose &&
                p.origin === 'native' &&
                refs.has(sessionRefKey(p.ref)) &&
                selected.every((subject) => !subject.current || subject.current()),
            }
          : null,
      policy: (sourceId) => {
        const raw = readJson(baseline.file);
        if (
          sourceId !== baseline.sourceId ||
          !raw ||
          !enabled(raw) ||
          !this.connection().matches(raw) ||
          !this.recipient(this.connection().route)
        )
          return null;
        // A file's presence is authoritative, including invalid/unknown files. No fallback on corruption.
        try {
          fs.statSync(policyFile);
          if (!fs.existsSync(marker)) writePrivateFile(marker, 'policy-authoritative-v1');
          return parseOutboundPolicy(readJson(policyFile));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
          if (fs.existsSync(marker)) return null;
        }
        return {
          schemaVersion: 1,
          sourceId,
          revision: 0,
          grants: [{ purpose: plan.purpose, recipientId: recipient.recipientId, decision: 'allow', grantedAt: 0 }],
        };
      },
    };
    return { subjects, requiredRefs, authority, recipient };
  }
}
