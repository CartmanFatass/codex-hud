import { spawn } from 'node:child_process';
import { resolveCliThinking, SHIPPED_MODELS_CATALOG } from '../models/catalog.js';
import { isModelToken, readModelListCache } from '../roles/model-discovery.js';
import type { RolePlace } from '../roles/roster.js';

const piLevels = SHIPPED_MODELS_CATALOG.harnesses.pi.thinking;
const thinkingOrder = SHIPPED_MODELS_CATALOG.thinkingOrder;
type Model = { provider: string; id: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null> };
const probes = new Map<string, Promise<string[] | undefined>>();

export function launchThinking(hudHome: string, place: Pick<RolePlace, 'harness' | 'agent'>, model: string | null) {
  if (!model || !isModelToken(model)) return;
  if (place.harness === 'cli' && place.agent) {
    const supported = resolveCliThinking(SHIPPED_MODELS_CATALOG, place.agent, model);
    return supported ? [...supported] : undefined;
  }
  if (place.harness !== 'pi') return;
  // The picker's fact can prove a model only supports off. For exact levels,
  // ask pi for the selected model's metadata, offline and without a session.
  const fact = readModelListCache(hudHome)?.piFacts?.[model];
  if (fact?.[2] === false) return ['off'];
  let pending = probes.get(model);
  if (!pending) {
    pending = probe(model);
    probes.set(model, pending);
    void pending.then(() => setTimeout(() => probes.delete(model), 30_000).unref());
  }
  return pending;
}

function probe(model: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const child = spawn('pi', ['--mode', 'rpc', '--no-session', '-ne', '-ns', '--model', model], {
      cwd: '/', env: { ...process.env, PI_OFFLINE: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    let result: string[] | undefined;
    const stop = () => { child.stdin.destroy(); child.stdout.destroy(); child.kill('SIGKILL'); };
    const timer = setTimeout(stop, 3000);
    child.stdin.on('error', stop);
    child.once('error', stop);
    child.once('close', () => { clearTimeout(timer); resolve(result); });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 64 * 1024) return stop();
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          const reply = JSON.parse(line);
          if (reply.id !== 'hud-thinking') continue;
          const m: Model | undefined = reply.data?.model;
          if (m && (model === `${m.provider}/${m.id}` || model === m.id) && typeof m.reasoning === 'boolean') {
            result = m.reasoning ? piLevels.filter((level, i) => {
              const mapped = m.thinkingLevelMap?.[level];
              return mapped !== null && (i < 5 || mapped !== undefined);
            }) : ['off'];
          }
          return stop();
        } catch { /* Ignore startup prose. */ }
      }
    });
    child.stdin.write('{"id":"hud-thinking","type":"get_state"}\n');
  });
}

export function adaptDecisionThinking(picked: string, supported: readonly string[]) {
  const hasOff = supported.includes('off');
  const active = thinkingOrder.filter(level => level !== 'off' && supported.includes(level));
  if (picked === 'none') return hasOff ? 'off' : active[0];
  if (!active.length) return 'off';
  const intents = ['low', 'high', 'max'];
  // Align the endpoints and break a midpoint tie toward stronger thinking.
  return active[Math.ceil(intents.indexOf(picked) * (active.length - 1) / (intents.length - 1))];
}

export function nearestThinking(wanted: string, supported: readonly string[]) {
  const rank = (level: string) => thinkingOrder.indexOf(level as (typeof thinkingOrder)[number]);
  const index = rank(wanted);
  if (index < 0) return supported[0];
  return supported.reduce<string | undefined>((best, candidate) =>
    !best || Math.abs(rank(candidate) - index) < Math.abs(rank(best) - index) ? candidate : best, undefined);
}
