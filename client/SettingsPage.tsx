import * as React from 'react';
import { GenerationDiagnostics } from './GenerationDiagnostics.js';
import { ValidationFailureDetails } from './ValidationFailureDetails.js';
import { ModelsSection } from './ModelsSection.js';
import type { DreamContextRef, DreamLocale, DreamSettingsApi, DreamSettingsSnapshot, MessageOption, OriginalBinding, Readiness, SessionOption, SettingsPageProps } from './api.js';
import { draftOf, errorMessage, isTimeoutParts, numericFields, scopeChanged, serializeDraft, stringValue } from './draft.js';
import { DurationInput } from './DurationInput.js';
import type { ConfigField, Draft, FieldErrors, NumericField } from './draft.js';
import type { LocaleKey, Translate } from './locale.js';
import { Advanced, Button, ChoiceCards, Confirmation, Field, FieldSet, MultiSelect, PortalScope, SearchSelect, Toggle } from './ui.js';
import css from './styles.css';
import { createLatestSearch, idleSearch } from './search-state.js';
import type { SearchState } from './search-state.js';

type ConfirmationKind = 'save' | 'discard' | 'reload' | 'restore' | 'close';
const namespace = 'dsh-dream-settings';
const budgetFields: NumericField[] = ['maxSourceBytes', 'maxInputBytes', 'maxOutputBytes', 'maxProposals', 'maxChangeBytes', 'maxPromotions', 'maxCandidates', 'maxEpisodes', 'timeoutMs'];
const text = stringValue;
const fieldLabel = (field: ConfigField) => `field_${field}` as LocaleKey;
const fieldHelp = (field: ConfigField) => `help_${field}` as LocaleKey;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createSettingsPage(api: DreamSettingsApi, locale: DreamLocale): React.FC<SettingsPageProps> {
  return function DreamSettingsPage({ close }: SettingsPageProps) {
    React.useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot().revision, () => 0);
    const t = locale.bind(namespace) as Translate;
    const prefix = React.useId().replace(/:/gu, '');
    const id = (field: string) => `${prefix}-${field}`;
    const [root, setRoot] = React.useState<HTMLDivElement | null>(null);
    const [snapshot, setSnapshot] = React.useState<DreamSettingsSnapshot | null>(null);
    const [draft, setDraft] = React.useState<Draft>({});
    const [enabled, setEnabled] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    const [readiness, setReadiness] = React.useState<Readiness | null>(null);
    const [checking, setChecking] = React.useState(false);
    const [errors, setErrors] = React.useState<FieldErrors>({});
    const [notice, setNotice] = React.useState<{ kind: 'error' | 'success' | 'info'; message: string } | null>(null);
    const [uncertain, setUncertain] = React.useState(false);
    const [confirmation, setConfirmation] = React.useState<ConfirmationKind | null>(null);
    const [sessions, setSessions] = React.useState<SessionOption[]>([]);
    const [sessionSearch, setSessionSearch] = React.useState<SearchState<SessionOption>>(idleSearch);
    const [picker, setPicker] = React.useState<'original' | 'dream' | null>(null);
    const [pickerSession, setPickerSession] = React.useState('');
    const [pickerQuery, setPickerQuery] = React.useState('');
    const [sourceId, setSourceId] = React.useState('');
    const [messages, setMessages] = React.useState<MessageOption[]>([]);
    const [messageCursor, setMessageCursor] = React.useState<string | undefined>();
    const [messageTruncated, setMessageTruncated] = React.useState(false);
    const [messageBusy, setMessageBusy] = React.useState(false);
    const mounted = React.useRef(true);
    const messageEpoch = React.useRef(0);
    const readAbort = React.useRef<AbortController | null>(null);
    const messageAbort = React.useRef<AbortController | null>(null);
    const preflightAbort = React.useRef<AbortController | null>(null);
    const pathAbort = React.useRef<AbortController | null>(null);
    const sessionSearcher = React.useRef<ReturnType<typeof createLatestSearch<SessionOption>> | null>(null);
    const baseline = React.useMemo(() => snapshot ? draftOf({ ...snapshot.defaults, ...snapshot.config }) : {}, [snapshot]);
    const dirty = !!snapshot && (!same(draft, baseline) || enabled !== snapshot.enabled);
    const disabled = busy || checking || loading || !snapshot?.writable;
    const allowedSessions = [...new Set([text(draft.sessionId), ...(Array.isArray(draft.sourceSessionIds) ? draft.sourceSessionIds as string[] : [])].filter(Boolean))];
    const sources = (Array.isArray(draft.originalSources) ? draft.originalSources : []) as OriginalBinding[];
    const dreamRefs = (Array.isArray(draft.dreamContextRefs) ? draft.dreamContextRefs : []) as DreamContextRef[];
    const sessionOptions = [...sessions.map(session => ({ value: session.id, label: session.title || session.id, description: [session.cwd, session.id].filter(Boolean).join(' · ') })),
      ...[...new Set([text(draft.sessionId), ...allowedSessions, pickerSession])].filter(value => value && !sessions.some(session => session.id === value)).map(value => ({ value, label: value, description: t('sessionUnavailable') }))];
    const zones = React.useMemo(() => {
      const supported = (Intl as typeof Intl & { supportedValuesOf?(key: 'timeZone'): string[] }).supportedValuesOf?.('timeZone') ?? ['Asia/Tokyo', 'Asia/Shanghai', 'Europe/London', 'America/New_York', 'UTC'];
      return [...new Set(['local', ...supported])];
    }, []);

    const accept = React.useCallback((value: DreamSettingsSnapshot) => {
      setSnapshot(value); setSessions(value.sessionOptions ?? []); setDraft(draftOf({ ...value.defaults, ...value.config })); setEnabled(value.enabled); setErrors({}); setReadiness(null); setUncertain(false);
    }, []);
    const load = React.useCallback(async () => {
      readAbort.current?.abort(); const controller = new AbortController(); readAbort.current = controller;
      setLoading(true);
      try { const value = await api.read(controller.signal); if (mounted.current && !controller.signal.aborted) { accept(value); setNotice(null); } }
      catch (error) { if (mounted.current && !controller.signal.aborted) setNotice({ kind: 'error', message: errorMessage(error, t('loadFailed')).message }); }
      finally { if (mounted.current && !controller.signal.aborted) setLoading(false); }
    }, [accept]);
    React.useEffect(() => { mounted.current = true; void load(); return () => {
      mounted.current = false; messageEpoch.current++;
      readAbort.current?.abort(); messageAbort.current?.abort(); preflightAbort.current?.abort(); pathAbort.current?.abort();
    }; }, [load]);
    React.useEffect(() => {
      const searcher = createLatestSearch<SessionOption>({
        request: (query, signal) => api.sessions({ query }, signal),
        describeError: error => errorMessage(error, t('searchFailed')).message,
        publish: state => {
          if (!mounted.current) return;
          setSessionSearch(state);
          if (state.phase === 'success') setSessions(previous => {
            const known = new Map(previous.map(item => [item.id, item]));
            for (const item of state.items) known.set(item.id, item);
            return [...known.values()];
          });
        },
      });
      sessionSearcher.current = searcher;
      return () => { searcher.dispose(); sessionSearcher.current = null; };
    }, []);
    React.useEffect(() => {
      if (!dirty) return;
      const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
      window.addEventListener('beforeunload', beforeUnload);
      return () => window.removeEventListener('beforeunload', beforeUnload);
    }, [dirty]);
    function update(field: ConfigField, value: unknown) {
      setDraft(previous => { const next = { ...previous }; if (value === undefined) delete next[field]; else next[field] = value; return next; });
      preflightAbort.current?.abort(); setChecking(false);
      setErrors(previous => ({ ...previous, [field]: undefined })); setReadiness(null); setNotice(null);
    }
    function searchSessions(query = '') { sessionSearcher.current?.search(query); }
    function closeSessionSearch() { sessionSearcher.current?.cancel(); }
    function validate(requireComplete = enabled): Record<string, unknown> | undefined {
      const result = serializeDraft(draft, { enabled: requireComplete }); setErrors(result.errors);
      if (Object.keys(result.errors).length) { setNotice({ kind: 'error', message: t('validationSummary') }); return; }
      return result.config;
    }
    async function check(config = validate(true)) {
      if (!config) return null;
      preflightAbort.current?.abort(); const controller = new AbortController(); preflightAbort.current = controller;
      setChecking(true);
      try { const result = await api.preflight({ config }, controller.signal); if (controller.signal.aborted) return null; if (mounted.current) setReadiness(result); return result; }
      catch (error) { if (mounted.current && !controller.signal.aborted) setNotice({ kind: 'error', message: errorMessage(error, t('operationFailed')).message }); return null; }
      finally { if (mounted.current && !controller.signal.aborted) setChecking(false); }
    }
    async function requestSave() {
      if (!snapshot || busy || checking || uncertain) return;
      const config = validate(); if (!config) return;
      if (enabled && (!snapshot.enabled || scopeChanged(snapshot.config, config))) {
        const ready = readiness ?? await check(config);
        if (!ready?.canEnable) { setNotice({ kind: 'error', message: t('readinessRequired') }); return; }
      }
      if (enabled !== snapshot.enabled || scopeChanged(snapshot.config, config)) setConfirmation('save');
      else await save(config);
    }
    async function save(config = validate(), confirmed = false) {
      if (!config || !snapshot) return;
      setBusy(true); setNotice(null);
      try {
        const result = await api.save({ revision: snapshot.revision, config, enabled,
          ...(confirmed && enabled && (!snapshot.enabled || scopeChanged(snapshot.config, config)) ? { confirmEnable: true as const } : {}),
          ...(confirmed && scopeChanged(snapshot.config, config) ? { confirmScope: true as const } : {}) });
        if (mounted.current) { accept(result); setConfirmation(null); setNotice({ kind: 'success', message: t('saved') }); }
      } catch (error) {
        if (!mounted.current) return;
        const failure = errorMessage(error, t('saveFailed'));
        const conflict = /CONFLICT|REVISION/u.test(failure.code);
        // Preserve the original revision and draft. A lost response can have a
        // committed Host write; do not silently resubmit against a new revision.
        setUncertain(true); setConfirmation(null); setNotice({ kind: 'error', message: conflict ? t('conflict') : `${t('saveFailed')} ${failure.message}` });
      } finally { if (mounted.current) setBusy(false); }
    }
    async function browse(field: 'memoryRoot' | 'stateRoot' | 'personaPath') {
      pathAbort.current?.abort(); const controller = new AbortController(); pathAbort.current = controller; setBusy(true);
      try { const path = field === 'personaPath' ? await api.pickFile(controller.signal) : await api.pickDirectory(controller.signal); if (mounted.current && !controller.signal.aborted && path !== null) update(field, path); }
      catch (error) { if (mounted.current && !controller.signal.aborted) setNotice({ kind: 'error', message: errorMessage(error, t(field === 'personaPath' ? 'fileUnavailable' : 'directoryUnavailable')).message }); }
      finally { if (mounted.current && !controller.signal.aborted) setBusy(false); }
    }
    function showPicker(mode: 'original' | 'dream') {
      messageAbort.current?.abort(); setMessageBusy(false);
      setPicker(mode); setPickerSession(allowedSessions[0] ?? ''); setPickerQuery(''); setMessages([]); setMessageCursor(undefined); setMessageTruncated(false); messageEpoch.current++;
    }
    async function searchMessages(more = false) {
      if (!pickerSession || !allowedSessions.includes(pickerSession) || messageBusy) return;
      const epoch = ++messageEpoch.current; setMessageBusy(true);
      messageAbort.current?.abort(); const controller = new AbortController(); messageAbort.current = controller;
      try {
        const result = await api.messages({ sessionId: pickerSession, query: pickerQuery, ...(more && messageCursor ? { cursor: messageCursor } : {}) }, controller.signal);
        if (!mounted.current || epoch !== messageEpoch.current) return;
        setMessages(previous => more ? [...previous, ...result.items] : result.items); setMessageCursor(result.cursor); setMessageTruncated(result.truncated);
      } catch (error) { if (mounted.current && epoch === messageEpoch.current) setNotice({ kind: 'error', message: errorMessage(error, t('operationFailed')).message }); }
      finally { if (mounted.current && epoch === messageEpoch.current) setMessageBusy(false); }
    }
    function selectMessage(message: MessageOption, block?: MessageOption['blocks'][number]) {
      if (disabled || !allowedSessions.includes(message.sessionId)) return;
      if (picker === 'dream') {
        if (dreamRefs.length >= 16 || dreamRefs.some(ref => ref.sessionId === message.sessionId && ref.seq === message.seq)) return;
        update('dreamContextRefs', [...dreamRefs, { sessionId: message.sessionId, seq: message.seq }]);
      } else {
        if (!block || !sourceId.trim() || sourceId.length > 512 || sourceId.startsWith('/') || sourceId.split(/[\\/]/u).includes('..') || sources.length >= 64) return;
        update('originalSources', [...sources, { sourceId: sourceId.trim(), ref: { sessionId: message.sessionId, seq: message.seq, blockIndex: block.blockIndex, quote: block.text } }]);
      }
      setPicker(null); messageEpoch.current++; messageAbort.current?.abort(); setMessageBusy(false);
    }
    function numeric(field: NumericField) {
      const rule = numericFields[field];
      return <Field key={field} id={id(field)} label={t(fieldLabel(field))} description={t(fieldHelp(field))} error={errors[field] ? t(errors[field]!) : undefined}>
        {'duration' in rule ? <DurationInput id={id(field)} value={isTimeoutParts(draft[field]) ? draft[field] : { minutes: '', seconds: '0' }} onChange={value => update(field, value)} disabled={disabled} invalid={!!errors[field]}
          minutesLabel={t('minutes')} secondsLabel={t('seconds')} describedBy={`${id(field)}-description${errors[field] ? ` ${id(field)}-error` : ''}`} /> : <div className="dream-settings-input-group"><input id={id(field)} className="dream-settings-input" type="number" inputMode="decimal" min={rule.min} max={rule.max} step={'fractional' in rule ? 'any' : 1}
          value={text(draft[field])} onChange={event => update(field, event.target.value)} disabled={disabled} aria-invalid={!!errors[field]} aria-describedby={`${id(field)}-description${errors[field] ? ` ${id(field)}-error` : ''}`} />
          {rule.unit && <span className="dream-settings-input-addon">{t(rule.unit)}</span>}</div>}
      </Field>;
    }
    function pathField(field: 'memoryRoot' | 'stateRoot' | 'personaPath') {
      return <Field key={field} id={id(field)} label={t(fieldLabel(field))} description={t(fieldHelp(field))} error={errors[field] ? t(errors[field]!) : undefined} wide>
        <div className="dream-settings-input-group"><input id={id(field)} className="dream-settings-input dream-settings-mono" type="text" value={text(draft[field])} onChange={event => update(field, event.target.value)} disabled={disabled} spellCheck={false} autoComplete="off" aria-describedby={`${id(field)}-description`} aria-invalid={!!errors[field]} />
          <Button disabled={disabled} onClick={() => void browse(field)}>{t(field === 'personaPath' ? 'browseFile' : 'browse')}</Button></div>
        {field === 'stateRoot' && !!text(snapshot?.config.stateRoot) && text(draft.stateRoot) !== text(snapshot?.config.stateRoot) && <p className="dream-settings-warning">{t('stateWarning')}</p>}
        {field === 'stateRoot' && <p className="dream-settings-description">{t('stateLocationHelp')}</p>}
      </Field>;
    }
    const modeOptions = [
      { value: 'auto', label: t('compactionAuto'), description: t('compactionAutoHelp'), badge: t('defaultLabel') },
      { value: 'agent', label: t('compactionAgent'), description: t('compactionAgentHelp'), badge: t('recommended') },
      { value: 'manual', label: t('compactionManual'), description: t('compactionManualHelp') },
    ];
    const statusLabels = { disabled: 'disabled', unconfigured: 'unconfigured', waiting_session: 'waiting', ready: 'ready', running: 'running', unavailable: 'unavailable' } as const;
    const confirmTitle = confirmation === 'save' ? (enabled !== snapshot?.enabled ? t(enabled ? 'enableTitle' : 'disableTitle') : t('scopeTitle')) : confirmation === 'restore' ? t('restoreTitle') : t('discardTitle');
    const confirmBody = confirmation === 'save'
      ? (enabled !== snapshot?.enabled ? t(enabled ? 'enableBody' : 'disableBody') : enabled ? `${t('scopeBody')} ${t('enableBody')}` : t('scopeBody'))
      : confirmation === 'restore' ? t('restoreBody') : t('discardBody');

    return <div ref={setRoot} className="dream-settings" aria-busy={loading || busy}><style>{css}</style><PortalScope.Provider value={root}>
      <header className="dream-settings-header"><div><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><Button variant="ghost" aria-label={t('close')} onClick={() => dirty ? setConfirmation('close') : close()}>×</Button></header>
      <div aria-live="polite" className="dream-settings-notice-seat">{notice && <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`dream-settings-notice dream-settings-notice--${notice.kind}`}>{notice.message}</div>}</div>
      {loading && !snapshot ? <p className="dream-settings-empty">{t('loading')}</p> : !snapshot ? <Button onClick={() => void load()}>{t('retry')}</Button> : <>
        <form onSubmit={event => { event.preventDefault(); void requestSave(); }} noValidate>
          <section className="dream-settings-basic" data-settings-group="basic" aria-labelledby={id('basic-heading')}>
            <header className="dream-settings-group-heading"><h2 id={id('basic-heading')}>{t('basic')}</h2><p className="dream-settings-description">{t('basicDescription')}</p></header>
            <section data-settings-group="daily" aria-labelledby={id('daily-heading')}>
              <header className="dream-settings-subgroup-heading"><h3 id={id('daily-heading')}>{t('daily')}</h3><p className="dream-settings-description">{t('dailyDescription')}</p></header>
              <section className="dream-settings-runtime" aria-label={t('status')}><div className="dream-settings-runtime-heading"><span className="dream-settings-badge" data-state={snapshot.status.state}>{t(statusLabels[snapshot.status.state])}</span><Button variant="ghost" disabled={busy} onClick={async () => { try { const status = await api.status(); if (mounted.current) setSnapshot(previous => previous ? { ...previous, status } : previous); } catch (error) { setNotice({ kind: 'error', message: errorMessage(error, t('operationFailed')).message }); } }}>{t('refresh')}</Button></div>
                {snapshot.status.reason && <p className="dream-settings-description">{snapshot.status.reason}</p>}
                <Toggle id={id('enabled')} label={t('enabled')} description={t('enabledDescription')} checked={enabled} disabled={disabled} onChange={value => { setEnabled(value); setNotice(null); }} />
                <div className="dream-settings-route"><span>{t('runtimeModel')}</span><span className="dream-settings-mono">{snapshot.status.model ? [snapshot.status.model.provider, snapshot.status.model.model, snapshot.status.model.reasoningEffort].filter(Boolean).join(' / ') : t('modelUnknown')}</span></div>
                <p className="dream-settings-description">{t('modelSampled')}</p>
                <GenerationDiagnostics jobs={snapshot.status.jobs} language={locale.getSnapshot().active} />
                <ValidationFailureDetails jobs={snapshot.status.jobs} language={locale.getSnapshot().active} />
              </section>
              <FieldSet title={t('schedule')} description={t('scheduleDescription')}>
                {(['start', 'end'] as const).map(field => <Field key={field} id={id(field)} label={t(fieldLabel(field))} error={errors[field] ? t(errors[field]!) : undefined}><input id={id(field)} type="time" step={60} className="dream-settings-input" value={text(draft[field])} onChange={event => update(field, event.target.value)} disabled={disabled} aria-invalid={!!errors[field]} /></Field>)}
                <p className="dream-settings-description dream-settings-field--wide">{t(text(draft.start) > text(draft.end) ? 'nextDay' : 'sameDay')}</p>
                <Field id={id('timeZone')} label={t('field_timeZone')} description={t('help_timeZone')} error={errors.timeZone ? t(errors.timeZone) : undefined} wide><SearchSelect id={id('timeZone')} value={text(draft.timeZone)} onChange={value => update('timeZone', value)} disabled={disabled} t={t}
                  options={[...new Set([...zones, text(draft.timeZone)])].filter(Boolean).map(value => ({ value, label: value === 'local' ? t('local') : value }))} /><p className="dream-settings-description">{t('hostTimeZone')}: {snapshot.hostTimeZone || t('hostZoneUnknown')}</p></Field>
              </FieldSet>
              <FieldSet title={t('behavior')} description={t('behaviorDescription')}>
                <div className="dream-settings-field--wide"><Toggle id={id('dreamMode')} checked={draft.dreamMode === 'separate'} onChange={value => update('dreamMode', value ? 'separate' : 'off')} disabled={disabled} label={t('field_dreamMode')} description={t('help_dreamMode')} /></div>
                <div className="dream-settings-field--wide"><h3 id={`${id('compactionMode')}-label`} className="dream-settings-label">{t('field_compactionMode')}</h3><ChoiceCards id={id('compactionMode')} value={text(draft.compactionMode)} onChange={value => update('compactionMode', value)} disabled={disabled} options={modeOptions} /></div>
              </FieldSet>
            </section>
            <ModelsSection api={api} sessionId={text(draft.sessionId) || undefined} draft={draft} errors={errors} disabled={disabled} id={id} onChange={update} t={t} />
            <section data-settings-group="setup" aria-labelledby={id('setup-heading')}>
              <header className="dream-settings-subgroup-heading"><h3 id={id('setup-heading')}>{t('setup')}</h3><p className="dream-settings-description">{t('setupDescription')}</p></header>
              <FieldSet title={t('target')} description={t('targetDescription')}>
                <Field id={id('sessionId')} label={t('field_sessionId')} description={t('help_sessionId')} error={errors.sessionId ? t(errors.sessionId) : undefined} wide>
                  <SearchSelect id={id('sessionId')} value={text(draft.sessionId)} onChange={value => update('sessionId', value)} options={sessionOptions} disabled={disabled} t={t} onOpen={() => searchSessions()} onClose={closeSessionSearch} onSearch={searchSessions} remoteSearch={{ phase: sessionSearch.phase, error: sessionSearch.error, values: sessionSearch.items.map(item => item.id) }} />
                  {draft.sessionId !== undefined && <code className="dream-settings-id">{text(draft.sessionId)}</code>}{sessionSearch.phase === 'success' && sessionSearch.truncated && <p className="dream-settings-description">{t('messageCoverage')}</p>}
                </Field>{pathField('memoryRoot')}{pathField('stateRoot')}{pathField('personaPath')}
              </FieldSet>
            </section>
          </section>
          <div data-settings-group="advanced"><Advanced title={t('advanced')} description={t('advancedDescription')}>
            <FieldSet title={t('recall')} description={t('recallDescription')}>{numeric('recallHistoryDays')}{(['maxRecallFiles', 'maxRecallBytes', 'reinforcementBoost'] as NumericField[]).map(numeric)}</FieldSet>
            <FieldSet title={t('development')}><div className="dream-settings-field--wide"><Toggle id={id('singleRun')} checked={draft.singleRun === true} onChange={value => update('singleRun', value)} disabled={disabled} label={t('field_singleRun')} description={t('help_singleRun')} /></div></FieldSet>
            <FieldSet title={t('budget')}>{budgetFields.map(numeric)}</FieldSet>
            <FieldSet title={t('dreamAdvanced')}>
              {numeric('dreamTimeoutMs')}{numeric('maxDreamContextBytes')}
              <div className="dream-settings-field--wide"><Toggle id={id('mood-enabled')} checked={draft.dreamMood !== undefined} onChange={value => update('dreamMood', value ? { text: '', at: new Date().toISOString() } : undefined)} disabled={disabled} label={t('moodOverride')} description={t('moodHelp')} /></div>
              {draft.dreamMood !== undefined && <><Field id={id('mood-text')} label={t('moodText')} error={errors.dreamMood ? t(errors.dreamMood) : undefined} wide><textarea id={id('mood-text')} className="dream-settings-input dream-settings-textarea" rows={3} value={text((draft.dreamMood as Record<string, unknown>).text)} disabled={disabled} onChange={event => update('dreamMood', { ...(draft.dreamMood as object), text: event.target.value })} /></Field><Field id={id('mood-at')} label={t('moodAt')} wide><input id={id('mood-at')} className="dream-settings-input dream-settings-mono" value={text((draft.dreamMood as Record<string, unknown>).at)} disabled={disabled} onChange={event => update('dreamMood', { ...(draft.dreamMood as object), at: event.target.value })} /></Field></>}
            </FieldSet>
            <FieldSet title={t('sources')}>
              <Field id={id('sourceSessionIds')} label={t('field_sourceSessionIds')} description={t('sourceSessionHelp')} error={errors.sourceSessionIds ? t(errors.sourceSessionIds) : undefined} wide><MultiSelect id={id('sourceSessionIds')} value={Array.isArray(draft.sourceSessionIds) ? draft.sourceSessionIds as string[] : []} onChange={value => update('sourceSessionIds', value)} options={sessionOptions.filter(option => option.value !== draft.sessionId)} disabled={disabled} t={t} onOpen={() => searchSessions()} onClose={closeSessionSearch} onSearch={searchSessions} remoteSearch={{ phase: sessionSearch.phase, error: sessionSearch.error, values: sessionSearch.items.map(item => item.id) }} /></Field>
              {numeric('maxOriginalBytes')}
              <div className="dream-settings-field--wide"><div className="dream-settings-row-heading"><h3>{t('field_originalSources')}</h3><Button disabled={disabled || sources.length >= 64} onClick={() => showPicker('original')}>{t('chooseMessage')}</Button></div><p className="dream-settings-description">{t('help_originalSources')} {t('verifyMeaning')}</p>
                {errors.originalSources && <p className="dream-settings-field-error">{t(errors.originalSources)}</p>}
                {!sources.length ? <p className="dream-settings-empty">{t('noBindings')}</p> : <ul className="dream-settings-records">{sources.map((item, index) => <li key={`${index}-${item.sourceId}`}><div><strong>{item.sourceId}</strong><code>{item.ref.sessionId} · {item.ref.seq} / {item.ref.blockIndex}</code><p className="dream-settings-quote">{item.ref.quote}</p></div><Button variant="ghost" disabled={disabled} aria-label={`${t('removeLocation')}: ${item.sourceId}`} onClick={() => update('originalSources', sources.filter((_, position) => index !== position))}>{t('remove')}</Button></li>)}</ul>}
              </div>
              <div className="dream-settings-field--wide"><div className="dream-settings-row-heading"><h3>{t('field_dreamContextRefs')}</h3><Button disabled={disabled || dreamRefs.length >= 16} onClick={() => showPicker('dream')}>{t('chooseMessage')}</Button></div><p className="dream-settings-description">{t('help_dreamContextRefs')}</p>
                {errors.dreamContextRefs && <p className="dream-settings-field-error">{t(errors.dreamContextRefs)}</p>}
                {!dreamRefs.length ? <p className="dream-settings-empty">{t('noDreamRefs')}</p> : <ul className="dream-settings-records">{dreamRefs.map((item, index) => <li key={`${item.sessionId}-${item.seq}`}><code>{item.sessionId} · {item.seq}</code><Button variant="ghost" disabled={disabled} aria-label={t('removeLocation')} onClick={() => update('dreamContextRefs', dreamRefs.filter((_, position) => position !== index))}>{t('remove')}</Button></li>)}</ul>}
              </div>
              {picker && <section className="dream-settings-picker dream-settings-field--wide" aria-label={t('messagePickerTitle')}><div className="dream-settings-row-heading"><h3>{t('messagePickerTitle')}</h3><Button variant="ghost" onClick={() => { setPicker(null); messageEpoch.current++; messageAbort.current?.abort(); setMessageBusy(false); }}>{t('close')}</Button></div><p className="dream-settings-description">{t('messagePickerHelp')}</p>
                <Field id={id('picker-session')} label={t('messageSession')}><SearchSelect id={id('picker-session')} value={pickerSession} onChange={value => { setPickerSession(value); setMessages([]); setMessageCursor(undefined); messageEpoch.current++; messageAbort.current?.abort(); setMessageBusy(false); }} options={sessionOptions.filter(option => allowedSessions.includes(option.value))} t={t} disabled={messageBusy} /></Field>
                {picker === 'original' && <Field id={id('source-id')} label={t('sourceId')} description={t('sourceSelectorHelp')}><input id={id('source-id')} className="dream-settings-input dream-settings-mono" maxLength={512} value={sourceId} onChange={event => setSourceId(event.target.value)} placeholder="daily/YYYY-MM-DD.md" /></Field>}
                <Field id={id('message-query')} label={t('messageQuery')}><div className="dream-settings-input-group"><input id={id('message-query')} className="dream-settings-input" value={pickerQuery} onChange={event => { setPickerQuery(event.target.value); messageEpoch.current++; messageAbort.current?.abort(); setMessageBusy(false); setMessageCursor(undefined); setMessages([]); }} /><Button disabled={!pickerSession || messageBusy} onClick={() => void searchMessages()}>{messageBusy ? t('loading') : t('messageSearch')}</Button></div></Field>
                {!messages.length && !messageBusy && <p className="dream-settings-empty">{t('messageEmpty')}</p>}
                <ul className="dream-settings-messages">{messages.map((message, index) => <li key={`${message.sessionId}-${message.seq}-${index}`}><code>{message.role} · {message.sessionId} · {message.seq}</code>
                  {picker === 'dream' ? <><p className="dream-settings-message-text">{message.text}</p><Button onClick={() => selectMessage(message)} disabled={disabled || dreamRefs.some(ref => ref.sessionId === message.sessionId && ref.seq === message.seq)}>{t('choosePosition')}</Button></> : message.blocks.map(block => <div className="dream-settings-message-block" key={block.blockIndex}><p className="dream-settings-message-text">{block.text}</p><Button disabled={disabled || !sourceId.trim()} onClick={() => selectMessage(message, block)}>{t('chooseBlock')}</Button></div>)}
                </li>)}</ul>{messageTruncated && <p className="dream-settings-description">{t('messageCoverage')}</p>}{messageCursor && <Button disabled={messageBusy} onClick={() => void searchMessages(true)}>{t('more')}</Button>}
              </section>}
            </FieldSet>
          </Advanced></div>
          <section className="dream-settings-readiness"><div className="dream-settings-row-heading"><h2>{t('readinessTitle')}</h2><Button disabled={disabled || checking} onClick={() => void check()}>{checking ? t('checking') : t('check')}</Button></div><p className="dream-settings-description">{t('readinessDescription')}</p>
            {readiness && <ul className="dream-settings-checks">{readiness.checks.map(item => <li key={item.id}><span className="dream-settings-badge" data-state={item.state}>{t(item.state)}</span><span>{item.message}</span></li>)}</ul>}
            {!!snapshot.issues.length && <ul className="dream-settings-checks">{snapshot.issues.map((issue, index) => <li key={index} className="dream-settings-field-error">{issue.field && <code>{issue.field}</code>}{issue.message}</li>)}</ul>}
          </section>
          <footer className="dream-settings-footer"><div><strong>{t(busy ? 'saving' : dirty ? 'unsaved' : 'unchanged')}</strong><p className="dream-settings-description">{t('saveHint')}</p></div><div className="dream-settings-footer-actions">
            <Button variant="ghost" disabled={busy || checking} onClick={() => setConfirmation('restore')}>{t('restore')}</Button>
            {uncertain ? <Button disabled={busy} onClick={() => setConfirmation('reload')}>{t('reload')}</Button> : <Button disabled={disabled || !dirty} onClick={() => setConfirmation('discard')}>{t('discard')}</Button>}
            <Button variant="primary" type="submit" disabled={disabled || checking || !dirty || uncertain}>{busy ? t('saving') : t('save')}</Button>
          </div></footer>
        </form>
      </>}
      <Confirmation open={confirmation !== null} title={confirmTitle} description={confirmBody} t={t} pending={busy} onCancel={() => setConfirmation(null)} onConfirm={() => {
        if (confirmation === 'save') void save(undefined, true);
        else if (confirmation === 'restore' && snapshot) { setDraft(draftOf({ ...snapshot.defaults, ...snapshot.inherited })); setErrors({}); setReadiness(null); setConfirmation(null); setNotice({ kind: 'info', message: t('inheritedPreview') }); }
        else if (confirmation === 'reload') { setConfirmation(null); void load(); }
        else if (confirmation === 'close') { setConfirmation(null); close(); }
        else if (snapshot) { setDraft(baseline); setEnabled(snapshot.enabled); setErrors({}); setReadiness(null); setConfirmation(null); }
      }}>
        {confirmation === 'save' && snapshot && <dl className="dream-settings-confirm-summary"><dt>{t('field_sessionId')}</dt><dd>{text(draft.sessionId)}</dd><dt>{t('field_memoryRoot')}</dt><dd>{text(draft.memoryRoot)}</dd><dt>{t('field_stateRoot')}</dt><dd>{text(draft.stateRoot)}</dd></dl>}
      </Confirmation>
    </PortalScope.Provider></div>;
  };
}
