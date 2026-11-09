import type { HostContext, Agent } from '../harness/types.js';
import type { DreamConfig, DreamModelChoice } from '../types.js';
import type { ModelCatalog } from './contracts.js';
import { SettingsFailure } from './contracts.js';
const bounded = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
const identifier = (value: unknown, limit = 512): value is string => bounded(value, limit) && !/\s/u.test(value);
const selectionOf = (agent: Agent | undefined): ModelCatalog['current'] => {
  if (!agent) return;
  const config = agent.model ? agent.model.current() : agent.session.requestHeader?.()?.config ?? agent.options;
  if (!identifier(config?.provider) || !identifier(config?.model)) return;
  return { provider: config.provider, model: config.model, ...(identifier(config.reasoningEffort, 128) ? { reasoningEffort: config.reasoningEffort } : {}) };
};
/** Public metadata only. Neither credentials, stored sessions nor provider streams
 * are opened. Failed capability lookups stay failures, never invented effort ids. */
export async function buildDreamModelCatalog(ctx: HostContext, agent?: Agent, signal?: AbortSignal): Promise<ModelCatalog> {
  signal?.throwIfAborted();
  const { llm } = ctx;
  if (typeof llm?.listProviders !== 'function' || typeof llm.listModels !== 'function' || typeof llm.resolveModelInfo !== 'function') throw new SettingsFailure('UNAVAILABLE', 'Harness model directory is unavailable');
  let current: ModelCatalog['current']; try { current = selectionOf(agent); } catch { /* Directory remains usable without a selected chat route. */ }
  const providers = llm.listProviders();
  if (!Array.isArray(providers) || providers.length > 256) throw new SettingsFailure('UNAVAILABLE', 'Harness provider directory exceeds the supported bound');
  const groups: ModelCatalog['groups'] = [], failures: ModelCatalog['failures'] = [];
  for (const provider of providers) {
    signal?.throwIfAborted();
    if (!identifier(provider.id) || !bounded(provider.name, 1024)) continue;
    try {
      const listed = await llm.listModels(provider.id); signal?.throwIfAborted();
      if (!Array.isArray(listed) || listed.length > 2048) throw Error('Invalid model catalog');
      const models: ModelCatalog['groups'][number]['models'] = [], seen = new Set<string>();
      for (const model of listed) {
        signal?.throwIfAborted();
        if (!identifier(model.id) || !bounded(model.name, 1024) || seen.has(model.id)) continue;
        seen.add(model.id);
        try {
        const info = await llm.resolveModelInfo(provider.id, model.id, signal); signal?.throwIfAborted();
        if (info.provider !== provider.id || info.id !== model.id) throw Error('Model identity mismatch');
        let reasoning: ModelCatalog['groups'][number]['models'][number]['reasoning'];
        if (info.reasoning !== undefined) {
          const choices = info.reasoning.efforts;
          if (!Array.isArray(choices) || choices.length > 128 || choices.some(effort => !identifier(effort.id, 128) || !bounded(effort.name, 1024))) throw Error('Invalid reasoning metadata');
          if (new Set(choices.map(effort => effort.id)).size !== choices.length) throw Error('Duplicate reasoning identifiers');
          if (info.reasoning.defaultEffort !== undefined && !choices.some(effort => effort.id === info.reasoning!.defaultEffort)) throw Error('Invalid reasoning default');
          reasoning = { efforts: choices.map(effort => ({ id: effort.id, name: effort.name, ...(bounded(effort.description, 4096) ? { description: effort.description } : {}) })), ...(info.reasoning.defaultEffort !== undefined ? { defaultEffort: info.reasoning.defaultEffort } : {}) };
        }
        models.push({ id: model.id, name: model.name, ...(reasoning ? { reasoning } : {}) });
        } catch {
          signal?.throwIfAborted();
          failures.push({ id: `${provider.id}/${model.id}`, name: `${provider.name} / ${model.name}`, message: 'Exact model capability lookup failed; other models remain available.' });
        }
      }
      if (models.length) groups.push({ id: provider.id, name: provider.name, models });
    } catch {
      signal?.throwIfAborted();
      failures.push({ id: provider.id, name: provider.name, message: 'Model directory or exact capability lookup failed; refresh or check this provider in Harness settings.' });
    }
  }
  return { groups, failures, ...(current ? { current } : {}) };
}
export const modelChoiceFields = ['memoryModel', 'dreamModel', 'reviewModel'] as const;
/** Only explicit per-branch changes are checked here. prepareCall validates again
 * under the actual registration at dispatch; no prepared handles are retained. */
export async function validateModelChoices(ctx: HostContext, config: Partial<DreamConfig>, agent?: Agent): Promise<{ field: string; message: string }[]> {
  const configured = modelChoiceFields.filter(field => { const choice = config[field]; return choice && Object.keys(choice).length > 0; });
  if (!configured.length) return [];
  const catalog = await buildDreamModelCatalog(ctx, agent);
  const errors: { field: string; message: string }[] = [];
  for (const field of configured) {
    const choice: DreamModelChoice = config[field]!;
    const provider = choice.provider ?? catalog.current?.provider, model = choice.model ?? catalog.current?.model;
    const found = catalog.groups.find(group => group.id === provider)?.models.find(item => item.id === model);
    if (!found) { errors.push({ field, message: 'The selected model is not available in the target Harness model directory' }); continue; }
    if (choice.reasoningEffort !== undefined && !found.reasoning?.efforts.some(effort => effort.id === choice.reasoningEffort)) errors.push({ field, message: 'The selected reasoning effort is not supported by this exact model' });
  }
  return errors;
}
