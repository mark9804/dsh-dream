import type { Agent, Handlers, ToolArguments, ToolContext, HandlerContext } from './types.js';
import type { InternalTurnCompletion } from './internal-turns.js';
type Property = { type?: string; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; uniqueItems?: boolean; items?: Property; enum?: readonly unknown[]; minimum?: number; maximum?: number; description?: string };
interface Definition { name: string; description: string; properties: Record<string, Property>; required: string[] }
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const definitions: Record<keyof ToolArguments, Definition> = {
  recall: { name: 'dream_recall', description: 'Recall scoped memory and bounded daily history. Groups equivalent excerpts with source locations and links applied reviewed merges/corrections to original evidence. Returns omissions and scope; grouped copies, rankings and old plans are not truth or current status.',
    properties: { query: text, topic: { ...text, description: 'Current task topic; reinforcement requires a normalized exact match to its approved applicability.topic.' }, conditions: { ...text, description: 'Current applicability conditions; reinforcement requires a normalized exact match, not inferred broader permission.' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query', 'topic', 'conditions'] },
  reinforcement: { name: 'dream_reinforcement', description: 'Disable or restore a candidate’s recall boost. This does not change memory text or evidence; restore still requires current eligible clean approval.',
    properties: { candidateId: text, enabled: { type: 'boolean' }, reason: text }, required: ['candidateId', 'enabled', 'reason'] },
  decideCompaction: { name: 'dream_decide_compaction', description: 'Choose compact or skip for a committed transaction in agent mode, using the current context pressure from dream_status. Both paths require actual memory rereading; execution waits for idle.',
    properties: { jobId: text, transactionId: text, decision: { enum: ['compact', 'skip'] }, reason: text },
    required: ['jobId', 'transactionId', 'decision', 'reason'] },
  status: { name: 'dream_status', description: 'Read memory jobs, cited event priorities, independent dream status and current context pressure.', properties: { jobId: text }, required: [] },
  review: { name: 'dream_review', description: 'Request isolated evidence-based review of one proposal, or reject/defer it. Only the isolated reviewer can approve; its decision and provenance are returned.',
    properties: { jobId: text, proposalId: text, decision: { enum: ['review', 'reject', 'defer'] }, reason: text },
    required: ['jobId', 'proposalId', 'decision', 'reason'] },
  reviewBatch: { name: 'dream_review_batch', description: 'Review an explicit set of proposals. Each gets an independent evidence-only model decision; current matching decisions are reused. Approvals record atomically, then submit after idle. On failure, observed reject/defer decisions remain without partial approvals. Returns decisions and remaining unreviewed IDs.',
    properties: { jobId: text, proposalIds: { type: 'array', items: text, minItems: 1, maxItems: 32, uniqueItems: true } }, required: ['jobId', 'proposalIds'] },
  readReload: { name: 'dream_reload_read', description: 'Native calls only: read requested post-commit memory as complete text/versions with a receipt for a later model request. Under PTC, use ordinary file tools and return their full text to the model; acknowledge readSourceIds in a separate later request, never in the reading program.',
    properties: { jobId: text, transactionId: text, sourceIds: { type: 'array', items: text, minItems: 1, maxItems: 256, uniqueItems: true, description: 'Omit for all requested sources. Supply remaining IDs to continue; complete files only, up to 64 KiB JSON per response.' } }, required: ['jobId', 'transactionId'] },
  submit: { name: 'dream_submit', description: 'Submit currently accepted dream proposals; deferred proposals remain pending.', properties: { jobId: text }, required: ['jobId'] },
  ackReload: { name: 'dream_ack_reload', description: 'Acknowledge all post-commit memory after reading it. Submit read receipt IDs returned by dream_reload_read, or source IDs after ordinary complete file reads. Rechecks current versions before completion and queues one actual-change report.',
    properties: { jobId: text, transactionId: text, readSourceIds: { type: 'array', items: text, uniqueItems: true, minItems: 1, maxItems: 256, description: 'Full-file read path, including PTC: return complete file text to the model first, then submit these IDs in a later model request, never in the reading run_code program. Cannot extend receipt coverage.' }, readReceiptIds: { type: 'array', items: text, uniqueItems: true, minItems: 1, maxItems: 128, description: 'Native calls only. IDs from earlier dream_reload_read results; together must cover every requested source. Use a later model request after reading returned text; never call this path through PTC.' } },
    required: ['jobId', 'transactionId'] },
  retry: { name: 'dream_retry', description: 'Resume a failed memory phase or explicitly retry its independent dream. Dream retry does not rerun memory generation or apply proposals.', properties: { jobId: text, branch: { enum: ['memory', 'dream'], description: 'Defaults to memory. Choose dream only for a failed independent narrative task.' } }, required: ['jobId'] },
};

type ModelProperty = { type: string; description?: string; items?: ModelProperty; enum?: readonly unknown[] };

function propertyForModel(property: Property): ModelProperty {
  // The Host raw-schema validator rejects unsupported keywords rather than
  // silently ignoring them. Keep enforcement in validateArgs; publish the same
  // bounds as parameter-local guidance in the supported annotation vocabulary.
  const type = property.type ?? (property.enum?.every(value => typeof value === 'string') ? 'string' : undefined);
  if (!type) throw new TypeError('Model property requires an explicit supported type');
  const rules: string[] = [];
  if (type === 'string') {
    if (property.minLength !== undefined && property.maxLength !== undefined) rules.push(`${property.minLength}–${property.maxLength} characters; not blank.`);
    else if (property.minLength !== undefined) rules.push(`At least ${property.minLength} characters; not blank.`);
    else if (property.maxLength !== undefined) rules.push(`At most ${property.maxLength} characters.`);
  }
  if (type === 'integer' || type === 'number') {
    if (property.minimum !== undefined && property.maximum !== undefined) rules.push(`Range ${property.minimum}–${property.maximum}, inclusive.`);
    else if (property.minimum !== undefined) rules.push(`Minimum ${property.minimum}.`);
    else if (property.maximum !== undefined) rules.push(`Maximum ${property.maximum}.`);
  }
  if (type === 'array') {
    if (property.minItems !== undefined && property.maxItems !== undefined) rules.push(`${property.minItems}–${property.maxItems} items.`);
    else if (property.minItems !== undefined) rules.push(`At least ${property.minItems} items.`);
    else if (property.maxItems !== undefined) rules.push(`At most ${property.maxItems} items.`);
    if (property.uniqueItems) rules.push('No duplicate items.');
  }
  const description = [property.description, ...rules].filter(Boolean).join(' ');
  return { type, ...(description ? { description } : {}), ...(property.items ? { items: propertyForModel(property.items) } : {}),
    ...(property.enum ? { enum: [...property.enum] } : {}) };
}

/** Model-facing projection only; never substitutes for the full runtime checks. */
export function schemaForModel(definition: Pick<Definition, 'properties' | 'required'>) {
  return { type: 'object', properties: Object.fromEntries(Object.entries(definition.properties).map(([key, value]) => [key, propertyForModel(value)])),
    required: [...definition.required], additionalProperties: false };
}

function validateArgs(args: unknown, definition: Definition): asserts args is Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Tool arguments must be an object');
  for (const key of definition.required) if (!Object.hasOwn(args, key)) throw new TypeError(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = definition.properties[key];
    if (!schema) throw new TypeError(`Unknown argument ${key}`);
    if (schema.enum) {
      if (!schema.enum.includes(value)) throw new TypeError(`Invalid ${key}`);
    } else if (schema.type === 'boolean') {
      if (typeof value !== 'boolean') throw new TypeError(`Invalid ${key}`);
    } else if (schema.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < schema.minimum! || value > schema.maximum!) throw new TypeError(`Invalid ${key}`);
    } else if (schema.type === 'array') {
      if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > schema.maxItems! || new Set(value).size !== value.length) throw new TypeError(`Invalid ${key}`);
      if (value.some(v => typeof v !== 'string' || !v.trim() || v.length > 4096)) throw new TypeError(`Invalid ${key}`);
    } else if (typeof value !== 'string' || !value.trim() || value.length > schema.maxLength!) throw new TypeError(`Invalid ${key}`);
  }
}

