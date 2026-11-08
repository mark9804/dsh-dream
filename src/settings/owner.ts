import { Config, validateSettingsConfiguration } from './configuration.js';
import type { HostContext } from '../harness/types.js';
import type { SettingsConfiguration } from './configuration.js';
export { Config };
export const inject = ['dreamSettings', 'agents', 'fs', 'llm', 'tools', 'sandboxPolicy'];
/** This ordinary-config fiber may reload; the HTTP/UI owner is a separate row so
 * saving this document never disposes the in-flight settings response itself. */
export function apply(ctx: HostContext & { dreamSettings: { mount(context: HostContext, config: SettingsConfiguration): () => Promise<void> } }, value: unknown) {
  const config = validateSettingsConfiguration(value);
  return ctx.effect(() => ctx.dreamSettings.mount(ctx, config));
}
