// Compare maintenance only: old Q&A requests are explicitly excluded. This is a
// single real trial per version, not a statistical claim about pricing/latency.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const [previousArg, currentArg] = process.argv.slice(2), previous = resolve(previousArg ?? ''), current = resolve(currentArg ?? '');
assert.ok(previous.includes('/tests/.tmp/continuity-host-') && current.includes('/tests/.tmp/continuity-host-'));
async function measure(root, batched) {
  const json = async p => JSON.parse(await readFile(join(root, p), 'utf8'));
  const events = await json('owner-events-final.json'), manifest = await json('manifest.json'), summary = await json('summary.json');
  const steps = events.filter(e => e.type === 'step/start'), calls = events.filter(e => e.type === 'tool/call'), results = events.filter(e => e.type === 'tool/result');
  const requests = []; for (const n of (await readdir(join(root, 'audit'))).filter(n => n.endsWith('.json'))) { const a = await json('audit/' + n); if (!a.phase.startsWith('answer-')) requests.push(a); }
  const publicMessages = events.filter(e => e.type === 'assistant/message').map(e => ({ turn: e.data.turn, step: e.data.step, text: e.data.message.content.filter(b => b.type === 'text').map(b => b.text).join(''), usage: e.data.usage })).filter(e => e.text.trim());
  const toolCounts = {}; for (const e of calls) toolCounts[e.data.name] = (toolCounts[e.data.name] ?? 0) + 1;
  const usage = events.filter(e => e.type === 'assistant/message' && e.data.usage).map(e => e.data.usage), sum = field => usage.reduce((n, value) => n + (value[field] ?? 0), 0);
  const turns = events.filter(e => e.type === 'turn/end').map(e => ({ turn: e.data.turn, reason: e.data.reason }));
  assert.equal(results.length, calls.length); for (const e of results) assert.notEqual(e.data.message.isError, true, 'Tool error must be reported, not hidden as a cost improvement');
  assert.equal(summary.nights.length, 3); for (const n of summary.nights) assert.ok(['completed', 'reviewed_no_changes'].includes(n.state) || n.repeat?.reused);
  const reloadProofs = [];
  for (const call of calls.filter(e => e.data.name === 'dream_reload_read')) {
    const result = results.find(e => e.data.callId === call.data.callId || e.data.message.toolCallId === call.data.callId); assert.ok(result);
    const value = JSON.parse(result.data.message.content.filter(b => b.type === 'text').map(b => b.text).join(''));
    assert.ok(value.sources?.length && value.readReceiptId); assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 65536);
    const ack = calls.find(e => e.data.turn === call.data.turn && e.data.step > call.data.step && e.data.name === 'dream_ack_reload' && JSON.parse(e.data.arguments).readReceiptIds?.includes(value.readReceiptId)); assert.ok(ack, 'Receipt must come back in a later native model request');
    reloadProofs.push({ jobId: value.jobId, transactionId: value.transactionId, sourceIds: value.sources.map(s => s.sourceId), bytes: Buffer.byteLength(JSON.stringify(value)), separateReadAndAckSteps: true });
  }
  if (batched) { assert.equal(toolCounts.dream_review_batch, 3); assert.equal(toolCounts.dream_reload_read, 3); assert.equal(toolCounts.dream_ack_reload, 3); }
  const retries = events.filter(e => e.type === 'llm/retry-started');
  return { root, artifact: manifest.artifactSha1, fixture: manifest.fixtureSha256, isolatedMaintenanceRequests: requests.length, ownerSteps: steps.length, ownerRetryAttempts: retries.length, ownerRequests: steps.length + retries.length, maintenanceRequests: steps.length + retries.length + requests.length, toolCalls: calls.length, toolCounts, publicMessageCount: publicMessages.length, publicMessages, observedOwnerUsage: { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadTokens'), totalTokens: sum('totalTokens'), messagesWithUsage: usage.length, meaning: 'Provider inputTokens may exclude cached input; keep cacheReadTokens and totalTokens separate. Empty/error attempts lack complete usage.' }, turns, reloadProofs, excludedQuestionRequests: (await readdir(join(root, 'audit'))).filter(n => n.endsWith('.json')).length - requests.length };
}
const before = await measure(previous, false), after = await measure(current, true); assert.equal(before.fixture, after.fixture);
const compare = (a, b) => ({ before: a, after: b, saved: a - b, savedPercent: a ? Number(((a - b) * 100 / a).toFixed(1)) : null });
const result = { meaning: 'Observed one-shot same-corpus maintenance comparison, new generation/review outputs per version. Q&A excluded from both; request/token reductions are not dollar cost claims.', before, after, comparison: { requests: compare(before.maintenanceRequests, after.maintenanceRequests), ownerRequests: compare(before.ownerRequests, after.ownerRequests), toolCalls: compare(before.toolCalls, after.toolCalls), publicMessages: compare(before.publicMessageCount, after.publicMessageCount), ownerInputTokens: compare(before.observedOwnerUsage.inputTokens, after.observedOwnerUsage.inputTokens), ownerOutputTokens: compare(before.observedOwnerUsage.outputTokens, after.observedOwnerUsage.outputTokens) }, notificationChecks: { expectedFinalReports: 3, actualPublicMessages: after.publicMessageCount, noExtraProcessMessages: after.publicMessageCount === 3 }, limits: ['Simulated dates, real isolated AgentLoop, no full user persona/tool mixture or actual compaction.', 'Owner usage is public Host observed token counts; isolated usage/cached pricing not a total dollar bill.', 'concludeTurn cannot retract same-response text; mixed/unknown tools and PTC deliberately fail open.', 'No score or required memory output was relaxed to manufacture savings.'] };
await writeFile(join(current, process.argv[4] ?? 'maintenance-cost-verification.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ comparison: result.comparison, notificationChecks: result.notificationChecks, beforeToolCounts: before.toolCounts, afterToolCounts: after.toolCounts, separateReadAckReceipts: after.reloadProofs.length }, null, 2));
