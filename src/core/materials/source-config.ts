/** Explicit F4 source permissions. This module never writes policy or imports legacy settings. */
import * as fs from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { modelHttpRequest, type ModelApi } from '../../collectors/small-model.js';
import { outboundDecision, parseOutboundPolicy } from '../export.js';
import { sessionRefKey, validateSessionRef } from '../identity.js';
import type { SessionRef } from '../types/identity.js';
import type { OutboundPolicy } from '../types/export.js';
import { type MaterialAuthority, type MaterialScope, type ResolvedRecipient } from './index.js';
import { resolveRecipient } from './recipient.js';

export class DigestFailure extends Error {
  constructor(readonly reason: string, readonly exitCode = 4) {
    super(reason);
  }
}
const fail = (reason = 'source_configuration_invalid'): never => { throw new DigestFailure(reason); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: unknown, expected: string[]): asserts v is Record<string, unknown> {
  if (!object(v) || Object.keys(v).length !== expected.length || expected.some((k) => !Object.hasOwn(v, k))) fail();
}
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\x00-\x1f\x7f-\x9f]/.test(v);
export interface SourceModelConfig {
  schemaVersion: 1;
  sourceId: string;
  revision: number;
  connection: { backend: 'off' } | {
    backend: 'api'; base: string; model: string; account: string; keyEnv: string | null; reasoning: boolean;
  };
  delegatedDigest: { enabled: boolean; paused: boolean; language: 'en' | 'zh'; hourlyCap: number };
  materials: Array<{ ref: SessionRef; origin: 'delegated'; purpose: 'digest'; fields: ['result'] }>;
}
export function parseSourceModelConfig(raw: unknown, sourceId: string): SourceModelConfig {
  keys(raw, ['schemaVersion', 'sourceId', 'revision', 'connection', 'delegatedDigest', 'materials']);
  if (!/^[a-f0-9]{64}$/.test(sourceId) || raw.schemaVersion !== 1 || raw.sourceId !== sourceId ||
      !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1) fail();
  const c = raw.connection;
  if (object(c) && c.backend === 'off') keys(c, ['backend']);
  else {
    keys(c, ['backend', 'base', 'model', 'account', 'keyEnv', 'reasoning']);
    if (c.backend !== 'api' || !text(c.base, 2048) || !text(c.model, 256) || !text(c.account, 128) ||
        typeof c.reasoning !== 'boolean' ||
        !(c.keyEnv === null || (typeof c.keyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(c.keyEnv))) ||
        (c.keyEnv === null ? c.account !== 'accountless' : c.account === 'accountless')) fail();
  }
  const d = raw.delegatedDigest;
  keys(d, ['enabled', 'paused', 'language', 'hourlyCap']);
  if (typeof d.enabled !== 'boolean' || typeof d.paused !== 'boolean' || (d.language !== 'en' && d.language !== 'zh') ||
      !Number.isSafeInteger(d.hourlyCap) || Number(d.hourlyCap) < 1 || Number(d.hourlyCap) > 1000) fail();
  if (!Array.isArray(raw.materials) || raw.materials.length > 256) fail();
  const seen = new Set<string>();
  for (const entry of raw.materials as unknown[]) {
    keys(entry, ['ref', 'origin', 'purpose', 'fields']);
    keys(entry.ref, ['harness', 'sourceId', 'sessionId', 'threadId']);
    const ref = entry.ref as unknown as SessionRef;
    try { validateSessionRef(ref); } catch { fail(); }
    if (ref.sourceId !== sourceId || !text(ref.sessionId, 1024) || ref.sessionId === '*' ||
        !(ref.threadId === null || (text(ref.threadId, 1024) && ref.threadId !== '*')) ||
        entry.origin !== 'delegated' || entry.purpose !== 'digest' ||
        !Array.isArray(entry.fields) || entry.fields.length !== 1 || entry.fields[0] !== 'result') fail();
    const key = sessionRefKey(ref);
    if (seen.has(key)) fail();
    seen.add(key);
  }
  return raw as unknown as SourceModelConfig;
}

