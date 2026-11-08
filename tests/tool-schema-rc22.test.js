import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngine } from '../dist/engine.js';
import { validateConfig } from '../dist/config.js';
import { createStore } from '../dist/storage/index.js';
import { registerTools, schemaForModel } from '../dist/harness/tools.js';

const toolKeys = ['recall', 'reinforcement', 'decideCompaction', 'status', 'review', 'reviewBatch', 'readReload', 'submit', 'ackReload', 'retry'];
function registered(overrides = {}) {
  const definitions = new Map(), calls = [];
  const agent = { id: 'synthetic-owner', session: { id: 'synthetic-owner' }, ctx: {} };
  const ctx = { tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } } };
  const handlers = Object.fromEntries(toolKeys.map(key => [key, async (args, context) => { calls.push({ key, args, context }); return { ok: true }; }]));
  const dispose = registerTools(agent, { ...handlers, ...overrides }, ctx);
  const execution = { agent, signal: new AbortController().signal, callId: 'synthetic-call' };
  return { agent, definitions, calls, execution, dispose };
}

// Mirrors only the raw vocabulary verified through Host tools Inspect and its
// installed json-schema implementation; no Host import, mutation or installation.
function assertSupportedSubset(schema) {
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description']);
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema));
  for (const key of Object.keys(schema)) assert.ok(allowed.has(key), `Unsupported raw keyword: ${key}`);
  assert.ok(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type));
  if (schema.description !== undefined) assert.equal(typeof schema.description, 'string');
  if (schema.enum) {
    assert.ok(['string', 'number', 'integer', 'boolean', 'null'].includes(schema.type));
    assert.ok(schema.enum.every(value => schema.type === 'null' ? value === null : schema.type === 'integer' ? Number.isInteger(value) : typeof value === schema.type));
  }
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false);
    for (const value of Object.values(schema.properties)) assertSupportedSubset(value);
    assert.ok(schema.required.every(key => Object.hasOwn(schema.properties, key)));
  }
  if (schema.type === 'array') assertSupportedSubset(schema.items);
}

test('all registered Dream parameter schemas use the supported raw vocabulary and typed enums', () => {
  const f = registered();
  assert.equal(f.definitions.size, toolKeys.length);
  for (const definition of f.definitions.values()) assertSupportedSubset(definition.parameters);
  assert.deepEqual(f.definitions.get('dream_review').parameters.properties.decision, { type: 'string', enum: ['review', 'reject', 'defer'] });
  assert.deepEqual(f.definitions.get('dream_decide_compaction').parameters.properties.decision, { type: 'string', enum: ['compact', 'skip'] });
  assert.equal(f.definitions.get('dream_retry').parameters.properties.branch.type, 'string');
  assert.match(f.definitions.get('dream_recall').parameters.properties.limit.description, /1–50/);
  const ids = f.definitions.get('dream_review_batch').parameters.properties.proposalIds;
  assert.match(ids.description, /1–32 items/);
  assert.match(ids.description, /No duplicate items/);
  assert.match(ids.items.description, /1–4096 characters; not blank/);
  f.dispose(); assert.equal(f.definitions.size, 0);
});

test('schemaForModel is a detached pure projection and retains parameter-local constraints as annotations', () => {
  const input = { properties: {
    rows: { type: 'array', minItems: 2, maxItems: 8, uniqueItems: true, description: 'Choose rows.', items: { type: 'string', minLength: 1, maxLength: 40 } },
    mode: { enum: ['read', 'review'] }, amount: { type: 'integer', minimum: 1, maximum: 7 },
  }, required: ['rows', 'mode'] };
  const before = structuredClone(input);
  const projected = schemaForModel(input);
  assertSupportedSubset(projected);
  assert.deepEqual(input, before);
  assert.match(projected.properties.rows.description, /^Choose rows\. 2–8 items\. No duplicate items\.$/);
  assert.match(projected.properties.amount.description, /Range 1–7, inclusive/);
  projected.required.push('amount');
  projected.properties.mode.enum.push('mutated');
  projected.properties.rows.items.description = 'changed';
  assert.deepEqual(input, before);
  assert.deepEqual(schemaForModel(input).required, ['rows', 'mode']);
});

