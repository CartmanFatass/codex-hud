import { opendirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { digest } from '../../../src/core/canonical.js';
import { makeProcessKey, makeSourceId } from '../../../src/core/identity.js';
import type { SessionRef } from '../../../src/core/types/identity.js';
import type { ScopeSnapshot, ScopeSnapshotPort } from '../../../src/core/ledger-scope-read.js';
import type { DelegateProfile } from './config.js';
import { Refusal } from './errors.js';
import { object, readBounded, readJson } from './io.js';
import type { Registration } from './registry.js';
import { actualSourceRoot, findHarness, type ProcessInfo, type ProcessReaderPort } from './process.js';
import { consumeHookRecord, type ClaudeHookSourceOptions } from './hook/resolve.js';
import { CLAUDE_VERSION, IMPLEMENTATION, hookProfileFingerprint, selectsClaudeHook } from './hook/record.js';
import { readlinkSync } from 'node:fs';
import type { PiEvidenceChannel } from './pi-channel.js';

export type CallResolution =
  | {
      ok: true;
      callId: string;
      sessionRef: SessionRef;
      processKey: string;
      evidenceDigest: string;
      scopePremise?: ScopeSnapshot;
    }
  | { ok: false; code: 'identity_source_missing' | 'identity_unverified' | 'unsupported' | 'stale_context' };
export interface CurrentCallSourcePort {
  resolve(meta: unknown, toolName: string): Promise<CallResolution>;
}
export interface SessionRecordLocatorPort {
  codex(root: string, sessionId: string): string | null;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** UUIDv7 day ±1 covers harness-local date directories. One total 4096-entry/10ms budget. */
export class BoundedSessionLocator implements SessionRecordLocatorPort {
  codex(root: string, sessionId: string): string | null {
    if (!uuid.test(sessionId) || sessionId[14] !== '7') return null;
    const created = parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16);
    const matches: string[] = [];
    const deadline = performance.now() + 10;
    let count = 0;
    for (const offset of [-1, 0, 1]) {
      const date = new Date(created + offset * 86400000);
      const directory = join(
        root,
        'sessions',
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0')
      );
      let dir;
      try {
        dir = opendirSync(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      try {
        for (;;) {
          if (count >= 4096 || performance.now() >= deadline) return null;
          const entry = dir.readSync();
          if (!entry) break;
          count++;
          if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${sessionId}.jsonl`))
            matches.push(join(directory, entry.name));
        }
      } finally {
        dir.closeSync();
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }
}
export function exactClaudeCallRecords(
  text: string,
  callId: string,
  toolName: string
): { sessionId: string; agentId: string | null }[] {
  const matches: { sessionId: string; agentId: string | null }[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes(callId)) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!object(row) || row.type !== 'assistant' || !object(row.message) || !Array.isArray(row.message.content))
      continue;
    for (const block of row.message.content) {
      if (!object(block) || block.type !== 'tool_use' || block.id !== callId || block.name !== toolName) continue;
      if (typeof row.sessionId !== 'string') throw new Refusal('identity_unverified');
      if (row.isSidechain !== false && typeof row.agentId !== 'string') throw new Refusal('identity_unverified');
      matches.push({ sessionId: row.sessionId, agentId: typeof row.agentId === 'string' ? row.agentId : null });
    }
  }
  return matches;
}
/** Cmdline is a resolver only: it never grants an MCP context/claim or managed run. */
export function resolvePiSession(
  process: ProcessInfo,
  root: string,
  locateId?: (root: string, id: string) => string | null
): SessionRef | null {
  if (process.argv.some((arg) => arg === '--fork' || arg.startsWith('--fork='))) return null;
  let session: string | null = null;
  let expectedId: string | null = null;
  for (let i = 1; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--session-id' || arg.startsWith('--session-id=')) {
      if (expectedId !== null) return null;
      expectedId = arg === '--session-id' ? (process.argv[++i] ?? null) : arg.slice(13);
      if (!expectedId) return null;
    }
    if (arg === '--session') {
      if (session !== null) return null;
      session = process.argv[++i] ?? null;
    } else if (arg.startsWith('--session=')) {
      if (session !== null) return null;
      session = arg.slice(10);
    }
  }
  if (!session && expectedId && locateId) session = locateId(root, expectedId);
  if (!session || !session.startsWith('/')) return null;
  try {
    const file = realpathSync(session),
      canonicalRoot = realpathSync(root);
    if (!file.startsWith(canonicalRoot + '/')) return null;
    const header = JSON.parse(readBounded(file, 16384).split('\n')[0]) as unknown;
    if (
      !object(header) ||
      header.type !== 'session' ||
      typeof header.id !== 'string' ||
      !header.id ||
      (expectedId !== null && header.id !== expectedId)
    )
      return null;
    return { harness: 'pi', sourceId: makeSourceId('pi', canonicalRoot), sessionId: header.id, threadId: null };
  } catch {
    return null;
  }
}

/** Reads diagnostic source evidence only. Context/binding transactions remain B2/B5 work. */
export class SessionRefResolver implements CurrentCallSourcePort {
  constructor(
    private readonly registration: Registration,
    private readonly reader: ProcessReaderPort,
    private readonly profile: DelegateProfile | null,
    private readonly locator: SessionRecordLocatorPort = new BoundedSessionLocator(),
    private readonly claudeHook?: ClaudeHookSourceOptions,
    private readonly scopes?: ScopeSnapshotPort,
    private readonly piChannel?: PiEvidenceChannel
  ) {}
  async resolve(meta: unknown, toolName: string): Promise<CallResolution> {
    const deny = (code: Exclude<CallResolution, { ok: true }>['code']): CallResolution => ({ ok: false, code });
    const { caller, source, harnessPid, harnessProcStart } = this.registration;
    if (!source || !this.profile || harnessPid === null || !object(meta)) return deny('identity_source_missing');
    try {
      const self = this.reader.get(caller.pid),
        parent = this.reader.get(caller.ppid),
        domain = this.reader.domain();
      const found = findHarness(this.reader, self.ppid);
      if (
        self.procStart !== caller.procStart ||
        self.ppid !== caller.ppid ||
        parent.procStart !== caller.parentProcStart ||
        !found ||
        found.process.pid !== harnessPid ||
        found.process.procStart !== harnessProcStart ||
        found.process.pidNamespace !== self.pidNamespace ||
        (source.harness !== 'pi' && actualSourceRoot(found.process, source.harness) !== source.rootPath)
      )
        return deny('identity_unverified');
      if (found.harness !== source.harness || found.process.argv.some((arg) => /^(app-server|daemon)$/.test(arg)))
        return deny('unsupported');
      const processKey = makeProcessKey(
        source.harness,
        source.sourceId,
        domain.pidDomain,
        harnessPid,
        harnessProcStart!
      );
      // Captured before reading the source. A losing call must obtain fresh evidence.
      const scopePremise = this.scopes?.read(processKey);
      let callId: string;
      let sessionRef: SessionRef;
      if (source.harness === 'claude') {
        callId = typeof meta['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId'] : '';
        if (!callId || callId.length > 256) return deny('identity_source_missing');
        if (selectsClaudeHook(this.profile)) {
          const hook = this.claudeHook;
          if (
            !hook ||
            hook.config.implementation !== IMPLEMENTATION ||
            hook.config.claudeVersion !== CLAUDE_VERSION ||
            hook.config.profileFingerprint !== hookProfileFingerprint(this.profile) ||
            hook.config.sourceRoot !== source.rootPath ||
            hook.config.serverName !== this.profile.mcpServerName
          )
            return deny('unsupported');
          // The launch profile pins an executable whose version was checked by the launcher.
          // Config/env alone never proves that the actual ancestor is this executable.
          if (readlinkSync(`/proc/${harnessPid}/exe`) !== hook.config.claudeExecutable) return deny('unsupported');
          const evidence = consumeHookRecord(hook, {
            processKey,
            sourceId: source.sourceId,
            bootId: domain.bootId,
            callId,
            toolName: `mcp__${this.profile.mcpServerName}__${toolName}`,
          });
          const record = readJson(join(source.rootPath, 'sessions', `${harnessPid}.json`));
          if (
            !object(record) ||
            record.pid !== harnessPid ||
            record.procStart !== harnessProcStart ||
            record.pidDomain !== domain.claudePidDomain ||
            typeof record.sessionId !== 'string' ||
            !uuid.test(record.sessionId) ||
            typeof record.cwd !== 'string'
          )
            return deny('identity_unverified');
          if (evidence.record.sessionId !== record.sessionId) return deny('identity_unverified');
          if (
            this.reader.get(harnessPid).procStart !== harnessProcStart ||
            this.reader.get(caller.pid).procStart !== caller.procStart
          )
            return deny('identity_unverified');
          return {
            ok: true,
            callId,
            sessionRef: { harness: 'claude', sourceId: source.sourceId, sessionId: record.sessionId, threadId: null },
            processKey,
            evidenceDigest: evidence.record.fingerprint,
            scopePremise: evidence.premise,
          };
        }
        const record = readJson(join(source.rootPath, 'sessions', `${harnessPid}.json`));
        if (
          !object(record) ||
          record.pid !== harnessPid ||
          record.procStart !== harnessProcStart ||
          record.pidDomain !== domain.claudePidDomain ||
          typeof record.sessionId !== 'string' ||
          !uuid.test(record.sessionId) ||
          typeof record.cwd !== 'string'
        )
          return deny('identity_unverified');
        const file = join(
          source.rootPath,
          'projects',
          record.cwd.replace(/[^a-zA-Z0-9]/g, '-'),
          `${record.sessionId}.jsonl`
        );
        const text = readBounded(file, 65536, true);
        const matches = exactClaudeCallRecords(text, callId, `mcp__${this.profile.mcpServerName}__${toolName}`);
        if (matches.length === 0) return deny('identity_source_missing');
        if (matches.length !== 1 || matches[0].agentId !== null || matches[0].sessionId !== record.sessionId)
          return deny('identity_unverified');
        // Legacy direct/transcript profiles remain unverified under F06.
        // Only the explicit synchronous hook path above supplies source evidence.
        return deny('unsupported');
      } else if (source.harness === 'codex') {
        const turn = meta['x-codex-turn-metadata'];
        callId = typeof meta.callId === 'string' ? meta.callId : '';
        if (
          !callId ||
          callId.length > 256 ||
          !object(turn) ||
          typeof meta.sessionId !== 'string' ||
          !uuid.test(meta.sessionId)
        )
          return deny('identity_source_missing');
        if (meta.sessionId !== turn.session_id || meta.threadId !== turn.thread_id || typeof meta.threadId !== 'string')
          return deny('identity_unverified');
        // Native children retain the ROOT sessionId on this version. Never root-project.
        if (
          meta.threadId !== meta.sessionId ||
          turn.thread_source !== 'user' ||
          turn.parent_thread_id !== undefined ||
          turn.subagent_kind !== undefined
        )
          return deny('identity_unverified');
        if (turn.codex_version !== '0.166.0') return deny('unsupported');
        const file = this.locator.codex(source.rootPath, meta.sessionId);
        if (!file || !realpathSync(file).startsWith(source.rootPath + '/sessions/'))
          return deny('identity_source_missing');
        const first = readBounded(file, 262144).split('\n')[0];
        const header: unknown = JSON.parse(first);
        if (!object(header) || header.type !== 'session_meta' || !object(header.payload))
          return deny('identity_unverified');
        const payload = header.payload;
        if (
          payload.id !== meta.threadId ||
          payload.cli_version !== '0.166.0' ||
          !['cli', 'exec'].includes(payload.source as string)
        )
          return deny('identity_unverified');
        // Only the measured direct exec path is currently evidenced here. TUI source is
        // diagnosable but no product capability is upgraded by this resolver.
        if (payload.source === 'exec' && turn.turn_trigger !== 'exec') return deny('identity_unverified');
        sessionRef = { harness: 'codex', sourceId: source.sourceId, sessionId: meta.threadId, threadId: null };
      } else if (source.harness === 'pi') {
        if (this.profile.callSource?.kind !== 'pi_extension_v1' || !this.piChannel) return deny('unsupported');
        try {
          // The private evidence fd must belong to this exact direct registered parent.
          if (harnessPid !== caller.ppid || parent.pid !== harnessPid) return deny('identity_unverified');
          this.piChannel.verifyHost(this.reader, source.rootPath);
          const frame = await this.piChannel.consume(meta, toolName, source.rootPath);
          this.piChannel.assertLive();
          const currentParent = this.reader.get(harnessPid);
          const currentSelf = this.reader.get(caller.pid);
          this.piChannel.verifyHost(this.reader, source.rootPath);
          if (
            currentSelf.ppid !== harnessPid ||
            currentSelf.procStart !== caller.procStart ||
            currentSelf.pidNamespace !== currentParent.pidNamespace ||
            this.reader.domain().pidDomain !== domain.pidDomain
          )
            return deny('identity_unverified');
          sessionRef = {
            harness: 'pi',
            sourceId: source.sourceId,
            sessionId: frame.snapshot.sessionId,
            threadId: null,
          };
          return {
            ok: true,
            callId: frame.snapshot.toolCallId,
            sessionRef,
            processKey,
            scopePremise,
            evidenceDigest: digest([frame, processKey]),
          };
        } catch (error) {
          // Preserve only protocol-owned Pi refusals; never expose arbitrary errors.
          if (
            error instanceof Refusal &&
            (error.code === 'identity_source_missing' ||
              error.code === 'identity_unverified' ||
              error.code === 'unsupported' ||
              error.code === 'stale_context')
          )
            return deny(error.code);
          return deny('identity_source_missing');
        }
      } else return deny('unsupported');
      // Recheck physical stamps after filesystem evidence; registration alone is no authority.
      if (
        this.reader.get(harnessPid).procStart !== harnessProcStart ||
        this.reader.get(caller.pid).procStart !== caller.procStart
      )
        return deny('identity_unverified');
      return {
        ok: true,
        callId,
        sessionRef,
        processKey,
        evidenceDigest: digest([callId, sessionRef, processKey]),
        scopePremise,
      };
    } catch {
      return deny('identity_source_missing');
    }
  }
}
