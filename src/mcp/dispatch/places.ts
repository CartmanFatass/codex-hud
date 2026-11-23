/** Role roster, placement and launch planning. */
import { join } from 'node:path';
import { cliKinds } from '../../roles/cli-kinds.js';
import { HarnessSwitchError } from '../../roles/harness-switches.js';
import { roleRegistry, piSwitches, type RolePlace, type Role } from '../../roles/roster.js';
import type { PiOptions, Job, JobRoute } from '../job-contracts.js';
import { hudHome, bundled, json } from '../store/job-store.js';
import { required, type Args } from './context.js';

export function registry(cwd: string) {
  return roleRegistry(hudHome, cwd, process.env, undefined, undefined, bundled);
}

const supportsHeadless = (place: RolePlace) => place.harness === 'pi' ||
  (place.harness === 'cli' && !!cliKinds[place.agent!]?.headless);

function placeOptions(args: Args, configured: RolePlace) {
  const place = { ...configured };
  const invalid = (error?: string) => ({ ok: false, code: 'invalid_arguments', error } as const);
  if (args.mode === 'headless') {
    if (!supportsHeadless(place))
      return invalid('headless mode requires pi, claude or agy');
    if (place.harness === 'cli' && place.args?.some(value => value === '--' ||
        /^(-[cpri]|--(?:continue|conversation|resume|fork-session|session-id|no-session-persistence|print|prompt|prompt-interactive|input-format|output-format))(?:=|$)/.test(value)))
      return invalid('CLI place args cannot override the headless session lifecycle');
  }
  if (args.idle_grace_s !== undefined) {
    if (!Number.isInteger(args.idle_grace_s) || (args.idle_grace_s as number) < 60 || (args.idle_grace_s as number) > 3600)
      return invalid('idle_grace_s must be an integer from 60 to 3600');
    if (place.harness !== 'cli') return invalid(place.harness === 'pi'
      ? "idle_grace_s is CLI-only; pi grace follows the model's cache lifetime inside pi-roles"
      : 'idle_grace_s is CLI-only; browser jobs have no idle grace');
  }
  if (args.kind !== undefined) {
    if (place.harness !== 'bro' || place.tool !== 'jev-flow' || (args.kind !== 'image' && args.kind !== 'video')) return invalid();
    place.kind = args.kind;
  } else if (place.harness === 'bro' && place.tool === 'jev-flow' && !place.kind) place.kind = 'image';
  if (place.harness === 'bro' && (args.model !== undefined || args.thinking !== undefined || args.isolation === 'worktree'))
    return invalid(args.isolation === 'worktree' ? 'worktree isolation is local-only' : undefined);
  if (args.thinking !== undefined) place.thinking = required(args, 'thinking');
  const options: PiOptions = place.harness === 'pi' ? { split: place.split ?? false, pi_args: place.pi_args ?? [] } : {};
  for (const key of piSwitches) {
    const value = args[key];
    if (value !== undefined) {
      if (place.harness !== 'pi' || typeof value !== 'boolean') return invalid();
      options[key] = value;
    } else if (key !== 'skills' && place.harness === 'pi' && place[key] !== undefined) options[key] = place[key];
  }
  if (args.pi_args !== undefined && place.harness !== 'pi') return invalid();
  const piArgs = args.pi_args === undefined ? options.pi_args : args.pi_args;
  if (piArgs !== undefined) {
    if (!Array.isArray(piArgs) || piArgs.length > 128 ||
      piArgs.some((value) => typeof value !== 'string' || value.length > 4096)) return invalid();
    if (piArgs.some((value) => /^--(?:orchestrator|notify)(?:=|$)/.test(value)))
      return invalid('pi_args cannot override --orchestrator or --notify caller binding');
    if (args.role === 'sonic' && piArgs.some(value => value === '--' || /^(-c|-r|--(?:continue|resume|fork|session|no-session|session-id|mode|task-dir|dispatch-slot|role-output))(?:=|$)/.test(value)))
      return invalid('pi_args cannot override the one-shot sonic lifecycle');
    if (args.mode === 'headless' && piArgs.some(value => value === '--' || /^(-c|-r|--(?:no-session|continue|resume|fork|session(?:-id|-dir)?|mode|task-dir|dispatch-slot|role-output|qa-dir|qa-timeout))(?:=|$)/.test(value)))
      return invalid('pi_args cannot override the headless session lifecycle');
    options.pi_args = piArgs;
  }
  return { place, options };
}

// An in-place land retry uses its original worktree but still belongs to the registered main project's roster.
export const roleCwd = (job: Job) => job.worktree?.main_root ?? (job.land_turn ? job.project_root : undefined) ?? job.cwd;
export const piOptionKeys = [...piSwitches, 'pi_args'] as const;
export const placementOverrides = ['preset', 'on', 'model', 'thinking'] as const;
export const hasPiPlacement = (args: unknown) => Array.isArray(args) && args.some(arg => typeof arg === 'string' && /^--(?:models?|provider|thinking)(?:=|$)/.test(arg));
export const replayOptions = ['mode', 'on', 'model', 'thinking', 'isolation', 'idle_grace_s', 'kind', 'context_files', ...piOptionKeys] as const;

const matchPlace = (p: RolePlace, target: RolePlace) =>
  p.harness === target.harness &&
  (target.harness !== 'cli' || p.agent === target.agent) &&
  (target.harness !== 'bro' || (p.tool === target.tool && (!target.provider || p.provider === target.provider)));

