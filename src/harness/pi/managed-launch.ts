import { createHash } from 'node:crypto';
import { constants, existsSync, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../../core/canonical.js';
import { launchProfileDigest, resolveLaunchCommand } from '../../core/capabilities.js';
import { makeSourceId } from '../../core/identity.js';
import { snapshotBrief } from '../../core/launch/brief.js';
import { capabilityTemplate, executableIdentity } from '../../core/launch/fingerprint.js';
import type {
  ManagedLaunchPreparation,
  PrepareManagedLaunchOptions,
  PreparedStartPayload,
} from '../../core/launch/types.js';
import { launchDigest } from '../../core/run/control.js';
import { freezeRetirementPolicy, type PolicyRunLaunchInput } from '../../core/run/retirement-policy.js';
import type { LaunchCommand } from '../../core/types/capabilities.js';
import { MAX_PREPARED_PAYLOAD_BYTES, MAX_PROMPT_BYTES } from '../codex/profile.js';
import { PI_EXTENSION_CONTEXT_PROFILE, inspectPiSnapshot } from './delegation-context.js';

/** Selected vendor surface, not a capability grant or an assertion about the installed binary. */
export const PI_MANAGED_PROFILE = 'pi-print-json-1.4.0-4a080252-v1';
function shippedExtension(): string {
  // Both the application and hud-mcp compile this module into their own output
  // trees. Anchor discovery to this installed module, never cwd or environment.
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++, directory = dirname(directory)) {
    const extension = join(directory, 'extensions', 'pi', 'hud-delegate.ts');
    if (existsSync(join(directory, 'package.json')) && existsSync(join(directory, 'bin', 'hud-run'))) return extension;
  }
  throw new Error('pi_managed_extension_unavailable');
}
export const PI_MANAGED_EXTENSION = shippedExtension();
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown): value is string => typeof value === 'string' && !!value && !value.includes('\0');
const authority = (key: string) =>
  key.startsWith('HUD_') || key.startsWith('PI_SESSION_') || key === 'PI_CODING_AGENT_SESSION_DIR';

