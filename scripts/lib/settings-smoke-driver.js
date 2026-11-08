import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const inject = ['connection', 'dreamSettings', 'configEditor'];
export function run(ctx, root) {
  return ctx.effect(() => {
    const abort = new AbortController();
    const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2), { flag: 'wx' });
    let pending = Promise.resolve(), started = false;
    const work = async () => {
      const before = await ctx.dreamSettings.read(); assert.equal(before.enabled, false); assert.equal(before.config.sessionId, undefined); assert.equal(before.writable, true);
      await save('before.json', before);
      const entry = ctx.configEditor.entries().find(e => e.options.id === 'dsh-dream-configuration'); assert.ok(entry);
      const raw = structuredClone(entry.options.config);
      const handler = ctx.connection.createSharedFetchHandler('/api');
      const post = async (method, payload, peer = ctx.connection.browserPeer) => {
        const result = await handler.fetch(new Request(`http://localhost/api/dsh-dream/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: abort.signal }), peer);
        return { status: result.status, body: result.headers.get('content-type')?.includes('application/json') ? await result.json() : await result.text() };
      };
      const checks = [];
      try {
        const read = await post('read', {}); assert.equal(read.status, 200); assert.equal(read.body.ok, true); checks.push('owner settings HTTP read');
        const forbidden = await post('read', {}, { principal: { kind: 'synthetic-nonowner' } }); assert.equal(forbidden.status, 403); checks.push('non-owner exact route rejected');
        const invalid = await post('save', { revision: before.revision, enabled: false, config: { model: 'forbidden' } }); assert.equal(invalid.status, 400); checks.push('unknown settings rejected');
        const changed = await post('save', { revision: before.revision, enabled: false, config: { start: '04:58', end: '06:59', recallHistoryDays: 0, reinforcementBoost: 0, dreamMode: 'off', singleRun: false } });
        await save('save-response.json', changed); assert.equal(changed.status, 200); assert.equal(changed.body.ok, true); assert.equal(changed.body.value.config.recallHistoryDays, 0); assert.equal(changed.body.value.config.reinforcementBoost, 0); assert.equal(changed.body.value.enabled, false); assert.equal(changed.body.value.config.sessionId, undefined); checks.push('disabled partial config persists through real configEditor and owner reload');
        const after = await post('read', {}); assert.equal(after.body.value.config.start, '04:58'); assert.notEqual(after.body.value.revision, before.revision); checks.push('persisted revision reflected by HTTP read');
        const conflict = await post('save', { revision: before.revision, enabled: false, config: { start: '04:59', end: '07:00' } }); assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'SETTINGS_CONFLICT'); checks.push('stale real revision rejected');
        const status = await post('status', {}); assert.equal(status.body.value.state, 'unconfigured'); checks.push('business remains unconfigured and disabled');
      } finally {
        const current = ctx.configEditor.entries().find(e => e.options.id === 'dsh-dream-configuration'); assert.ok(current);
        await ctx.configEditor.edit(current, () => raw);
        const restored = await ctx.dreamSettings.read(); assert.equal(restored.enabled, false); assert.equal(restored.config.sessionId, undefined); assert.equal(restored.config.start, before.config.start); assert.deepEqual(current.options.config, raw);
        await save('restored.json', restored);
      }
      await save('verification.json', { state: 'completed', checks, modelCalls: 0, memoryRead: false, ownerSettingsRestored: true, carrier: 'real Connection shared Fetch handler and real configEditor; does not prove browser paint, socket auth or human gesture', at: new Date().toISOString() });
    };
    // Plugin activation is inside HMR's own transaction. Start only from a later
    // ordinary tool dispatch chain, never nest configEditor.edit during install.
    const off = ctx.on('tools/execute', async (exec, next) => {
      if (!started && exec.name !== 'plugin_manager') { started = true; pending = work().catch(async error => { await save('failure.json', { error: String(error?.stack ?? error), at: new Date().toISOString() }); }); }
      return next();
    });
    return async () => { off(); await pending; abort.abort(new Error('Smoke done')); };
  });
}
