// Adapted from shadcn/ui Base UI registry. Copyright (c) 2023 shadcn (MIT).
// Sources and full license: client/NOTICE.md and client/SHADCN_LICENSE.txt.
// Changes: plugin-scoped CSS replaces cn/Tailwind; shared Host React; portals
// are supplied by the caller so overlays inherit this plugin's theme scope.
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';

export function ShadcnSwitch({ className = '', size = 'default', ...props }: SwitchPrimitive.Root.Props & { size?: 'sm' | 'default' }) {
  return <SwitchPrimitive.Root nativeButton render={<button type="button" />} {...props} data-slot="dream-settings-switch" data-size={size} className={`dream-settings-switch ${className}`}>
    <SwitchPrimitive.Thumb data-slot="dream-settings-switch-thumb" className="dream-settings-switch-thumb" />
  </SwitchPrimitive.Root>;
}
export function ShadcnCollapsible(props: CollapsiblePrimitive.Root.Props) { return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />; }
export function ShadcnCollapsibleTrigger(props: CollapsiblePrimitive.Trigger.Props) { return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />; }
export function ShadcnCollapsibleContent(props: CollapsiblePrimitive.Panel.Props) { return <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />; }
export function ShadcnRadioGroup({ className = '', ...props }: RadioGroupPrimitive.Props) { return <RadioGroupPrimitive data-slot="radio-group" className={`dream-settings-choice-group ${className}`} {...props} />; }
export function ShadcnRadioGroupItem({ className = '', ...props }: RadioPrimitive.Root.Props) {
  return <RadioPrimitive.Root data-slot="radio-group-item" className={`dream-settings-radio ${className}`} {...props}>
    <RadioPrimitive.Indicator data-slot="radio-group-indicator" className="dream-settings-radio-indicator"><span data-slot="radio-group-indicator-icon" /></RadioPrimitive.Indicator>
  </RadioPrimitive.Root>;
}
