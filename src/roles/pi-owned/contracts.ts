/** Immutable worker inputs. Execution and pi SDKs do not belong in this module. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DispatchRole, OwnedDispatchV2 } from '../pi-dispatch.js';
import type { PiHelperBindings } from '../routing.js';

// Inherited worker contract, not user-configurable policy.
export const QA_WAIT_MS = 1_200_000;
export const QA_POLL_MS = 2_000;
export const QA_TIMEOUT_TEXT = 'proceed with your proposed default';
export const MAX_REVIEW_ROUNDS = 3;
export const MAX_SONIC_CALLS = 10;
export const MAX_CONCURRENT_HELPERS = 1;
export const WARM_BUDGET_USD = 0.5;
export const CONTRACT_MAX_BYTES = 64 * 1024;
export const RESOURCE_MAX_BYTES = 256 * 1024;
export const PI_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const WORKER_ENTRY = 'integrations/pi/worker.ts';
export const HELPER_SKILL = 'integrations/pi/skills/helper-pane/SKILL.md';
export const ROLE_TOOLS = Object.freeze({
  implementer: 'read,bash,edit,write,grep,find,ls,ask_orchestrator,call_sonic,call_reviewer',
  sonic: 'read,bash,edit,write,grep,find,ls,ask_orchestrator',
  reviewer: 'read,bash,write,grep,find,ls,ask_orchestrator,call_sonic',
  architect: 'read,bash,write,grep,find,ls,ask_orchestrator,call_sonic',
});
export type OwnedErrorCode =
  | 'invalid_contract'
  | 'unsafe_path'
  | 'file_too_large'
  | 'release_unavailable'
  | 'resource_mismatch'
  | 'herdr_pi_integration_missing'
  | 'helper_ineligible'
  | 'helper_busy'
  | 'helper_limit'
  | 'qa_exhausted';
export class OwnedContractError extends Error {
  readonly name = 'OwnedContractError';
  constructor(
    readonly code: OwnedErrorCode,
    readonly field: string
  ) {
    super(`${code}: ${field}`);
  }
}
export function refuse(code: OwnedErrorCode, field: string): never {
  throw new OwnedContractError(code, field);
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function singleLine(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value);
}
export function canonicalPath(value: unknown): value is string {
  return singleLine(value) && isAbsolute(value) && resolve(value) === value;
}
export function roleResource(role: DispatchRole): string {
  return `integrations/pi/roles/${role}.md`;
}
export function slotPaths(directory: string, slot: string) {
  if (slot !== 'primary' && !/^(?:sonic-(?:[1-9]|10)|review-[1-3])$/.test(slot)) refuse('invalid_contract', 'slot');
  const primary = slot === 'primary';
  return {
    contract: join(directory, '.dispatch', slot, 'contract.json'),
    brief: join(
      directory,
      primary
        ? 'brief.md'
        : slot.startsWith('sonic-')
          ? `sonic_brief-${slot.slice(6)}.md`
          : `review_brief-${slot.slice(7)}.md`
    ),
    output: join(directory, primary ? 'report.md' : `${slot}.md`),
    qa: join(directory, 'qa'),
    sessions: join(directory, 'sessions'),
  };
}
export interface ReleaseInventory {
  /** Supplied by the installed-release owner, never decoded from task content. */
  readonly id: string;
  readonly root: string;
  readonly resources: Readonly<Record<string, string>>;
}
export interface SlotContract {
  schema: 1;
  job: string;
  slot: string;
  role: DispatchRole;
  task_dir: string;
  cwd: string;
  brief_path: string;
  output_path: string;
  qa_dir: string;
  session_dir: string;
  session_id: string;
  release: { id: string; root: string };
  role_resource: { path: string; sha256: string };
  model: string;
  effort: string;
  allowed_write_paths: string[];
  helpers?: PiHelperBindings;
  parent_slot?: string;
  read_only?: boolean;
  herdr_integration: { path: string; version: number };
}
export interface ContractContext {
  jobDirectory: string;
  cwd: string;
  release: ReleaseInventory;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) refuse('invalid_contract', field);
}
/** Reject symlinks at every existing component; absent descendants are permitted for future output. */
export function assertPath(path: string, privateRoot?: string, mustExist = false): void {
  if (!canonicalPath(path)) refuse('unsafe_path', 'path');
  if (privateRoot && path !== privateRoot && !path.startsWith(privateRoot + '/')) refuse('unsafe_path', 'path');
  let cursor = path;
  let missing = false;
  for (;;) {
    try {
      const info = fs.lstatSync(cursor);
      if (info.isSymbolicLink() || (!info.isDirectory() && cursor !== path)) refuse('unsafe_path', 'path');
      if (
        privateRoot &&
        (cursor === privateRoot || cursor.startsWith(privateRoot + '/')) &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      )
        refuse('unsafe_path', 'permissions');
      if (cursor === path && !info.isDirectory() && !info.isFile()) refuse('unsafe_path', 'path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing = true;
      if (mustExist || cursor === privateRoot) refuse('unsafe_path', 'missing_path');
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!missing && fs.realpathSync(path) !== path) refuse('unsafe_path', 'path');
}
/** fd-bound, bounded regular-file read. Private job files must be owner-only. */
export function readOwnedText(path: string, maxBytes: number, privateRoot?: string): string {
  assertPath(path, privateRoot, true);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || (privateRoot && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())))
      refuse('unsafe_path', 'file');
    if (info.size > maxBytes) refuse('file_too_large', 'file');
    const buffer = Buffer.alloc(maxBytes + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > maxBytes) refuse('file_too_large', 'file');
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
function binding(value: unknown, sonic: boolean): void {
  if (!record(value)) refuse('invalid_contract', 'binding');
  keys(value, ['model', 'effort'], 'binding');
  if (
    !singleLine(value.model) ||
    !singleLine(value.effort) ||
    !(sonic ? ['low', 'high'] : (PI_EFFORTS as readonly string[])).includes(value.effort)
  )
    refuse('invalid_contract', 'binding');
}
export function validateSlotContract(raw: unknown, context: ContractContext): SlotContract {
  if (!record(raw)) refuse('invalid_contract', 'contract');
  keys(
    raw,
    [
      'schema',
      'job',
      'slot',
      'role',
      'task_dir',
      'cwd',
      'brief_path',
      'output_path',
      'qa_dir',
      'session_dir',
      'session_id',
      'release',
      'role_resource',
      'model',
      'effort',
      'allowed_write_paths',
      'helpers',
      'parent_slot',
      'read_only',
      'herdr_integration',
    ],
    'contract'
  );
  const directory = context.jobDirectory;
  if (
    !canonicalPath(directory) ||
    !canonicalPath(context.cwd) ||
    raw.schema !== 1 ||
    !/^j[a-f0-9]{16}$/.test(String(raw.job)) ||
    raw.job !== basename(directory) ||
    raw.task_dir !== directory ||
    raw.cwd !== context.cwd ||
    typeof raw.role !== 'string' ||
    !['implementer', 'sonic', 'reviewer', 'architect'].includes(raw.role) ||
    typeof raw.slot !== 'string'
  )
    refuse('invalid_contract', 'identity');
  const role = raw.role as DispatchRole;
  const slot = raw.slot;
  if (
    slot !== 'primary' &&
    !((role === 'sonic' && /^sonic-([1-9]|10)$/.test(slot)) || (role === 'reviewer' && /^review-[1-3]$/.test(slot)))
  )
    refuse('invalid_contract', 'slot');
  if (raw.parent_slot !== undefined) {
    if (
      slot === 'primary' ||
      typeof raw.parent_slot !== 'string' ||
      !(raw.parent_slot === 'primary' || /^review-[1-3]$/.test(raw.parent_slot))
    )
      refuse('invalid_contract', 'parent_slot');
  }
  if (raw.read_only !== undefined && (typeof raw.read_only !== 'boolean' || role !== 'sonic' || slot === 'primary'))
    refuse('invalid_contract', 'read_only');
  const paths = slotPaths(directory, slot);
  if (
    raw.brief_path !== paths.brief ||
    raw.output_path !== paths.output ||
    raw.qa_dir !== paths.qa ||
    raw.session_dir !== paths.sessions ||
    !singleLine(raw.session_id) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.session_id)
  )
    refuse('invalid_contract', 'paths');
  assertPath(directory, directory, true);
  assertPath(context.cwd, undefined, true);
  if (!fs.statSync(directory).isDirectory() || !fs.statSync(context.cwd).isDirectory())
    refuse('unsafe_path', 'directory');
  for (const path of [paths.contract, paths.brief, paths.output, paths.qa, paths.sessions]) assertPath(path, directory);
  for (const [path, isDirectory] of [
    [paths.output, false],
    [paths.contract, false],
    [paths.qa, true],
    [paths.sessions, true],
  ] as const) {
    if (fs.existsSync(path) && fs.statSync(path).isDirectory() !== isDirectory) refuse('unsafe_path', 'path_type');
  }
  readOwnedText(paths.brief, CONTRACT_MAX_BYTES, directory);
  binding({ model: raw.model, effort: raw.effort }, role === 'sonic' && slot !== 'primary');
  if (
    !Array.isArray(raw.allowed_write_paths) ||
    raw.allowed_write_paths.length !== 1 ||
    raw.allowed_write_paths[0] !== paths.output
  )
    refuse('invalid_contract', 'allowed_write_paths');
  if (slot === 'primary') {
    if (!record(raw.helpers)) refuse('invalid_contract', 'helpers');
    keys(raw.helpers, ['sonic', 'reviewer'], 'helpers');
    binding(raw.helpers.sonic, true);
    binding(raw.helpers.reviewer, false);
  } else if (raw.helpers !== undefined) refuse('invalid_contract', 'nested_helpers');
  const release = context.release;
  if (
    !record(raw.release) ||
    raw.release.id !== release.id ||
    raw.release.root !== release.root ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(release.id) ||
    !canonicalPath(release.root)
  )
    refuse('release_unavailable', 'release');
  keys(raw.release, ['id', 'root'], 'release');
  const relativeRole = roleResource(role);
  if (
    !record(raw.role_resource) ||
    raw.role_resource.path !== join(release.root, relativeRole) ||
    raw.role_resource.sha256 !== release.resources[relativeRole]
  )
    refuse('resource_mismatch', 'role_resource');
  keys(raw.role_resource, ['path', 'sha256'], 'role_resource');
  for (const relative of [WORKER_ENTRY, relativeRole, ...(role === 'implementer' ? [HELPER_SKILL] : [])]) {
    const hash = release.resources[relative];
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) refuse('resource_mismatch', relative);
    const text = readOwnedText(join(release.root, relative), RESOURCE_MAX_BYTES);
    if (createHash('sha256').update(text).digest('hex') !== hash) refuse('resource_mismatch', relative);
  }
  const integration = raw.herdr_integration;
  if (
    !record(integration) ||
    !canonicalPath(integration.path) ||
    !Number.isSafeInteger(integration.version) ||
    Number(integration.version) < 1
  )
    refuse('herdr_pi_integration_missing', 'herdr integration install pi');
  keys(integration, ['path', 'version'], 'herdr_integration');
  const header = readOwnedText(integration.path, RESOURCE_MAX_BYTES);
  if (
    !/HERDR_INTEGRATION_ID=pi\b/.test(header) ||
    !new RegExp(`HERDR_INTEGRATION_VERSION=${integration.version}\\b`).test(header)
  )
    refuse('herdr_pi_integration_missing', 'herdr integration install pi');
  // Clone so the caller cannot change a validated input through an alias.
  // SAFETY: every SlotContract field was validated above; the clone breaks caller aliases.
  return structuredClone(raw) as unknown as SlotContract;
}
export function readSlotContract(file: string, context: ContractContext): SlotContract {
  const text = readOwnedText(file, CONTRACT_MAX_BYTES, context.jobDirectory);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    refuse('invalid_contract', 'json');
  }
  const contract = validateSlotContract(raw, context);
  if (file !== slotPaths(context.jobDirectory, contract.slot).contract) refuse('invalid_contract', 'contract_path');
  return contract;
}
/** Inventory validation is separate from the lightweight receipt shape codec. */
export function validateOwnedDispatch(dispatch: OwnedDispatchV2, context: ContractContext): SlotContract {
  if (
    dispatch.contract_version !== 2 ||
    dispatch.transport !== 'hud-owned' ||
    dispatch.release.id !== context.release.id ||
    dispatch.release.root !== context.release.root ||
    dispatch.contract_path !== slotPaths(context.jobDirectory, 'primary').contract
  )
    refuse('release_unavailable', 'dispatch');
  const contract = readSlotContract(dispatch.contract_path, context);
  if (contract.slot !== 'primary' || contract.role !== dispatch.role) refuse('invalid_contract', 'dispatch_role');
  return contract;
}