test('runtime checks retain string, numeric, array, enum and unknown-field bounds after projection', async () => {
  const f = registered();
  const invalid = [
    ['dream_recall', { query: 'x', topic: 'x', conditions: 'x', limit: 0 }],
    ['dream_recall', { query: 'x', topic: 'x', conditions: 'x', limit: 51 }],
    ['dream_recall', { query: 'x', topic: 'x', conditions: 'x', limit: 1.5 }],
    ['dream_recall', { query: ' ', topic: 'x', conditions: 'x' }],
    ['dream_recall', { query: 'x'.repeat(4097), topic: 'x', conditions: 'x' }],
    ['dream_review_batch', { jobId: 'j', proposalIds: [] }],
    ['dream_review_batch', { jobId: 'j', proposalIds: ['p', 'p'] }],
    ['dream_review_batch', { jobId: 'j', proposalIds: Array.from({ length: 33 }, (_, i) => `p${i}`) }],
    ['dream_review_batch', { jobId: 'j', proposalIds: [''] }],
    ['dream_review_batch', { jobId: 'j', proposalIds: ['p'.repeat(4097)] }],
    ['dream_review_batch', { jobId: 'j', proposalIds: ['p'], decision: 'accept' }],
    ['dream_review', { jobId: 'j', proposalId: 'p', decision: 'accept', reason: 'Forged approval' }],
    ['dream_decide_compaction', { jobId: 'j', transactionId: 'tx', decision: 'later', reason: 'Invalid choice' }],
    ['dream_retry', { jobId: 'j', branch: 'other' }],
    ['dream_reinforcement', { candidateId: 'candidate', enabled: 'true', reason: 'wrong type' }],
    ['dream_ack_reload', { jobId: 'j', transactionId: 'tx' }],
    ['dream_ack_reload', { jobId: 'j', transactionId: 'tx', readReceiptIds: [] }],
    ['dream_ack_reload', { jobId: 'j', transactionId: 'tx', readReceiptIds: Array.from({ length: 129 }, (_, i) => `r${i}`) }],
    ['dream_reload_read', { jobId: 'j', transactionId: 'tx', sourceIds: Array.from({ length: 257 }, (_, i) => `s${i}`) }],
  ];
  for (const [name, args] of invalid) await assert.rejects(f.definitions.get(name).execute(args, f.execution), /Invalid|Unknown|Provide/);
  assert.equal(f.calls.length, 0);
  await f.definitions.get('dream_recall').execute({ query: 'x', topic: 'x', conditions: 'x', limit: 50 }, f.execution);
  await f.definitions.get('dream_review_batch').execute({ jobId: 'j', proposalIds: Array.from({ length: 32 }, (_, i) => `p${i}`) }, f.execution);
  assert.equal(f.calls.length, 2);
  // The returned schema is not the private validation contract.
  f.definitions.get('dream_recall').parameters.properties.limit.description = 'No maximum';
  await assert.rejects(f.definitions.get('dream_recall').execute({ query: 'x', topic: 'x', conditions: 'x', limit: 51 }, f.execution), /Invalid limit/);
  f.dispose();
});

