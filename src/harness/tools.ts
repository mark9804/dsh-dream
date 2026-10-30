import type { Agent, Handlers, ToolArguments, ToolContext, HandlerContext } from './types.js';
type Property = { type?: string; minLength?: number; maxLength?: number; maxItems?: number; uniqueItems?: boolean; items?: Property; enum?: readonly unknown[] };
interface Definition { name: string; description: string; properties: Record<string, Property>; required: string[] }
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const definitions: Record<keyof ToolArguments, Definition> = {
  decideCompaction: { name: 'dream_decide_compaction', description: 'Choose compact or skip for a committed transaction in agent mode, using the current context pressure from dream_status. Both paths require actual memory rereading; execution waits for idle.',
    properties: { jobId: text, transactionId: text, decision: { enum: ['compact', 'skip'] }, reason: text },
    required: ['jobId', 'transactionId', 'decision', 'reason'] },
  status: { name: 'dream_status', description: 'Read dream jobs, pending proposals and current context pressure for a compaction decision.', properties: { jobId: text }, required: [] },
  review: { name: 'dream_review', description: 'Request isolated evidence-based review of one proposal, or reject/defer it. Only the isolated reviewer can approve; its decision and provenance are returned.',
    properties: { jobId: text, proposalId: text, decision: { enum: ['review', 'reject', 'defer'] }, reason: text },
    required: ['jobId', 'proposalId', 'decision', 'reason'] },
  submit: { name: 'dream_submit', description: 'Submit currently accepted dream proposals; deferred proposals remain pending.', properties: { jobId: text }, required: ['jobId'] },
  ackReload: { name: 'dream_ack_reload', description: 'Acknowledge that all requested memory sources were actually read after a committed change.',
    properties: { jobId: text, transactionId: text, readSourceIds: { type: 'array', items: text, uniqueItems: true, maxItems: 256 } },
    required: ['jobId', 'transactionId', 'readSourceIds'] },
  retry: { name: 'dream_retry', description: 'Resume a failed dream phase using its recorded checkpoint.', properties: { jobId: text }, required: ['jobId'] },
};

function validateArgs(args: unknown, definition: Definition): asserts args is Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Tool arguments must be an object');
  for (const key of definition.required) if (!Object.hasOwn(args, key)) throw new TypeError(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = definition.properties[key];
    if (!schema) throw new TypeError(`Unknown argument ${key}`);
    if (schema.enum) {
      if (!schema.enum.includes(value)) throw new TypeError(`Invalid ${key}`);
    } else if (schema.type === 'array') {
      if (!Array.isArray(value) || value.length > schema.maxItems! || new Set(value).size !== value.length) throw new TypeError(`Invalid ${key}`);
      if (value.some(v => typeof v !== 'string' || !v.trim() || v.length > 4096)) throw new TypeError(`Invalid ${key}`);
    } else if (typeof value !== 'string' || !value.trim() || value.length > schema.maxLength!) throw new TypeError(`Invalid ${key}`);
  }
}

/** Register in the target agent's scope and retain disposers for plugin unload. */
export function registerTools(agent: Agent, handlers: Handlers, serviceContext: ToolContext = agent.ctx) {
  if (typeof serviceContext?.tools?.register !== 'function') throw new Error('Harness tool registration unavailable');
  const disposers: (() => void)[] = [];
  try {
    for (const [key, definition] of Object.entries(definitions) as [keyof ToolArguments, Definition][]) {
      if (typeof handlers[key] !== 'function') continue;
      disposers.push(serviceContext.tools.register({
        name: definition.name,
        description: definition.description,
        parameters: { type: 'object', properties: definition.properties, required: definition.required, additionalProperties: false },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          validateArgs(args, definition);
          if (exec?.agent !== agent || exec.agent.id !== agent.id || exec.agent.session?.id !== agent.session?.id) {
            throw new Error('Review actor does not match the target agent');
          }
          exec.signal?.throwIfAborted();
          // key and definition come from the same table; validateArgs has checked the
          // matching schema. This assertion bridges TS's lost indexed correlation.
          const result = await (handlers[key] as (args: Record<string, unknown>, context: HandlerContext) => unknown)(args, { actor: { agentId: agent.id, sessionId: agent.session.id }, signal: exec.signal, callId: exec.callId, agent });
          return JSON.parse(JSON.stringify(result)) as unknown;
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
