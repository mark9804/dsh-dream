import * as React from 'react';

/** Original native InputGroup composition, scoped to the Dream settings theme. */
export function InputGroup({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div role="group" {...props} data-slot="dream-settings-input-group" className={`dream-settings-input-group ${className}`} />;
}
export function InputGroupInput({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} data-slot="dream-settings-input-group-control" className={`dream-settings-input ${className}`} />;
}
export function InputGroupAddon({ className = '', ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} data-slot="dream-settings-input-group-addon" className={`dream-settings-input-addon ${className}`} />;
}