test('PTC guidance does not strip parent ownership or bypass native receipt restrictions', async () => {
  const config = validateConfig({ sessionId: 'synthetic-owner', memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state' });
  const actor = { agentId: 'synthetic-owner', sessionId: 'synthetic-owner' };
  const scope = { scopeId: 'synthetic-owner', ...actor, memoryRootId: config.memoryRoot };
  const engine = createEngine({ config, scope, files: {}, store: {}, host: {}, generate: async () => assert.fail('No generation') });
  const f = registered({ readReload: engine.readReload, ackReload: engine.ackReload });
  const nested = { ...f.execution, parent: { callId: 'run-code-parent', toolName: 'run_code' } };
  await assert.rejects(f.definitions.get('dream_reload_read').execute({ jobId: 'j', transactionId: 'tx' }, nested), /direct native request/);
  await assert.rejects(f.definitions.get('dream_ack_reload').execute({ jobId: 'j', transactionId: 'tx', readReceiptIds: ['r'] }, nested), /direct native request/);
  const read = f.definitions.get('dream_reload_read');
  assert.match(read.description, /Native calls only/);
  assert.match(read.description, /Under PTC.*full text.*later request/);
  const properties = f.definitions.get('dream_ack_reload').parameters.properties;
  assert.match(properties.readSourceIds.description, /including PTC.*later model request.*never in the reading run_code program/);
  assert.match(properties.readReceiptIds.description, /Native calls only.*never call this path through PTC/);
  f.dispose();
});

test('reload notification offers native receipts and a separate-request PTC full-file fallback', async () => {
  const stamp = '2026-11-06T05:30:00.000Z';
  const filesByPath = new Map(), directories = new Set(); let revision = 0, tail = Promise.resolve();
  const files = {
    async read(path) { const file = filesByPath.get(path); return file ? structuredClone(file) : null; },
    async write(path, content, version) { assert.equal(filesByPath.get(path)?.version ?? null, version); const next = ++revision; filesByPath.set(path, { content, version: next }); return next; },
    async mkdir(path) { directories.add(path); },
    async stat(path) { const file = filesByPath.get(path); return file ? { type: 'file', size: Buffer.byteLength(file.content), version: file.version } : directories.has(path) ? { type: 'directory' } : null; },
    async list(path) { return [...filesByPath.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')).map(key => ({ name: key.slice(path.length + 1), isDirectory: false })); },
    async withLock(_key, fn) { const result = tail.then(fn); tail = result.catch(() => {}); return result; },
  };
  const config = validateConfig({ sessionId: 'synthetic-owner', memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state', timeZone: 'UTC' });
  const scope = { scopeId: 'scope', agentId: config.sessionId, sessionId: config.sessionId, memoryRootId: config.memoryRoot };
  for (const directory of ['daily', 'ideas']) await files.mkdir(`${config.memoryRoot}/${directory}`);
  for (const [path, content] of [['long-term.md', 'Current synthetic memory.'], ['decisions.md', 'Current decisions.'], ['journal.md', 'Current journal.'], ['daily/2026-11-06.md', 'Synthetic daily event.']]) await files.write(`${config.memoryRoot}/${path}`, content, null);
  const memory = await files.read(`${config.memoryRoot}/long-term.md`);
  const snapshot = { schemaVersion: 1, snapshotId: 'snapshot', scope, capturedAt: stamp, sources: [{ sourceId: 'long-term.md', path: 'long-term.md', role: 'longTerm', writable: true, sensitivity: 'private', protectedText: [], ...memory }] };
  const store = createStore(files, { root: config.stateRoot, lockKey: config.memoryRoot, now: () => stamp });
  await store.saveJob({ schemaVersion: 1, jobId: 'j', scope, snapshot, state: 'awaiting_reload', proposals: [], reviews: [], appliedProposalIds: [], createdAt: stamp, updatedAt: stamp,
    transaction: { schemaVersion: 1, transactionId: 'tx', jobId: 'j', proposalIds: [], reviewIds: [], status: 'prepared', changes: [] }, compaction: { status: 'skipped' }, reload: { transactionId: 'tx', status: 'preparing' } });
  const notifications = [];
  const engine = createEngine({ config, scope, files, store, now: () => new Date(stamp), generate: async () => assert.fail('Reload retry must not regenerate'), host: { async requestReload(text) { notifications.push(text); } } });
  await engine.retry({ jobId: 'j' });
  assert.equal(notifications.length, 1);
  const prompt = notifications[0];
  assert.match(prompt, /native：直接调用dream_reload_read/);
  assert.match(prompt, /PTC\/run_code：不要在程序内调用dream_reload_read或使用readReceiptIds/);
  assert.match(prompt, /把完整原文返回给模型/);
  assert.match(prompt, /下一独立模型请求中通过run_code调用dream_ack_reload/);
  assert.match(prompt, /readSourceIds:\[已实际读完的全部sourceId\]/);
  assert.match(prompt, /禁止在同一run_code程序内先读再ACK/);
  assert.match(prompt, /禁止伪造native调用或移除parent/);
  assert.match(prompt, /不保证PTC静默/);
  assert.match(prompt, /未执行压缩/);
});
