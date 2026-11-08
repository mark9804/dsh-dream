// Offline final-code execution against frozen real review/receipt records. No
// models, profile or installed logs: a cloned synthetic job uses read-only raw
// files plus an in-memory store. This is not a second real Host claim.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createEngine } from '../dist/engine.js';
import { createInternalTurnCompletion } from '../dist/harness/internal-turns.js';
import { createHostControl } from '../dist/harness/control.js';
import { registerTools } from '../dist/harness/tools.js';
const root = resolve(process.argv[2] ?? ''), label = process.argv[3] ?? 'final-maintenance-replay';
assert.ok(root.includes('/tests/.tmp/continuity-host-') && /^[a-z0-9-]+$/.test(label));
const json = async p => JSON.parse(await readFile(join(root, p), 'utf8'));
const fixture = await json('fixture-gold.json'), config = await json('effective-config.json'), entries = [];
for (const night of fixture.nights) {
  const final = await json('final/' + night.id + '.json'), frozen = structuredClone(final);
  let job = { ...structuredClone(final), state: 'awaiting_reload', reload: { ...structuredClone(final.reload), acknowledgedAt: undefined }, transactionHistory: undefined, reportDelivery: undefined };
  assert.ok(job.reload?.sources?.length); const sent = [], events = new Map(), definitions = new Map(), ended = [];
  const agent = { id: config.sessionId, session: { id: config.sessionId }, followup(m) { sent.push(m); } };
  const ctx = { on(name, fn) { const set = events.get(name) ?? new Set(); events.set(name, set); set.add(fn); return () => set.delete(fn); }, tools: { register(d) { definitions.set(d.name, d); return () => definitions.delete(d.name); } } };
  const completion = createInternalTurnCompletion(ctx, agent), host = createHostControl(ctx, agent, { completion });
  const sources = new Map(job.reload.sources.map(s => [s.path, { content: s.content, version: s.version }]));
  const files = { async read(path) { return structuredClone(sources.get(path) ?? null); } };
  const store = { async loadJob(id) { assert.equal(id, job.jobId); return structuredClone(job); }, async updateJob(id, fn) { assert.equal(id, job.jobId); job = await fn(structuredClone(job)); return structuredClone(job); } };
  const engine = createEngine({ config, scope: job.scope, files, store, host, generate() { throw new Error('No generation in final-code replay'); }, cleanReview() { throw new Error('No paid review in final-code replay'); }, now: () => new Date(final.reload.acknowledgedAt) });
  registerTools(agent, { readReload: engine.readReload, ackReload: engine.ackReload }, ctx, { completion });
  const emit = (name, ...args) => { for (const fn of events.get(name) ?? []) fn(...args); };
  await host.requestReload('Frozen synthetic receipt replay', { messageId: 'replay-' + night.id, jobId: job.jobId, transactionId: job.reload.transactionId });
  emit('agent/inbox/claimed', { agent, turn: 1, message: sent[0] });
  async function step(number, name, args) {
    for (const fn of events.get('agent/pre-step') ?? []) await fn({ agent, turn: 1, step: number, messages: number === 1 ? [sent[0]] : [] }, async () => ({ kind: 'enter', messages: number === 1 ? [sent[0]] : [] }));
    const callId = 'replay-call-' + number;
    emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 1, step: number, message: { content: [{ type: 'tool-call', id: callId, name }] } } });
    return definitions.get(name).execute(args, { agent, callId, signal: new AbortController().signal, concludeTurn() { ended.push({ step: number, name }); } });
  }
  const read = await step(1, 'dream_reload_read', { jobId: job.jobId, transactionId: job.reload.transactionId });
  assert.deepEqual(read.remainingSourceIds, []); assert.equal(ended.length, 0);
  const ack = await step(2, 'dream_ack_reload', { jobId: job.jobId, transactionId: job.reload.transactionId, readReceiptIds: [read.readReceiptId] });
  assert.equal(ack.acknowledged, true); assert.equal(ack.report.state, 'sent'); assert.equal(ended.length, 1); assert.equal(sent.length, 2); assert.equal(sent[1].source.purpose, 'report');
  assert.deepEqual(job.transactionHistory[0].writtenSources, frozen.transactionHistory.at(-1).writtenSources); assert.ok(job.reload.acknowledgedAt);
  entries.push({ night: night.id, sources: read.sources.map(s => s.sourceId), bytes: Buffer.byteLength(JSON.stringify(read)), readThenAckSeparateSteps: true, completed: job.state, finalReportSent: true, terminalConcluded: ended });
  completion.dispose();
}
const folder = join(root, label); await mkdir(folder);
await writeFile(join(folder, 'summary.json'), JSON.stringify({ meaning: 'Offline final-code replay using frozen real applied transaction/reload records, in-memory store and synthetic registered Host events, no generation/review/network/profile. Does not replace real trial evidence.', entries }, null, 2), { flag: 'wx' });
console.log(JSON.stringify(entries, null, 2));