/** Register in the target agent's scope and retain disposers for plugin unload. */
export function registerTools(agent: Agent, handlers: Handlers, serviceContext: ToolContext = agent.ctx, options: { completion?: InternalTurnCompletion } = {}) {
  if (typeof serviceContext?.tools?.register !== 'function') throw new Error('Harness tool registration unavailable');
  const disposers: (() => void)[] = [];
  try {
    for (const [key, definition] of Object.entries(definitions) as [keyof ToolArguments, Definition][]) {
      if (typeof handlers[key] !== 'function') continue;
      disposers.push(serviceContext.tools.register({
        name: definition.name,
        description: definition.description,
        parameters: schemaForModel(definition),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          validateArgs(args, definition);
          if (key === 'ackReload' && !Object.hasOwn(args, 'readSourceIds') && !Object.hasOwn(args, 'readReceiptIds')) throw new TypeError('Provide readReceiptIds or readSourceIds');
          if (exec?.agent !== agent || exec.agent.id !== agent.id || exec.agent.session?.id !== agent.session?.id) {
            throw new Error('Review actor does not match the target agent');
          }
          exec.signal?.throwIfAborted();
          // key and definition come from the same table; validateArgs has checked the
          // matching schema. This assertion bridges TS's lost indexed correlation.
          const result = await (handlers[key] as (args: Record<string, unknown>, context: HandlerContext) => unknown)(args, { actor: { agentId: agent.id, sessionId: agent.session.id }, signal: exec.signal, callId: exec.callId, parent: exec.parent, agent });
          const value: unknown = JSON.parse(JSON.stringify(result));
          // Native completion is data on the successful Host result, not prose.
          // Validate/serialize first; throws and Host policy failures stay visible.
          exec.signal?.throwIfAborted();
          options.completion?.finish(definition.name, args, value, exec);
          return value;
        },
      }));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.reverse()) dispose();
  };
}
