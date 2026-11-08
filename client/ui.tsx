import * as React from 'react';
import { ShadcnSwitch, ShadcnRadioGroup, ShadcnRadioGroupItem, ShadcnCollapsible, ShadcnCollapsibleTrigger, ShadcnCollapsibleContent } from './shadcn.js';
import { Combobox } from '@base-ui/react/combobox';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import type { Translate } from './locale.js';
import { localOptionMatches, searchStatus } from './search-state.js';
import type { SearchPhase } from './search-state.js';

export const PortalScope = React.createContext<HTMLElement | null>(null);
export function Button({ variant = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button type="button" {...props} className={`dream-settings-button dream-settings-button--${variant} ${className}`} />;
}
export function Field({ id, label, description, error, children, wide = false }: {
  id: string; label: string; description?: string; error?: string; children: React.ReactNode; wide?: boolean;
}) {
  return <div className={`dream-settings-field${wide ? ' dream-settings-field--wide' : ''}`} data-invalid={error ? '' : undefined}>
    <label id={`${id}-label`} className="dream-settings-label" htmlFor={id}>{label}</label>
    {children}
    {description && <p className="dream-settings-description" id={`${id}-description`}>{description}</p>}
    {error && <p className="dream-settings-field-error" id={`${id}-error`} role="alert">{error}</p>}
  </div>;
}
export function FieldSet({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <fieldset className="dream-settings-fieldset"><legend>{title}</legend>{description && <p className="dream-settings-section-description">{description}</p>}<div className="dream-settings-fields">{children}</div></fieldset>;
}
export function Toggle({ id, checked, onChange, disabled, label, description }: { id: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean; label: string; description?: string }) {
  return <div className="dream-settings-toggle-row"><div><label htmlFor={id} className="dream-settings-label">{label}</label>{description && <p id={`${id}-description`} className="dream-settings-description">{description}</p>}</div>
    <ShadcnSwitch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-describedby={description ? `${id}-description` : undefined} /></div>;
}
export function ChoiceCards({ id, value, onChange, disabled, options }: { id: string; value: string; onChange(value: string): void; disabled?: boolean; options: Array<{ value: string; label: string; description: string; badge?: string }> }) {
  return <ShadcnRadioGroup id={id} value={value} onValueChange={value => onChange(String(value))} disabled={disabled} className="dream-settings-choice-group" aria-labelledby={`${id}-label`}>
    {options.map(option => <label className="dream-settings-choice" key={option.value} data-selected={value === option.value ? '' : undefined}>
      <ShadcnRadioGroupItem value={option.value} />
      <span><span className="dream-settings-choice-title">{option.label}{option.badge && <span className="dream-settings-badge">{option.badge}</span>}</span><span className="dream-settings-description">{option.description}</span></span>
    </label>)}
  </ShadcnRadioGroup>;
}
export function Advanced({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <ShadcnCollapsible className="dream-settings-advanced"><ShadcnCollapsibleTrigger className="dream-settings-advanced-trigger"><span><span className="dream-settings-section-title">{title}</span><span className="dream-settings-description">{description}</span></span><Chevron /></ShadcnCollapsibleTrigger><ShadcnCollapsibleContent className="dream-settings-advanced-panel">{children}</ShadcnCollapsibleContent></ShadcnCollapsible>;
}
export function Chevron() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>; }
export interface SelectOption { value: string; label: string; description?: string }
interface RemoteSearch { phase: SearchPhase; error: string | null; values: string[] }
interface SearchOptions { options: SelectOption[]; disabled?: boolean; t: Translate; onSearch?(query: string): void; onOpen?(): void; onClose?(): void; remoteSearch?: RemoteSearch }
function SearchFeedback({ remoteSearch, t }: { remoteSearch?: RemoteSearch; t: Translate }) {
  const status = remoteSearch ? searchStatus(remoteSearch.phase) : null;
  return <><Combobox.Status className="dream-settings-search-status" data-search-state={remoteSearch?.phase}>
    {status && <span>{remoteSearch?.phase === 'loading' && <span className="dream-settings-search-spinner" aria-hidden="true" />}{t(status)}{remoteSearch?.phase === 'error' && remoteSearch.error && <small>{remoteSearch.error}</small>}</span>}
  </Combobox.Status><Combobox.Empty className="dream-settings-empty">{!remoteSearch || remoteSearch.phase === 'success' ? t('noResults') : null}</Combobox.Empty></>;
}
export function SearchSelect({ id, value, onChange, options, disabled, t, onSearch, onOpen, onClose, remoteSearch }: SearchOptions & { id: string; value: string; onChange(value: string): void }) {
  const container = React.useContext(PortalScope);
  const labels = React.useMemo(() => new Map(options.map(option => [option.value, option])), [options]);
  return <Combobox.Root items={options.map(option => option.value)} value={value || null} onValueChange={next => onChange(next ?? '')}
    filter={remoteSearch ? null : (item, query) => localOptionMatches(labels.get(String(item)), query)}
    filteredItems={remoteSearch ? remoteSearch.phase === 'success' ? remoteSearch.values.filter(item => labels.has(item)) : [] : undefined}
    itemToStringLabel={item => labels.get(String(item))?.label ?? String(item)} onOpenChange={open => { if (open) onOpen?.(); else onClose?.(); }}
    onInputValueChange={(query, details) => { if (details.reason === 'input-change' || details.reason === 'input-clear') onSearch?.(query); }} disabled={disabled}>
    <div className="dream-settings-combobox-control"><Combobox.Input id={id} className="dream-settings-input" placeholder={t('search')} autoComplete="off" aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} />
      <Combobox.Trigger className="dream-settings-combobox-trigger" aria-label={t('choose')}><Chevron /></Combobox.Trigger></div>
    {container && <Combobox.Portal container={container}><Combobox.Positioner className="dream-settings-positioner" sideOffset={5} align="start"><Combobox.Popup className="dream-settings-popup">
      <SearchFeedback remoteSearch={remoteSearch} t={t} /><Combobox.List className="dream-settings-list" aria-busy={remoteSearch?.phase === 'loading'}>
        {(item: string) => <Combobox.Item key={item} value={item} className="dream-settings-option"><span>{labels.get(item)?.label ?? item}{labels.get(item)?.description && <small>{labels.get(item)?.description}</small>}</span><Combobox.ItemIndicator aria-hidden="true">✓</Combobox.ItemIndicator></Combobox.Item>}
      </Combobox.List>
    </Combobox.Popup></Combobox.Positioner></Combobox.Portal>}
  </Combobox.Root>;
}
export function MultiSelect({ id, value, onChange, options, disabled, t, onSearch, onOpen, onClose, remoteSearch }: SearchOptions & { id: string; value: string[]; onChange(value: string[]): void }) {
  const container = React.useContext(PortalScope);
  const labels = React.useMemo(() => new Map(options.map(option => [option.value, option])), [options]);
  return <Combobox.Root multiple items={options.map(option => option.value)} value={value} onValueChange={next => onChange([...next])}
    filter={remoteSearch ? null : (item, query) => localOptionMatches(labels.get(String(item)), query)}
    filteredItems={remoteSearch ? remoteSearch.phase === 'success' ? remoteSearch.values.filter(item => labels.has(item)) : [] : undefined}
    itemToStringLabel={item => labels.get(String(item))?.label ?? String(item)} disabled={disabled}
    onOpenChange={open => { if (open) onOpen?.(); else onClose?.(); }} onInputValueChange={(query, details) => { if (details.reason === 'input-change' || details.reason === 'input-clear') onSearch?.(query); }}>
    <Combobox.Chips className="dream-settings-chips" aria-label={t('sourceSessionsSelected')}>
      {value.map(item => <Combobox.Chip key={item} className="dream-settings-chip" aria-description={t('sourceSessionsKeyboard')}>
        {labels.get(item)?.label ?? item}<Combobox.ChipRemove className="dream-settings-chip-remove" aria-label={`${t('sourceSessionRemove')}: ${labels.get(item)?.label ?? item}`}>×</Combobox.ChipRemove>
      </Combobox.Chip>)}<Combobox.Input id={id} className="dream-settings-chip-input" placeholder={t('search')} aria-description={t('sourceSessionsKeyboard')} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} />
    </Combobox.Chips>
    {container && <Combobox.Portal container={container}><Combobox.Positioner className="dream-settings-positioner" sideOffset={5} align="start"><Combobox.Popup className="dream-settings-popup"><SearchFeedback remoteSearch={remoteSearch} t={t} /><Combobox.List className="dream-settings-list" aria-busy={remoteSearch?.phase === 'loading'}>
      {(item: string) => <Combobox.Item key={item} value={item} className="dream-settings-option"><span>{labels.get(item)?.label ?? item}<small>{item}</small></span><Combobox.ItemIndicator aria-hidden="true">✓</Combobox.ItemIndicator></Combobox.Item>}
    </Combobox.List></Combobox.Popup></Combobox.Positioner></Combobox.Portal>}
  </Combobox.Root>;
}
export function Confirmation({ open, title, description, children, onCancel, onConfirm, t, confirmLabel, pending = false }: { open: boolean; title: string; description: string; children?: React.ReactNode; onCancel(): void; onConfirm(): void; t: Translate; confirmLabel?: string; pending?: boolean }) {
  const container = React.useContext(PortalScope);
  const cancel = React.useRef<HTMLButtonElement>(null);
  return <AlertDialog.Root open={open} onOpenChange={value => { if (!value && !pending) onCancel(); }}>
    {container && <AlertDialog.Portal container={container}><AlertDialog.Backdrop className="dream-settings-modal-backdrop" /><AlertDialog.Popup className="dream-settings-modal" initialFocus={cancel}>
      <AlertDialog.Title className="dream-settings-modal-title">{title}</AlertDialog.Title><AlertDialog.Description className="dream-settings-description">{description}</AlertDialog.Description>{children}
      <div className="dream-settings-modal-actions"><button ref={cancel} type="button" className="dream-settings-button dream-settings-button--secondary" disabled={pending} onClick={onCancel}>{t('cancel')}</button><Button variant="primary" disabled={pending} onClick={onConfirm}>{pending ? t('saving') : confirmLabel ?? t('confirm')}</Button></div>
    </AlertDialog.Popup></AlertDialog.Portal>}
  </AlertDialog.Root>;
}
