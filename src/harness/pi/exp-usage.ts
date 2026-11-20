import { createHash } from 'node:crypto';
import { appendExpEvent, type ExpCost, type ExpTokens } from '../../collectors/exp-ledger.js';
import { readExpConfig } from '../../collectors/exp-store.js';
import { expMicros, type ExpAccount } from '../../exp-config.js';
import { experimentsEnabled } from '../../settings.js';
import type { PiPackageContext } from './package-context.js';
import { piExpAccount } from './exp-route.js';

const tokenFields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
type Rates = Partial<ExpTokens>;
export type ExpModelCost = Rates & { tiers?: readonly (Rates & { inputTokensAbove: number })[] };
interface RequestModel {
  id: string;
  cost?: ExpModelCost;
}
interface PiUsage extends ExpTokens {
  cacheWrite1h?: number;
  cost?: Rates & { total?: number; totalFromProvider?: boolean };
}
interface Reply {
  role?: string;
  stopReason?: string;
  provider?: string;
  api?: string;
  model?: string;
  responseId?: string;
  usage?: PiUsage;
}
type Cost = ExpCost extends infer E ? (E extends ExpCost ? Omit<E, 'id'> : never) : never;
const stableId = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const validId = (id: unknown): id is string => typeof id === 'string' && id.length <= 512 && id.trim().length > 0;

function estimate(usage: PiUsage, tokens: ExpTokens, requestRates?: ExpModelCost): number {
  // Pi can price the actual routed model at the transport (including service tiers). Its unmarked total
  // is not an invoice; use the catalog-derived itemization, not a bare, ambiguous number.
  const parts = tokenFields.map((field) => usage.cost?.[field]);
  if (parts.every((part): part is number => typeof part === 'number' && part >= 0 && Number.isFinite(part))) {
    const micros = parts.reduce((sum, part) => sum + part, 0) * 1_000_000;
    if (micros > 0) return micros;
  }
  if (!requestRates) return 0;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  let rates: Rates = requestRates;
  let above = -1;
  for (const tier of requestRates.tiers ?? []) {
    if (prompt > tier.inputTokensAbove && tier.inputTokensAbove > above) {
      above = tier.inputTokensAbove;
      rates = tier;
    }
  }
  const longWrite = usage.cacheWrite1h ?? 0;
  if (!expMicros(longWrite) || longWrite > tokens.cacheWrite) return 0;
  let micros = 0;
  // Pi's normalized input already excludes cache reads and writes. Model rates are USD / million tokens.
  // Like Pi, price Anthropic's one-hour writes at 2x input, not as ordinary cache writes.
  const billable = { ...tokens, input: tokens.input + 2 * longWrite, cacheWrite: tokens.cacheWrite - longWrite };
  for (const field of tokenFields) {
    const count = billable[field];
    if (!count) continue;
    const rate = rates[field];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return 0;
    micros += count * rate;
  }
  return micros;
}

function completed(reply: Reply, model: RequestModel | undefined, now: number): Cost | undefined {
  if (
    !['stop', 'length', 'toolUse'].includes(reply.stopReason ?? '') ||
    typeof reply.model !== 'string' ||
    !/^[a-z0-9][a-z0-9._:/-]{0,159}$/i.test(reply.model) ||
    !reply.usage
  )
    return;
  const { input, output, cacheRead, cacheWrite, cost } = reply.usage;
  const tokens = { input, output, cacheRead, cacheWrite };
  if (!tokenFields.every((field) => expMicros(tokens[field]))) return;
  const fields = { type: 'cost' as const, at: new Date(now).toISOString(), model: reply.model, tokens };
  if (cost?.totalFromProvider === true && positive(cost.total)) {
    const micros = Math.round(cost.total * 1_000_000);
    if (expMicros(micros)) return { ...fields, source: 'reported', costMicros: micros };
  }
  const raw = estimate(reply.usage, tokens, model?.id === reply.model ? model.cost : undefined);
  const micros = Math.round(raw);
  return positive(raw) && expMicros(micros)
    ? { ...fields, source: 'priced', costMicros: micros }
    : { ...fields, source: 'unpriced', costMicros: null };
}

