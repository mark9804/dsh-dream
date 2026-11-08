import * as React from 'react';
import { createDreamSettingsApi } from './api.js';
import type { DreamLocale } from './api.js';
import { createSettingsPage } from './SettingsPage.js';
import { en, zh } from './locale.js';

interface ClientContext {
  locale: DreamLocale & { register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void };
  slots: {
    inject(owner: string, install: () => unknown): unknown;
    register(options: { name: string; id: string; order?: number; label?: () => string }, component: React.ComponentType<any>): unknown;
  };
  effect(install: () => (() => void)): unknown;
}
export const inject = ['slots', 'locale'];
export function DreamSettingsIcon({ size, active }: { size: number; active: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 1.8 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18.2 15.4A7.6 7.6 0 0 1 8.6 5.8 7.8 7.8 0 1 0 18.2 15.4Z" /><path d="m17.6 3 .5 1.7 1.7.5-1.7.5-.5 1.7-.5-1.7-1.7-.5 1.7-.5.5-1.7ZM21 9l.3 1 .9.3-.9.3-.3.9-.3-.9-.9-.3.9-.3.3-1Z" />
  </svg>;
}
export function apply(ctx: ClientContext) {
  const ns = 'dsh-dream-settings';
  ctx.effect(() => ctx.locale.register(ns, { zh, en }));
  const t = ctx.locale.bind(ns);
  const Page = createSettingsPage(createDreamSettingsApi(), ctx.locale);
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-dream', order: 45, label: () => t('title') }, Page));
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: 'dsh-dream' }, DreamSettingsIcon));
}