/** Real same-uid paths only. Existing unsafe entries are refused, never repaired. */
export function privateIdentity(file: string, directory: boolean): string {
  const st = fs.lstatSync(file);
  if (!isAbsolute(file) || fs.realpathSync(file) !== file || process.getuid?.() !== process.geteuid?.() ||
      st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.isSymbolicLink() ||
      (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) fail('source_path_unsafe');
  return `${st.dev}:${st.ino}`;
}
function fileStamp(st: fs.Stats): string {
  return `${st.dev}:${st.ino}:${st.mode}:${st.uid}:${st.nlink}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}
export function readPrivateJson(file: string): unknown {
  privateIdentity(file, false);
  const before = fs.lstatSync(file);
  if (before.size > 65536) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (fileStamp(opened) !== fileStamp(before)) fail('source_changed');
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > 65536 || size !== opened.size || fileStamp(fs.fstatSync(fd)) !== fileStamp(opened) ||
        fileStamp(fs.lstatSync(file)) !== fileStamp(opened)) fail('source_changed');
    privateIdentity(file, false);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } finally { fs.closeSync(fd); }
}

export interface SourceSnapshot {
  readonly config: SourceModelConfig;
  readonly api: ModelApi | null;
  readonly recipient: ResolvedRecipient | null;
  readonly endpoint: string | null;
  readonly runtimeDir: string;
  readonly authority: MaterialAuthority;
  readiness(ref: SessionRef): string;
  current(): boolean;
  prepareRuntime(): void;
}
/** Capture once; every failed observation permanently invalidates this invocation. */
export function captureSource(home: string, sourceId: string, env: NodeJS.ProcessEnv, targetCurrent: () => boolean): SourceSnapshot {
  if (!/^[a-f0-9]{64}$/.test(sourceId)) fail();
  const dirs = [home, join(home, 'sources'), join(home, 'sources', sourceId)];
  const pins = dirs.map((dir) => privateIdentity(dir, true));
  const dir = dirs[2];
  const config = parseSourceModelConfig(readPrivateJson(join(dir, 'model.json')), sourceId);
  const modelMeaning = JSON.stringify(config);
  const c = config.connection;
  const credential = c.backend === 'api' && c.keyEnv !== null ? env[c.keyEnv] : '';
  if (c.backend === 'api' && c.keyEnv !== null && (typeof credential !== 'string' || !credential.trim()))
    fail('credential_unavailable');
  const api: ModelApi | null = c.backend === 'api'
    ? { base: c.base, model: c.model, key: credential!, reasoning: c.reasoning } : null;
  const http = api && modelHttpRequest(api, { feature: 'digest', system: '', prompt: '' }, {});
  const recipient = http && !('error' in http) && c.backend === 'api'
    ? resolveRecipient({ backend: 'api', endpoint: http.url, model: JSON.parse(http.body).model }, c.account) : null;
  if (api && !recipient) fail('recipient_unavailable');
  const endpoint = http && !('error' in http) ? new URL(http.url).href : null;
  // Missing outbound policy is a readable plan refusal, never an implicit allow.
  let policy: OutboundPolicy | null = null;
  try { policy = parseOutboundPolicy(readPrivateJson(join(dir, 'outbound.json'))); } catch { /* default deny */ }
  if (policy?.sourceId !== sourceId) policy = null;
  const policyMeaning = JSON.stringify(policy);
  let invalid = false;
  const runtimeDir = join(dir, 'model-runtime-v1');
  const runtimePins = new Map<string, string>();
  let runtimeReady = false;
  function checkRuntime(): void {
    let entries = 0;
    const walk = (directory: string, depth: number): void => {
      if (depth > 8 || ++entries > 4096) fail('runtime_unsafe');
      const id = privateIdentity(directory, true);
      const old = runtimePins.get(directory);
      if (old !== undefined && old !== id) fail('runtime_unsafe');
      runtimePins.set(directory, id);
      for (const name of fs.readdirSync(directory)) {
        if (++entries > 4096) fail('runtime_unsafe');
        const file = join(directory, name);
        try {
          if (fs.lstatSync(file).isDirectory()) walk(file, depth + 1);
          else privateIdentity(file, false);
        } catch (error) {
          // Peer tickets and atomic temporary files may legitimately disappear.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    };
    walk(runtimeDir, 0);
    for (const [directory, id] of runtimePins) if (privateIdentity(directory, true) !== id) fail('runtime_unsafe');
  }
  function current(): boolean {
    if (invalid) return false;
    try {
      if (!targetCurrent() || dirs.some((d, i) => privateIdentity(d, true) !== pins[i])) throw new Error();
      const next = parseSourceModelConfig(readPrivateJson(join(dir, 'model.json')), sourceId);
      if (JSON.stringify(next) !== modelMeaning ||
          (c.backend === 'api' && c.keyEnv !== null && env[c.keyEnv] !== credential)) throw new Error();
      const nextPolicy = parseOutboundPolicy(readPrivateJson(join(dir, 'outbound.json')));
      if (!nextPolicy || nextPolicy.sourceId !== sourceId || JSON.stringify(nextPolicy) !== policyMeaning) throw new Error();
      if (runtimeReady) checkRuntime();
      return true;
    } catch { invalid = true; return false; }
  }
  const scope: MaterialScope = {
    revision: config.revision,
    local: true,
    allows: (subject, purpose) => current() && subject.sourceId === sourceId && subject.origin === 'delegated' &&
      subject.field === 'result' && purpose === 'digest' && config.materials.some((entry) =>
        sessionRefKey(entry.ref) === sessionRefKey(subject.ref)),
  };
  const authority: MaterialAuthority = {
    scope: (source) => source === sourceId && current() ? scope : null,
    policy: (source) => source === sourceId && current() ? policy : null,
  };
  function readiness(ref: SessionRef): string {
    if (config.connection.backend === 'off') return 'backend_off';
    if (!config.delegatedDigest.enabled) return 'feature_disabled';
    if (config.delegatedDigest.paused) return 'feature_paused';
    if (!config.materials.some((entry) => sessionRefKey(entry.ref) === sessionRefKey(ref))) return 'material_scope_denied';
    if (!recipient || outboundDecision(policy, { sourceId, purpose: 'digest', recipientId: recipient.recipientId }) !== 'allow')
      return 'outbound_denied';
    return current() ? 'ready' : 'source_changed';
  }
  return {
    config, api, recipient, endpoint, runtimeDir, authority, readiness, current,
    prepareRuntime() {
      if (!current()) fail('source_changed');
      try {
        try { fs.mkdirSync(runtimeDir, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        checkRuntime();
        runtimeReady = true;
        if (!current()) fail('source_changed');
      } catch { invalid = true; fail('runtime_unsafe'); }
    },
  };
}
