import { createSettingsService } from './service.js';
import { registerSettingsHttp } from '../harness/settings-http.js';
import type { SettingsHttpContext } from '../harness/settings-http.js';
import type { SettingsContext } from './service.js';
import { SettingsFailure } from './contracts.js';
import { createPersonaFilePicker } from '../harness/file-picker.js';
export const inject = ['connection', 'configEditor', 'agents'];
/** Always-mounted settings/UI owner. No scheduler, memory reads, or model calls. */
export function apply(ctx: SettingsContext & SettingsHttpContext & { provide(name: string, value: unknown): unknown }) {
  const service = createSettingsService(ctx);
  const filePicker = createPersonaFilePicker(ctx);
  ctx.provide('dreamSettings', service);
  ctx.effect(() => async () => { await filePicker.dispose(); await service.dispose(); });
  ctx.on('session/created', () => service.invalidateSessions());
  ctx.on('session/disposed', () => service.invalidateSessions());
  const empty = (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new SettingsFailure('INVALID_REQUEST', 'This operation takes no arguments');
  };
  registerSettingsHttp(ctx, { read: async (input, signal) => { empty(input); return service.read(signal); }, save: service.save, preflight: service.preflight, sessions: service.sessions, models: service.models,
    messages: service.messages, status: async input => { empty(input); return service.status(); }, 'pick-file': async (input, signal) => { empty(input); return filePicker.pick(signal); }, 'pick-directory': async (input, signal) => {
      empty(input);
      const picker = ctx.get('directoryPicker') as { capability(): { kind: string; pick?(signal: AbortSignal): Promise<string | null> } } | undefined;
      const capability = picker?.capability();
      if (capability?.kind !== 'native' || !capability.pick) throw new SettingsFailure('UNAVAILABLE', 'Native Host directory picker unavailable; enter the absolute Host path instead');
      return capability.pick(signal);
    },
  });
}