export function argsForPlace(args: Args, place: RolePlace, retryInput?: Args) {
  if (!retryInput) return args;
  const compatible = { ...args };
  const unused = [...(place.harness === 'pi' ? [] : piOptionKeys),
    ...(place.harness === 'cli' ? [] : ['idle_grace_s']),
    ...(place.harness === 'bro' && place.tool === 'jev-flow' ? [] : ['kind'])];
  for (const key of unused) if (retryInput[key] === undefined) delete compatible[key];
  return compatible;
}

export function harnessesSourceFor(onName: string | null): string {
  let overrideHarnesses: Record<string, { model?: string }> | null = null;
  if (onName) {
    try {
      overrideHarnesses = json<Record<string, { model?: string }>>(join(hudHome, 'harnesses.json'));
    } catch {
      overrideHarnesses = null;
    }
  }
  return onName && overrideHarnesses?.[onName]?.model !== undefined
    ? join(hudHome, 'harnesses.json')
    : join(bundled, 'harnesses.json');
}

type Registry = ReturnType<typeof registry>;
type Assignment = ReturnType<Registry['assignment']>;

export function launchPlan(found: Registry, chain: Role, now: number, args: Args,
  routing: ReturnType<Registry['routing']>, onEntry: RolePlace | undefined, retryInput: Args | undefined,
  route?: JobRoute, land = false) {
  const model = typeof args.model === 'string' ? args.model : undefined;
  const preset = typeof args.preset === 'string' ? args.preset : undefined;
  const choice = onEntry ? { run: [{ ...chain.run.find(p => matchPlace(p, onEntry)), ...onEntry }] }
    : preset !== undefined ? { preset } : undefined;
  const standard = found.assignment(chain, now, route ? undefined : model, routing, route ? undefined : choice,
    !!retryInput && retryInput.model === undefined);
  const tierPreset = route && chain.routing?.[route.tier]?.preset;
  const tier = !route || route.tier === 'standard' ? standard
    : tierPreset && chain.presets?.some(p => p.name === tierPreset)
      ? found.assignment(chain, now, undefined, routing, { preset: tierPreset }) : undefined;
  const explicit = args.mode !== undefined;
  const entries = (effective: Assignment, route?: JobRoute) => effective.places.flatMap(candidate => {
    if ((!land && !effective.available) || (candidate.state !== 'active' && candidate.state !== 'standby') ||
      (land && candidate.place.harness === 'bro')) return [];
    let applied = route;
    let launchArgs = argsForPlace(args, candidate.place, retryInput);
    if (route) {
      // A prior capability downgrade still represents a headless choice on retries and queued starts.
      const wantsHeadless = route.mode === 'headless' || !!route.mode_reason;
      const autoHeadless = !explicit && wantsHeadless && chain.can_continue && supportsHeadless(candidate.place);
      const mode = args.mode === 'headless' || autoHeadless ? 'headless' : 'tab';
      const { mode_reason: _prior, ...intent } = route;
      applied = { ...intent, mode, ...(!explicit && wantsHeadless && mode === 'tab' ? {
        mode_reason: 'Selected place does not support headless for this role; using a tab',
      } : {}) };
      if (autoHeadless) launchArgs = { ...launchArgs, mode: 'headless' };
    }
    return [{ candidate, effective, route: applied, prepared: placeOptions(launchArgs, candidate.place) }];
  });
  const preferred = tier ? entries(tier, route) : [];
  const modeFallback = route?.tier === 'standard' && !explicit && preferred.some(entry => entry.route?.mode === 'headless');
  const fallback: JobRoute | undefined = route && (route.tier !== 'standard' || modeFallback) ? {
    ...route, tier: 'standard', mode: args.mode === 'headless' ? 'headless' : 'tab', mode_reason: undefined,
    fallback: modeFallback ? 'Cannot launch headless; using standard in a tab' : `${route.tier} tier has no usable place; using standard`,
  } : undefined;
  // On the same chain, tab-only candidates already had their tab attempt.
  const all = fallback ? [...preferred, ...entries(standard, fallback).filter(({ candidate }) => !modeFallback || supportsHeadless(candidate.place))] : preferred;
  const candidates = route || args.mode === 'headless' ? all.filter(entry => !('code' in entry.prepared)) : all;
  return { candidates, error: all.find(entry => 'code' in entry.prepared)?.prepared,
    effective: candidates[0]?.effective ?? standard, route: candidates[0]?.route ?? fallback ?? route, fallback };
}

export function harnessSwitchFailure(error: HarnessSwitchError) {
  return { ok: false, code: error.code, error: error.message, path: error.path };
}

export function compactAssignment(assignment: ReturnType<ReturnType<typeof registry>['assignment']>) {
  const { role, instructions, available, can_continue, runs_on, model, thinking, reason, places,
    preset, preset_missing } = assignment;
  const place = runs_on && {
    harness: runs_on.harness,
    pi_role: runs_on.pi_role,
    agent: runs_on.agent,
    tool: runs_on.tool,
    provider: runs_on.provider,
    kind: runs_on.kind,
    effort: runs_on.effort,
    model: model ?? undefined,
    thinking: thinking ?? undefined,
  };
  return {
    role, available, can_continue, runs_on: place,
    ...(preset ? { preset } : {}),
    ...(preset_missing ? { preset_missing } : {}),
    places: places.map(({ index, state, off_by, until, missing, provider, provider_source }) =>
      ({ index, state, off_by, until, missing, provider, provider_source })),
    ...(instructions && instructions !== role && instructions !== runs_on?.pi_role ? { instructions } : {}),
    ...(reason ? { reason } : {}),
  };
}
