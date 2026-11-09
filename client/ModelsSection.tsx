import * as React from 'react';
import type { DreamModelChoice, DreamSettingsApi, ModelCatalog } from './api.js';
import { errorMessage, modelChoiceError, modelFields } from './draft.js';
import type { Draft, FieldErrors, ModelField } from './draft.js';
import type { LocaleKey, Translate } from './locale.js';
import { Button, ChoiceCards, Field, FieldSet, SearchSelect } from './ui.js';
import type { SelectOption } from './ui.js';

export interface ModelCatalogState {
  sessionId?: string;
  phase: 'loading' | 'success' | 'error' | 'unavailable';
  catalog?: ModelCatalog;
  message?: string;
}
/** One read-only request owner. A late response may never replace the current
 * session's capabilities, and completion never mutates any model choice. */
export function createModelCatalogLoader(request: DreamSettingsApi['models'] | undefined, publish: (state: ModelCatalogState) => void) {
  let epoch = 0, disposed = false;
  let controller: AbortController | undefined;
  return {
    async load(sessionId?: string) {
      if (disposed) return;
      const current = ++epoch;
      controller?.abort();
      const next = new AbortController(); controller = next;
      if (!request) { publish({ sessionId, phase: 'unavailable' }); return; }
      publish({ sessionId, phase: 'loading' });
      try {
        const catalog = await request(sessionId ? { sessionId } : {}, next.signal);
        if (!disposed && current === epoch && !next.signal.aborted) publish({ sessionId, phase: 'success', catalog });
      } catch (error) {
        if (!disposed && current === epoch && !next.signal.aborted) publish({ sessionId, phase: 'error', message: errorMessage(error, '').message });
      }
    },
    dispose() { disposed = true; epoch++; controller?.abort(); },
  };
}

interface SectionProps {
  api: DreamSettingsApi; sessionId?: string; draft: Draft; errors: FieldErrors; disabled: boolean;
  id(field: string): string; onChange(field: ModelField, value: DreamModelChoice | undefined): void; t: Translate;
}
const branchLabel = (field: ModelField) => `field_${field}` as LocaleKey;
const branchHelp = (field: ModelField) => `help_${field}` as LocaleKey;
const optionLabel = (name: string, id: string) => name === id ? id : `${name} · ${id}`;
function choiceView(value: unknown): DreamModelChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const choice: DreamModelChoice = {};
  for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') choice[key] = descriptor.value;
  }
  return choice;
}
function preserveOption(options: SelectOption[], value: string | undefined, t: Translate): SelectOption[] {
  return value && !options.some(option => option.value === value)
    ? [...options, { value, label: value, description: t('modelSavedUnavailable') }] : options;
}
interface CardProps extends Pick<SectionProps, 'disabled' | 'id' | 'onChange' | 't'> {
  field: ModelField; value: unknown; error?: LocaleKey; catalog?: ModelCatalog;
}
/** Pure card: route changes clear only this branch's effort; catalog changes
 * never normalize or discard a saved selection. Exported for synthetic tests. */
