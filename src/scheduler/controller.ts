import { inRestWindow } from './window.js';

import type { DreamConfig, HostControl } from '../types.js';
import { errorFields } from '../types.js';
import type { createEngine } from '../engine.js';
interface ControllerOptions { config: DreamConfig; engine: ReturnType<typeof createEngine>; host: HostControl; signal?: AbortSignal; now?: () => Date; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }

/** Polling owns only generation timing; accepted changes can progress all day. */
export function createController({ config, engine, host, signal, now = () => new Date(),
  setTimer = setTimeout, clearTimer = clearTimeout }: ControllerOptions) {
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let window: AbortController | undefined;
  let generation: Promise<unknown> | undefined;
  let polling: Promise<void> | undefined;
  let ready: Promise<boolean> | undefined;
  const notified = new Set<string>();

  function refreshWindow() {
    const allowed = !stopped && !signal?.aborted && inRestWindow(now(), config);
    if (!allowed && window) {
      window.abort(Object.assign(new Error('Dream rest window ended'), { code: 'REST_WINDOW_ENDED' }));
      window = undefined;
    }
    if (allowed && !window) window = new AbortController();
    return allowed;
  }

  function generationSignal() {
    refreshWindow();
    const current = window?.signal ?? AbortSignal.abort(Object.assign(new Error('Outside the dream rest window'), { code: 'REST_WINDOW_ENDED' }));
    return signal ? AbortSignal.any([signal, current]) : current;
  }

  async function report(error: unknown) {
    if (stopped || signal?.aborted || errorFields(error).dreamHandled || errorFields(error).code === 'REST_WINDOW_ENDED' || errorFields(error).code === 'LOCKED') return;
    const key = `${errorFields(error).code ?? 'ERROR'}:${errorFields(error).message ?? String(error)}`;
    if (notified.has(key)) return;
    notified.add(key);
    try { await host.notify(`DSH-Dream 需要处理：${errorFields(error).message ?? String(error)}。请检查插件配置与任务状态，仅向用户说明需要处理的问题。`); }
    catch { /* The Host may be unavailable; repeated polling must not flood its inbox. */ }
  }

  function tick() {
    refreshWindow();
    if (stopped || signal?.aborted) return Promise.resolve();
    if (polling) return polling;
    polling = (async () => {
      if (!await ready) return;
      if (stopped || signal?.aborted) return;
      const status = await engine.status({});
      for (const job of status.jobs!) {
        if (['applied', 'awaiting_compaction'].includes(job.state) &&
          !(config.compactionMode === 'manual' && job.deliveries?.compactionPauseDelivery)) {
          await engine.submit({ jobId: job.jobId });
        }
      }
      if (refreshWindow() && !generation) {
        const activeSignal = generationSignal();
        generation = Promise.resolve().then(() => engine.dream({ signal: activeSignal }))
          .catch(report).finally(() => { generation = undefined; });
      }
    })().catch(report).finally(() => { polling = undefined; });
    return polling;
  }

  function schedule() {
    if (stopped || signal?.aborted) return;
    const interval = 30000;
    const delay = interval - (now().getTime() % interval);
    timer = setTimer(() => {
      timer = undefined;
      void tick();
      schedule();
    }, delay);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    window?.abort(new Error('Dream scheduler stopped'));
    window = undefined;
    signal?.removeEventListener('abort', stop);
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) { stop(); return; }
      ready = Promise.resolve().then(async () => {
        if (stopped || signal?.aborted) return false;
        await engine.resume();
        return true;
      }).catch(async error => { await report(error); return false; });
      void tick();
      schedule();
    },
    tick,
    stop,
    generationSignal,
    async flush() { await ready; await polling; await generation; },
  };
}