/** A small explicit CLI surface. Never forward arbitrary positional inputs or a second session selector. */
function managedCommand(
  template: LaunchCommand,
  values: Record<string, string>,
  operation: 'spawn' | 'resume',
  model: string | null,
  effort: string | null
): LaunchCommand {
  if (!template.argv) throw new Error('pi_managed_shell_unsupported');
  const resolved = resolveLaunchCommand(template, values).argv!;
  if (!text(resolved[0]) || resolved[0].includes('=')) throw new Error('invalid_pi_managed_executable');
  const seen = new Set<string>();
  const expected: Record<string, string> = {
    '--session-dir': values.sourceRoot,
    '--mode': 'json',
    '--extension': PI_MANAGED_EXTENSION,
    ...(model !== null ? { '--model': model } : {}),
    ...(effort !== null ? { '--thinking': effort } : {}),
    ...(operation === 'resume' ? { '--session': values.sessionId } : {}),
  };
  const switches = new Set(['--print', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes']);
  for (let index = 1; index < resolved.length; index++) {
    const raw = resolved[index];
    const flag = raw === '-e' ? '--extension' : raw === '-p' ? '--print' : raw;
    if (seen.has(flag)) throw new Error('duplicate_pi_managed_flag');
    seen.add(flag);
    if (switches.has(flag)) continue;
    if (!Object.hasOwn(expected, flag) || resolved[++index] !== expected[flag])
      throw new Error('unsupported_pi_managed_arguments');
  }
  // This first exact profile supports only explicitly selected no-discovery
  // settings. Never silently disable user extensions/skills in another profile.
  for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes'])
    if (!seen.has(flag)) throw new Error('pi_managed_discovery_profile_required');
  return {
    argv: [
      resolved[0],
      '--session-dir',
      values.sourceRoot,
      '--mode',
      'json',
      '--print',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '-e',
      PI_MANAGED_EXTENSION,
      ...(model !== null ? ['--model', model] : []),
      ...(effort !== null ? ['--thinking', effort] : []),
      ...(operation === 'resume' ? ['--session', values.sessionId] : []),
    ],
  };
}

/** Bounded exact-ID discovery; filenames and "latest" ordering never establish identity. */
async function resumeFile(root: string, sessionId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('invalid_pi_resume_session');
  const candidates: string[] = [];
  const directories = [root];
  let count = 0;
  let headers = 0;
  for (let index = 0; index < directories.length; index++) {
    const directory = await fs.opendir(directories[index]);
    for await (const entry of directory) {
      if (++count > 4096) throw new Error('pi_resume_discovery_limit');
      if (index === 0 && entry.isDirectory()) directories.push(join(root, entry.name));
      if (!entry.name.endsWith('.jsonl') || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      if (++headers > 64) throw new Error('pi_resume_header_limit');
      const file = join(directories[index], entry.name);
      try {
        // The existing fd-anchored validator refuses symlinks, nonregular files,
        // path escapes, oversized headers and mismatching recognized native IDs.
        const result = await inspectPiSnapshot(
          {
            profile: PI_EXTENSION_CONTEXT_PROFILE,
            epoch: 'managed-preflight',
            toolCallId: 'managed-preflight',
            toolName: 'delegate_whoami',
            sessionId,
            sessionFile: file,
            sessionDir: root,
          },
          root
        );
        if (result.snapshot.status !== 'ready') continue;
        // Native extension evidence may legitimately use an unknown file format.
        // Disk-only discovery has no such native context: require an actual exact
        // session header, but never gate on the vendor/header version number.
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat({ bigint: true });
          if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== result.identity.file) continue;
          if ((await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== file) continue;
          const buffer = Buffer.alloc(65537);
          let bytes = 0;
          while (bytes < buffer.length) {
            const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
            if (!read.bytesRead) break;
            bytes += read.bytesRead;
            if (buffer.subarray(0, bytes).includes(10)) break;
          }
          const data = buffer.subarray(0, bytes);
          const newline = data.indexOf(10);
          const header = newline < 0 ? data : data.subarray(0, newline);
          if (
            header.length > 65536 ||
            createHash('sha256').update(header).digest('hex') !== result.snapshot.headerDigest
          )
            continue;
          const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(header));
          // A rename/replacement during read must not turn a verified old fd into
          // a resume argv naming a different file. Appended transcript is harmless.
          if ((await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== file) continue;
          const current = await fs.lstat(file, { bigint: true });
          if (!current.isFile() || `${current.dev}:${current.ino}` !== result.identity.file) continue;
          if (parsed?.type === 'session' && parsed.id === sessionId) candidates.push(file);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as Error).message === 'pi_session_header_mismatch') continue;
        // Unrelated malformed entries do not bind. A candidate is selected only
        // by a complete independently validated matching header, never its name.
        continue;
      }
    }
  }
  if (candidates.length !== 1)
    throw new Error(candidates.length ? 'ambiguous_pi_resume_session' : 'pi_resume_session_unavailable');
  return candidates[0];
}

async function optionalConfig(path: string) {
  try {
    const file = await snapshotBrief(path);
    return { path: file.path, sha256: file.sha256 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, sha256: null };
    throw new Error('invalid_pi_managed_configuration');
  }
}

/** Production preparation only. Acceptance, authority, exact capability and dispatch stay in shared services. */
export async function preparePiLaunch(options: PrepareManagedLaunchOptions): Promise<ManagedLaunchPreparation> {
  const profile = structuredClone(options.profile);
  const { operation, mode } = options;
  if (profile.harness !== 'pi') throw new Error('unsupported_harness');
  if (process.platform !== 'linux') throw new Error('unsupported_pi_managed_platform');
  if (mode !== 'headless') throw new Error('visible_launch_not_in_this_build');
  if (profile.host.kind !== 'none' || profile.host.layout !== 'none') throw new Error('unsupported_headless_host');
  if (profile.callSource?.kind !== 'pi_extension_v1' || profile.claimTransport !== 'config_env')
    throw new Error('pi_managed_extension_required');
  if (!isAbsolute(options.cwd) || !isAbsolute(profile.source.root)) throw new Error('absolute_launch_path_required');
  const [cwd, root, brief] = await Promise.all([
    fs.realpath(options.cwd),
    fs.realpath(profile.source.root),
    snapshotBrief(options.briefPath),
  ]);
  if (!(await fs.stat(cwd)).isDirectory() || !(await fs.stat(root)).isDirectory())
    throw new Error('invalid_launch_directory');
  // The official extension's source verifier deliberately rejects aliased roots.
  if (root !== profile.source.root) throw new Error('pi_source_not_canonical');
  profile.source.root = root;
  if (operation === 'spawn' && options.resumeSessionId !== undefined) throw new Error('unexpected_resume_session');
  if (operation === 'resume' && !text(options.resumeSessionId)) throw new Error('resume_session_required');
  const template = operation === 'resume' ? profile.resumeHeadless : profile.headless;
  if (!template) throw new Error('invalid_launch_template');
  const role = options.role ?? null;
  const mapping = role !== null && profile.roles && Object.hasOwn(profile.roles, role) ? profile.roles[role] : null;
  const model = options.model ?? mapping?.model ?? null;
  const effort = options.effort ?? mapping?.effort ?? null;
  for (const value of [role, model, effort]) {
    if (value !== null && (!text(value) || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/.test(value)))
      throw new Error('invalid_role_options');
  }
  if (role !== null && model === null) throw new Error('role_model_unconfigured');
  if (effort !== null && !THINKING.has(effort)) throw new Error('unsupported_pi_thinking');
  const sessionFile = operation === 'resume' ? await resumeFile(root, options.resumeSessionId!) : undefined;
  const values = {
    cwd,
    sourceRoot: root,
    ...(model !== null ? { model } : {}),
    ...(effort !== null ? { effort } : {}),
    ...(sessionFile ? { sessionId: sessionFile } : {}),
  };
  const command = managedCommand(template, values, operation, model, effort);
  const inherited = { ...(options.env ?? process.env), ...profile.env };
  // Never propagate a parent claim, previous extension channel or session hint.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !authority(key)));
  const executable = await executableIdentity(command, env, options.executableIdentity);
  const agentDir = env.PI_CODING_AGENT_DIR ?? (env.HOME ? join(env.HOME, '.pi', 'agent') : null);
  if (!agentDir || !isAbsolute(agentDir)) throw new Error('absolute_pi_agent_directory_required');
  const extension = await snapshotBrief(PI_MANAGED_EXTENSION);
  // The extension always imports the installation's root dist/ closure, even
  // when this preparer runs from hud-mcp's separate emitted module tree.
  const installedPi = join(dirname(dirname(dirname(PI_MANAGED_EXTENSION))), 'dist', 'harness', 'pi');
  const implementation = await Promise.all(
    [
      fileURLToPath(import.meta.url),
      ...['delegation-bridge.js', 'delegation-channel.js', 'delegation-context.js'].map((name) =>
        join(installedPi, name)
      ),
    ].map(async (path) => {
      const file = await snapshotBrief(path);
      return { path: file.path, sha256: file.sha256 };
    })
  );
  const configFingerprint = digest({
    protocol: PI_MANAGED_PROFILE,
    extension: { path: extension.path, sha256: extension.sha256 },
    implementation,
    settings: await Promise.all([
      optionalConfig(join(agentDir, 'settings.json')),
      optionalConfig(join(agentDir, 'models.json')),
      optionalConfig(join(cwd, '.pi', 'settings.json')),
    ]),
    agentDir,
    profileName: profile.name,
    env: Object.fromEntries(Object.entries(profile.env).filter(([key]) => !authority(key))),
  });
  const sourceId = makeSourceId('pi', root);
  const profileDigest = launchProfileDigest(profile);
  const capabilityProfileDigest = launchProfileDigest({
    ...profile,
    env: Object.fromEntries(Object.entries(profile.env).filter(([key]) => !authority(key))),
  });
  const capabilityFingerprint = digest({
    protocol: PI_MANAGED_PROFILE,
    package: { name: '@earendil-works/pi-coding-agent', observedVersion: executable.version },
    executable,
    template: capabilityTemplate(template, {
      sourceRoot: root,
      ...(model !== null ? { model } : {}),
      ...(effort !== null ? { effort } : {}),
    }),
    configFingerprint,
    profileDigest: capabilityProfileDigest,
    sourceId,
    mode,
    operation,
    model,
    effort,
    composedArguments: command.argv!.map((arg) => (arg === sessionFile ? { kind: 'run', name: 'sessionFile' } : arg)),
    input: 'protected-stdin-brief',
    perRunEnv: ['HUD_RUN', 'HUD_LINK', 'HUD_CLAIM', 'HUD_HOME'],
  });
  const prompt = options.prompt ?? '';
  if (prompt.includes('\0') || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error('prompt_too_large');
  const retire = freezeRetirementPolicy(profile.retire, role ?? 'implementer', 10_000, options.retireRecoveryMs);
  const preparation: ManagedLaunchPreparation = {
    harness: 'pi',
    sourceRoot: root,
    profileDigest,
    sourceId,
    cwd,
    brief,
    promptHash: hash(prompt),
    role,
    model,
    effort,
    configFingerprint,
    commandFingerprint: digest({ command, configFingerprint }),
    capabilityRequest(resumeFrom) {
      if (operation === 'resume' && resumeFrom !== 'visible' && resumeFrom !== 'headless')
        throw new Error('resume_from_required');
      return {
        // These bounded snapshots do not prove all user/provider resource
        // discovery. A shipped production cell must not promote partial coverage.
        configurationCoverage: 'partial',
        executableIdentity: { path: executable.resolved, version: executable.version },
        key: {
          harness: 'pi',
          profileDigest: capabilityProfileDigest,
          hostKind: profile.host.kind,
          layout: profile.host.layout,
          mode,
          ...(operation === 'resume' ? { operation: 'resume', resumeFrom: resumeFrom! } : { operation: 'spawn' }),
        },
        sourceId,
        profileFingerprint: capabilityFingerprint,
      };
    },
    forRun(run) {
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(run.runId) ||
        !text(run.linkId) ||
        !text(run.claim) ||
        Buffer.byteLength(run.claim) > 4096 ||
        !isAbsolute(run.hudHome)
      )
        throw new Error('invalid_launch_identity');
      const delivery = Buffer.concat([
        brief.bytes(),
        Buffer.from(
          (prompt ? '\n\n' + prompt : '') +
            '\n\n[HUD delegation]\nCall delegate_whoami before doing this task. ' +
            `Call delegate_report with runId ${JSON.stringify(run.runId)} when reporting the result.\n`
        ),
      ]);
      const input: PolicyRunLaunchInput = {
        runId: run.runId,
        mode: 'headless',
        launch: structuredClone(command),
        cwd,
        sourceId,
        profileDigest,
        stdin: 'brief',
        orphanPolicy: profile.orphan_policy,
        retire,
      };
      const payload: PreparedStartPayload = {
        input,
        briefBase64: delivery.toString('base64'),
        env: {
          ...env,
          HUD_HOME: run.hudHome,
          HUD_RUN: run.runId,
          HUD_LINK: run.linkId,
          HUD_CLAIM: run.claim,
          HUD_MCP_PROFILE: profile.name,
        },
        ...(run.parent ? { parent: structuredClone(run.parent) } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PREPARED_PAYLOAD_BYTES)
        throw new Error('protected_launch_input_too_large');
      return { input, launchDigest: launchDigest(input), payload, deliveredSha256: hash(delivery) };
    },
  };
  return Object.freeze(preparation);
}
