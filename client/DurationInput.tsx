import * as React from 'react';
import { InputGroup, InputGroupInput, InputGroupAddon } from './InputGroup.js';
import { maximumTimeoutMs } from './draft.js';
import type { TimeoutParts } from './draft.js';

/** Native grouped fields: one setting, two independently named keyboard inputs. */
export function DurationInput({ id, value, onChange, disabled, invalid, minutesLabel, secondsLabel, describedBy }: {
  id: string; value: TimeoutParts; onChange(value: TimeoutParts): void; disabled?: boolean; invalid?: boolean;
  minutesLabel: string; secondsLabel: string; describedBy?: string;
}) {
  const aria = { disabled, 'aria-invalid': !!invalid, 'aria-describedby': describedBy };
  return <InputGroup className="dream-settings-duration" aria-labelledby={`${id}-label`} data-invalid={invalid ? '' : undefined}>
    <InputGroupInput {...aria} id={id} className="dream-settings-duration-input" type="number" inputMode="numeric" min={0} max={Math.floor(maximumTimeoutMs / 60000)} step={1}
      aria-labelledby={`${id}-label ${id}-minutes-unit`} value={value.minutes} onChange={event => onChange({ ...value, minutes: event.target.value })} />
    <InputGroupAddon id={`${id}-minutes-unit`}>{minutesLabel}</InputGroupAddon>
    <InputGroupInput {...aria} id={`${id}-seconds`} className="dream-settings-duration-input" type="number" inputMode="decimal" min={0} max={59.999} step={Number.isInteger(Number(value.seconds)) ? 1 : 0.001} placeholder="0"
      aria-labelledby={`${id}-label ${id}-seconds-unit`} value={value.seconds} onChange={event => onChange({ ...value, seconds: event.target.value })} />
    <InputGroupAddon id={`${id}-seconds-unit`}>{secondsLabel}</InputGroupAddon>
  </InputGroup>;
}
