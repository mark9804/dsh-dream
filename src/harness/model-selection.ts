import type { Agent, CallConfig, HostContext } from './types.js';
import type { DreamModelChoice } from '../types.js';
import { validateDreamModelChoice } from '../config.js';

export type SelectedCallConfig = CallConfig & { provider: string; model: string };
type Selection = Pick<SelectedCallConfig, 'provider' | 'model' | 'reasoningEffort'>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Detached whitelist at both the selection and prepared-adapter boundaries. */
export function copyCallConfig(value: unknown): SelectedCallConfig {
  if (!record(value) || !nonempty(value.provider) || !nonempty(value.model)) throw new TypeError('Dream requires an actual configured provider/model route');
  const config: SelectedCallConfig = { provider: value.provider, model: value.model };
  const { maxTokens, reasoningEffort, temperature, stop } = value;
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new TypeError('Invalid model maxTokens');
    config.maxTokens = maxTokens;
  }
  if (reasoningEffort !== undefined) {
    if (!nonempty(reasoningEffort)) throw new TypeError('Invalid model reasoningEffort');
    config.reasoningEffort = reasoningEffort;
  }
  if (temperature !== undefined) {
    if (typeof temperature !== 'number' || !Number.isFinite(temperature)) throw new TypeError('Invalid model temperature');
    config.temperature = temperature;
  }
  if (stop !== undefined) {
    if (!Array.isArray(stop) || !Array.from(stop).every(item => typeof item === 'string')) throw new TypeError('Invalid model stop');
    config.stop = [...stop];
  }
  return config;
}

function selectionOf(value: unknown): Selection {
  if (!record(value)) throw new TypeError('Dream requires an actual configured provider/model route');
  return copyCallConfig({ provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort });
}
const sameRoute = (config: CallConfig | undefined, selected: Selection) => config?.provider === selected.provider && config.model === selected.model;

/** Capture before asynchronous admission. rc.1 current() owns route and explicit
 * effort; its undefined/invalid result must not silently resurrect an old header.
 * An optional accepted-step selection is authoritative, including omitted effort.
 * Output cap prefers live AgentOptions; other explicit controls may be retained
 * only from the same route. Adapter-default header fields are not user choices. */
export function captureModelCall(agent: Agent, stepSelection?: CallConfig): SelectedCallConfig {
  const model = agent.model;
  let selected: Selection | undefined;
  if (stepSelection !== undefined) selected = selectionOf(stepSelection);
  else if (model !== undefined) {
    if (typeof model?.current !== 'function') throw new TypeError('Harness model selection current() unavailable');
    selected = selectionOf(model.current());
  }
  const header = agent.session.requestHeader?.();
  const options = agent.options;
  if (!selected) {
    const legacy = header?.config ?? options;
    if (!legacy) throw new TypeError('Dream requires an actual configured provider/model route');
    selected = selectionOf({ provider: legacy.provider, model: legacy.model,
      reasoningEffort: header?.config && header.adapterDefaults?.reasoningEffort === true ? undefined : legacy.reasoningEffort });
  }
  const sameHeader = sameRoute(header?.config, selected) ? header : undefined;
  const sameOptions = sameRoute(options, selected) ? options : undefined;
  return copyCallConfig({
    ...selected,
    maxTokens: options?.maxTokens !== undefined ? options.maxTokens : (sameHeader?.adapterDefaults?.maxTokens === true ? undefined : sameHeader?.config.maxTokens),
    temperature: sameHeader?.config.temperature !== undefined ? sameHeader.config.temperature : sameOptions?.temperature,
    stop: sameHeader?.config.stop !== undefined ? sameHeader.config.stop : sameOptions?.stop,
  });
}

/** Choose a detached branch admission, never carrying a prepared call between
 * stages. Explicit routes are independent even if equal to the target route:
 * their missing effort/cap uses adapter defaults, not parent effective controls. */
export function captureModelChoice(agent: Agent, modelChoice?: DreamModelChoice, stepSelection?: CallConfig): SelectedCallConfig {
  const choice = validateDreamModelChoice(modelChoice);
  if (choice?.provider !== undefined) return copyCallConfig(choice);
  const config = captureModelCall(agent, stepSelection);
  if (choice?.reasoningEffort !== undefined) config.reasoningEffort = choice.reasoningEffort;
  return config;
}

export interface ModelSelectionTracker { current(): CallConfig | undefined; dispose(): void }

/** Explicitly installed once per bound Agent by the plugin lifecycle owner.
 * Public pre-step selection, not an imagined agent.step property or private loop
 * state. Each accepted step retains its choice through request retries; pending
 * user selections affect only background admissions or a later accepted step. */
export function createModelSelectionTracker(ctx: Pick<HostContext, 'on'>, agent: Agent): ModelSelectionTracker {
  let active: { turn: number; step: number; selection: Selection } | undefined;
  let disposed = false;
  let revision = 0;
  const offStep = ctx.on('agent/pre-step', async (event, next) => {
    if (disposed || event.agent !== agent) return next();
    const token = ++revision;
    active = undefined;
    const selection = event.modelSelection === undefined ? undefined : selectionOf(event.modelSelection);
    const decision = await next();
    if (!disposed && token === revision && record(decision) && decision.kind === 'enter' && selection) {
      active = { turn: event.turn, step: event.step, selection };
    }
    return decision;
  });
  let offSession: () => void;
  try {
    offSession = ctx.on('session/event', (session, event) => {
      if (disposed || session !== agent.session || !record(event.data)) return;
      if (event.type === 'turn/end' && (!active || event.data.turn === active.turn)
        || event.type === 'step/end' && active && event.data.turn === active.turn && event.data.step === active.step) {
        revision++;
        active = undefined;
      }
    });
  } catch (error) { offStep(); throw error; }
  return {
    current: () => active && { ...active.selection },
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      active = undefined;
      offSession();
      offStep();
    },
  };
}