/** Delegate entry only: no dependency on TUI, footer, or persisted history scans. */
export function piExpUsage(hudHome: string, env: NodeJS.ProcessEnv) {
  const activeGrants = () => {
    try {
      if (experimentsEnabled(env)) return readExpConfig(hudHome).grants;
    } catch {
      // Unknown settings do not authorize collection.
    }
  };
  const record = async (account: ExpAccount, cost: Cost, id: string) => {
    try {
      await appendExpEvent(hudHome, account, { ...cost, id }, () => activeGrants()?.[account].enabled === true);
    } catch {
      // Accounting is best-effort and must never interrupt Pi's request/session.
    }
  };
  let request:
    { session: string; oapiEnabled: boolean; oapiModel?: RequestModel; anthropicModel?: RequestModel } | undefined;
  let pending: { account: ExpAccount; session: string; cost: Cost } | undefined;
  return {
    requestStart(_event: unknown, ctx: PiPackageContext) {
      request = undefined;
      pending = undefined;
      const grants = activeGrants();
      if (!grants) return;
      const oapiEnabled = grants['openai-api'].enabled;
      const model = ctx.model;
      const anthropic = grants['anthropic-api'].enabled && piExpAccount(ctx) === 'anthropic-api';
      if (!oapiEnabled && !anthropic) return;
      const capture = () => model && { id: model.id, cost: structuredClone(model.cost) };
      request = {
        session: ctx.sessionManager.getSessionId(),
        // A virtual selection can route to oapi; the completed reply proves that provider, not the selected model.
        oapiEnabled,
        oapiModel: model?.provider === 'oapi' ? capture() : undefined,
        anthropicModel: anthropic ? capture() : undefined,
      };
    },
    messageEnd(event: unknown, ctx: PiPackageContext) {
      const reply = (event as { message?: Reply })?.message;
      if (reply?.role !== 'assistant') return;
      const started = request;
      request = undefined;
      if (!started || started.session !== ctx.sessionManager.getSessionId()) return;
      const isOapi = reply.provider === 'oapi' && started.oapiEnabled;
      const isAnthropic =
        reply.provider === 'anthropic' &&
        reply.api === 'anthropic-messages' &&
        started.anthropicModel &&
        started.anthropicModel.id === reply.model &&
        ctx.model?.id === reply.model &&
        piExpAccount(ctx) === 'anthropic-api';
      if (!isOapi && !isAnthropic) return;
      const account = isOapi ? 'openai-api' : 'anthropic-api';
      if (!activeGrants()?.[account].enabled) return;
      const cost = completed(reply, isOapi ? started.oapiModel : started.anthropicModel, Date.now());
      if (!cost) return;
      if (validId(reply.responseId)) return record(account, cost, stableId('response', reply.responseId));
      pending = { account, session: started.session, cost };
    },
    turnEnd(event: unknown, ctx: PiPackageContext) {
      // Pi emits one turn_end for the request before the next context hook, with its persisted ID.
      // Keep only the accounting fields from message_end; other extensions can replace the message object.
      const entry = pending;
      pending = undefined;
      const { message, messageEntryId } = (event ?? {}) as { message?: Reply; messageEntryId?: string };
      if (
        entry &&
        message?.role === 'assistant' &&
        (entry.account === 'openai-api'
          ? message.provider === 'oapi'
          : message.provider === 'anthropic' && message.api === 'anthropic-messages') &&
        message.model === entry.cost.model &&
        validId(messageEntryId) &&
        entry.session === ctx.sessionManager.getSessionId() &&
        activeGrants()?.[entry.account].enabled
      )
        return record(entry.account, entry.cost, stableId('entry', entry.session, messageEntryId));
    },
  };
}