export function ModelChoiceCard({ field, value, error, catalog, disabled, id, onChange, t }: CardProps) {
  const choice = choiceView(value);
  const custom = choice.provider !== undefined || choice.model !== undefined;
  const mode = custom ? 'custom' : 'follow';
  const route = custom ? choice : catalog?.current;
  const group = catalog?.groups.find(item => item.id === route?.provider);
  const model = group?.models.find(item => item.id === route?.model);
  const efforts = model?.reasoning?.efforts ?? [];
  const selectedEffort = choice.reasoningEffort;
  const effectiveEffort = selectedEffort ?? (!custom ? catalog?.current?.reasoningEffort : undefined);
  const shapeError = error ?? modelChoiceError(value);
  const unavailable = !!catalog && ((custom && !!choice.provider && !group) || (!!route?.model && !model)
    || (!!effectiveEffort && !efforts.some(effort => effort.id === effectiveEffort)));
  const providerOptions = preserveOption((catalog?.groups ?? []).map(item => ({ value: item.id, label: optionLabel(item.name, item.id) })), choice.provider, t);
  const modelOptions = preserveOption((group?.models ?? []).map(item => ({ value: item.id, label: optionLabel(item.name, item.id) })), choice.model, t);
  // Prefix every real effort ID so the UI-only default cannot collide with a
  // provider's own identifier. No synthetic default is persisted as an effort.
  const effortOptions: SelectOption[] = [
    { value: 'default', label: t(custom ? 'modelEffortDefault' : 'modelEffortFollow') },
    ...efforts.map(effort => ({ value: `effort:${effort.id}`, label: optionLabel(effort.name, effort.id), description: effort.description })),
  ];
  if (selectedEffort && !efforts.some(effort => effort.id === selectedEffort)) effortOptions.push({ value: `effort:${selectedEffort}`, label: selectedEffort, description: t('modelSavedUnavailable') });
  const routeId = id(`${field}-route`), effortId = id(`${field}-effort`), warningId = id(`${field}-warning`);
  const change = (next: DreamModelChoice | undefined) => { if (!disabled) onChange(field, next); };
  const effortDescription = !model ? t('modelCapabilityUnknown') : !efforts.length ? t('modelNoReasoning') : t('modelEffortHelp');
  return <div className="dream-settings-model-card" data-model-branch={field}>
    <FieldSet title={t(branchLabel(field))} description={t(branchHelp(field))}>
      <Field id={routeId} label={t('modelRoute')} error={shapeError ? t(shapeError) : undefined} wide>
        <ChoiceCards id={routeId} value={mode} disabled={disabled} onChange={next => {
          if (next !== mode) change(next === 'follow' ? undefined : { provider: '', model: '' });
        }} options={[
          { value: 'follow', label: t('modelFollow'), description: t('modelFollowHelp') },
          { value: 'custom', label: t('modelCustom'), description: t('modelCustomHelp') },
        ]} />
      </Field>
      {custom && <>
        <Field id={id(`${field}-provider`)} label={t('modelProvider')} description={t('modelProviderHelp')}>
          <div role="group" aria-labelledby={`${id(`${field}-provider`)}-label`} aria-invalid={!!shapeError} aria-describedby={shapeError ? `${routeId}-error` : undefined}>
            <SearchSelect id={id(`${field}-provider`)} value={choice.provider ?? ''} options={providerOptions} t={t} disabled={disabled || !catalog?.groups.length} onChange={provider => {
              if (provider !== choice.provider) change({ provider, model: '' });
            }} />
          </div>
        </Field>
        <Field id={id(`${field}-model`)} label={t('modelName')} description={t('modelNameHelp')}>
          <div role="group" aria-labelledby={`${id(`${field}-model`)}-label`} aria-invalid={!!shapeError} aria-describedby={shapeError ? `${routeId}-error` : undefined}>
            <SearchSelect id={id(`${field}-model`)} value={choice.model ?? ''} options={modelOptions} t={t} disabled={disabled || !group?.models.length} onChange={next => {
              if (next !== choice.model) change({ provider: choice.provider ?? '', model: next });
            }} />
          </div>
        </Field>
      </>}
      <Field id={effortId} label={t('modelEffort')} description={`${effortDescription} ${custom ? t('modelEffortCustomHelp') : t('modelFollowHelp')}`} wide>
        <div role="group" aria-labelledby={`${effortId}-label`} aria-describedby={unavailable ? warningId : undefined}>
          <SearchSelect id={effortId} value={selectedEffort ? `effort:${selectedEffort}` : 'default'} options={effortOptions} t={t}
            disabled={disabled || (!efforts.length && !selectedEffort)} onChange={next => {
              const reasoningEffort = next.startsWith('effort:') ? next.slice('effort:'.length) : undefined;
              if (reasoningEffort === selectedEffort) return;
              const selection: DreamModelChoice = custom ? { provider: choice.provider ?? '', model: choice.model ?? '' } : {};
              if (reasoningEffort) selection.reasoningEffort = reasoningEffort;
              change(Object.keys(selection).length ? selection : undefined);
            }} />
        </div>
      </Field>
      {unavailable && <p id={warningId} className="dream-settings-model-warning dream-settings-field--wide" role="status">{t('modelSelectionUnavailable')}</p>}
      {(value !== undefined || shapeError) && <div className="dream-settings-model-reset dream-settings-field--wide"><Button variant="ghost" disabled={disabled} onClick={() => change(undefined)}>{t('modelReset')}</Button><span className="dream-settings-description">{t('modelResetHelp')}</span></div>}
    </FieldSet>
  </div>;
}

export function ModelsSection({ api, sessionId, draft, errors, disabled, id, onChange, t }: SectionProps) {
  const [state, setState] = React.useState<ModelCatalogState>({ sessionId, phase: typeof api.models === 'function' ? 'loading' : 'unavailable' });
  const loader = React.useRef<ReturnType<typeof createModelCatalogLoader> | null>(null);
  React.useEffect(() => {
    const current = createModelCatalogLoader(typeof api.models === 'function' ? api.models.bind(api) : undefined, setState);
    loader.current = current;
    void current.load(sessionId);
    return () => { current.dispose(); if (loader.current === current) loader.current = null; };
  }, [api, sessionId]);
  // Effects run after rendering. Hide the previous session's metadata during
  // that render as well, before the replacement request has even been started.
  const view: ModelCatalogState = state.sessionId === sessionId ? state : { sessionId, phase: 'loading' };
  const catalog = view.phase === 'success' ? view.catalog : undefined;
  return <section className="dream-settings-models" data-settings-group="models" aria-labelledby={id('models-heading')} aria-busy={view.phase === 'loading'}>
    <header className="dream-settings-subgroup-heading"><h3 id={id('models-heading')}>{t('models')}</h3><p className="dream-settings-description">{t('modelsDescription')}</p></header>
    <div className="dream-settings-model-catalog">
      <div className="dream-settings-row-heading"><p className="dream-settings-description" role={view.phase === 'error' ? 'alert' : 'status'} aria-live="polite">
        {view.phase === 'loading' ? t('modelCatalogLoading') : view.phase === 'error' ? t('modelCatalogFailed') : view.phase === 'unavailable' ? t('modelCatalogUnavailable')
          : !catalog?.groups.length ? t('modelCatalogEmpty') : t('modelCurrent')}
      </p><Button disabled={disabled || view.phase === 'loading'} onClick={() => { void loader.current?.load(sessionId); }}>{t(view.phase === 'error' || view.phase === 'unavailable' ? 'retry' : 'refresh')}</Button></div>
      {view.message && <p className="dream-settings-field-error">{view.message}</p>}
      {catalog && <p className="dream-settings-description dream-settings-mono">{catalog.current ? [catalog.current.provider, catalog.current.model, catalog.current.reasoningEffort].filter(Boolean).join(' / ') : t('modelCurrentUnknown')}</p>}
      {!!catalog?.failures.length && <div className="dream-settings-model-warning" role="status"><p>{t('modelCatalogPartial')}</p><ul>{catalog.failures.map(failure => <li key={failure.id}><strong>{optionLabel(failure.name, failure.id)}</strong>: {failure.message}</li>)}</ul></div>}
    </div>
    <div className="dream-settings-model-cards">{modelFields.map(field => <ModelChoiceCard key={field} field={field} value={draft[field]} error={errors[field]} catalog={catalog} disabled={disabled} id={id} onChange={onChange} t={t} />)}</div>
  </section>;
}
