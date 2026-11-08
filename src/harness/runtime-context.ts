import type { Agent, HostContext } from './types.js';
/** Registrations belong to agent.ctx; business services can belong to its retained
 * preset composition. Resolve those separately without publishing root overrides. */
export function createRuntimeContext(ctx: HostContext, agent: Agent): HostContext {
  const access = ctx as unknown as { get?(name: string): unknown; [key: string]: unknown };
  const presets = access.get?.('agentPresets') as { serviceFor?(agent: Agent, name: string): unknown } | undefined;
  const services = new Map<string, unknown>();
  const resolve = (name: string) => {
    if (services.has(name)) return services.get(name);
    const scoped = presets?.serviceFor?.(agent, name);
    const value = scoped ?? access.get?.(name) ?? access[name]; services.set(name, value); return value;
  };
  return new Proxy(ctx, { get(target, key) {
    if (key === 'get') return (name: string) => resolve(name);
    if (['fs', 'llm', 'compaction', 'sandboxPolicy', 'tokenMeter'].includes(String(key))) return resolve(String(key));
    return Reflect.get(target, key, target);
  } });
}
export function nativeExecutor(ctx: HostContext, agent: Agent): 'native' | 'ptc' | 'unknown' {
  try {
    const tools = ctx.tools as unknown as { definitions?(scope: Agent): unknown[]; selectExecutor?(scope: Agent): { describe(definitions: unknown[]): { schemas?: { name: string }[] } } };
    if (typeof tools.definitions !== 'function' || typeof tools.selectExecutor !== 'function') return 'unknown';
    const schemas = tools.selectExecutor(agent).describe(tools.definitions(agent)).schemas;
    if (!Array.isArray(schemas)) return 'unknown';
    return schemas.length === 1 && schemas[0]?.name === 'run_code' ? 'ptc' : 'native';
  } catch { return 'unknown'; }
}
