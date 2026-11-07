// Legacy definitions remain for historical callers, never the default native entry.
function validateRequestKey(value: string): void {
  if (typeof value !== 'string' || Array.from(value).length < 1 || Array.from(value).length > 256)
    throw new Error('invalid_request_key');
}
import { object } from './io.js';
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
const string = { type: 'string', minLength: 1 };
/** Run ids are opaque tokens; the shape matches the run-control/artifact names. */
const runId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' };
const mode = { type: 'string', enum: ['visible', 'headless'] };
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  extra: Record<string, unknown> = {}
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false, ...extra },
  };
}
const target = {
  oneOf: [
    { required: ['linkId'], not: { required: ['runId'] } },
    { required: ['runId'], not: { required: ['linkId'] } },
  ],
};
export const TOOLS: ToolDefinition[] = [
  tool(
    'delegate_list',
    'Read a bounded page of this authenticated owner’s links and latest runs; committed observations only, no transcript or report bodies.',
    { limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', minLength: 1, maxLength: 2048 } },
    []
  ),
  tool(
    'delegate_spawn',
    'Accept one headless delegated run. HUD-managed children cannot spawn another new session; existing-session handover remains subject to its normal gates. Retry the same request_key only to replay that intent.',
    {
      backend: string,
      role: string,
      brief: string,
      cwd: string,
      mode,
      request_key: { ...string, maxLength: 256 },
      name: string,
      model: string,
      effort: string,
      layout: { type: 'string', enum: ['tab', 'split'] },
      predecessor: string,
    },
    ['backend', 'role', 'brief', 'cwd', 'mode', 'request_key']
  ),
  tool(
    'delegate_resume',
    'Accept a new headless run for a bound delegated session; an explicit expectedRun pins the run the caller saw.',
    {
      linkId: string,
      mode,
      prompt: { type: 'string' },
      request_key: { ...string, maxLength: 256 },
      expectedRun: runId,
    },
    ['linkId', 'mode', 'request_key']
  ),
  tool(
    'delegate_wait',
    'Read one cursor page for a fixed run; drain hasMore using returned runId/nextSeq. A verified client deadline enables bounded long polling.',
    {
      linkId: string,
      runId: string,
      afterSeq: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      until: {
        type: 'array',
        items: { type: 'string', enum: ['report', 'run_terminal', 'uncertain'] },
      },
      timeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
    [],
    target
  ),
  tool(
    'delegate_status',
    'Read committed lifecycle and cached status with their original independent stamps.',
    { linkId: string, runId: string },
    [],
    target
  ),
  tool(
    'delegate_close',
    'End a confirmed current-owned headless delegation after proven termination. Acceptance may remain pending; replay returns the original outcome without advancing cleanup. Read status for progress. No visible surface close or reopening.',
    {
      linkId: string,
      expectedRun: runId,
      request_key: { ...string, maxLength: 256 },
      grace: { type: 'integer', minimum: 0, maximum: 60000 },
    },
    ['linkId', 'expectedRun', 'request_key']
  ),
  tool(
    'delegate_cancel',
    'Record cancellation intent without waiting for exit. Visible scope control remains unavailable.',
    { runId: string, grace: { type: 'integer', minimum: 0, maximum: 60000 } },
    ['runId']
  ),
  tool(
    'delegate_whoami',
    'Bind this run using its launch environment claim or parameter fallback.',
    { claim: string },
    []
  ),
  tool(
    'delegate_report',
    'Submit a report for the explicitly identified run from its current bound child.',
    {
      runId: string,
      status: { type: 'string', enum: ['completed', 'failed', 'blocked', 'interrupted'] },
      summary: { type: 'string' },
      reportPath: string,
    },
    ['runId', 'status', 'summary']
  ),
];
/** Transport bounds, not native response policy. The native harness interprets every JSON field. */
export const JSON_VALUE_SCHEMA: Record<string, unknown> = {
  type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
  maxLength: 65536,
  maxItems: 1024,
  maxProperties: 1024,
  items: { $ref: '#/$defs/jsonValue' },
  additionalProperties: { $ref: '#/$defs/jsonValue' },
};
const MAX_ARGUMENT_DEPTH = 32;
const MAX_ARGUMENT_VALUES = 8192;
const MAX_ARGUMENT_BYTES = 262144;
interface ValidationBudget {
  values: number;
  bytes: number;
}
function valid(
  value: unknown,
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  budget: ValidationBudget,
  depth = 0
): boolean {
  if (depth > MAX_ARGUMENT_DEPTH || ++budget.values > MAX_ARGUMENT_VALUES) return false;
  if (schema.$ref !== undefined) {
    // Only a local definition is supported. No external schemas or arbitrary object traversal.
    const match = typeof schema.$ref === 'string' && /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(schema.$ref);
    if (!match || !object(root.$defs) || !Object.hasOwn(root.$defs, match[1])) return false;
    const resolved = root.$defs[match[1]];
    if (!object(resolved) || resolved.$ref !== undefined) return false;
    schema = resolved;
  }
  let type = schema.type;
  if (Array.isArray(type)) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!type.includes(actual)) return false;
    type = actual;
  }
  if (type === 'string') {
    if (typeof value !== 'string') return false;
    budget.bytes += Buffer.byteLength(JSON.stringify(value));
    return (
      budget.bytes <= MAX_ARGUMENT_BYTES &&
      (schema.minLength === undefined || [...value].length >= (schema.minLength as number)) &&
      (schema.maxLength === undefined || [...value].length <= (schema.maxLength as number)) &&
      (schema.pattern === undefined || new RegExp(schema.pattern as string).test(value)) &&
      (!Array.isArray(schema.enum) || schema.enum.includes(value))
    );
  }
  budget.bytes += typeof value === 'number' ? String(value).length : 5;
  if (budget.bytes > MAX_ARGUMENT_BYTES) return false;
  if (type === 'null') return value === null;
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer' || type === 'number')
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (type !== 'integer' || Number.isSafeInteger(value)) &&
      (schema.minimum === undefined || value >= (schema.minimum as number)) &&
      (schema.maximum === undefined || value <= (schema.maximum as number))
    );
  if (type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length < ((schema.minItems as number) || 0) ||
      (schema.maxItems !== undefined && value.length > (schema.maxItems as number)) ||
      (schema.uniqueItems && new Set(value).size !== value.length) ||
      !object(schema.items) ||
      Object.getOwnPropertyNames(value).length !== value.length + 1
    )
      return false;
    budget.bytes += value.length;
    for (let index = 0; index < value.length; index++) {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !property ||
        !Object.hasOwn(property, 'value') ||
        !valid(property.value, schema.items, root, budget, depth + 1)
      )
        return false;
    }
    return budget.bytes <= MAX_ARGUMENT_BYTES && Object.getOwnPropertySymbols(value).length === 0;
  }
  if (type === 'object') {
    if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const keys = Object.keys(value);
    const properties = object(schema.properties) ? schema.properties : {};
    if (
      (schema.maxProperties !== undefined && keys.length > (schema.maxProperties as number)) ||
      (Array.isArray(schema.required) &&
        schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(value, key))) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== keys.length
    )
      return false;
    for (const key of keys) {
      budget.bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
      if (budget.bytes > MAX_ARGUMENT_BYTES) return false;
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      const child = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties;
      if (!Object.hasOwn(property, 'value') || !object(child) || !valid(property.value, child, root, budget, depth + 1))
        return false;
    }
    return true;
  }
  return false;
}
export function validateToolArguments(definition: ToolDefinition, args: unknown): boolean {
  if (!object(args)) return false;
  const properties = definition.inputSchema.properties as Record<string, Record<string, unknown>>;
  // The outer tool envelope always rejects unadvertised arguments, including target/owner hints.
  if (Object.keys(args).some((key) => !Object.hasOwn(properties, key))) return false;
  if (!valid(args, definition.inputSchema, definition.inputSchema, { values: 0, bytes: 0 })) return false;
  if (definition.name === 'delegate_wait' || definition.name === 'delegate_status')
    if (Object.hasOwn(args, 'runId') === Object.hasOwn(args, 'linkId')) return false;
  if (Object.hasOwn(args, 'request_key'))
    try {
      validateRequestKey(args.request_key as string);
    } catch {
      return false;
    }
  return true;
}
