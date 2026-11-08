// Verify one explicit synthetic live trial. No changes to inputs, memory or state.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2] ?? '');
assert.ok(root.startsWith(resolve(import.meta.dirname, '../tests/.tmp/memory-v2-live-')));
const json = async p => JSON.parse(await readFile(join(root, p), 'utf8'));
const meta = await json('provenance.json'), baseline = await json('baseline.json'); assert.equal(meta.synthetic, true);
assert.equal(createHash('sha1').update(await readFile(meta.archive)).digest('hex'), meta.shasum);
const final = await json('final-job.json'), status = await json('final-status.json'), result = await json('generated-result.json');
const mid = await json('memory-finished-while-dream-held.json');
assert.equal(result.mode, 'memory-v2'); assert.equal(result.dream, undefined); assert.equal(final.state, 'completed'); assert.equal(mid.job.state, 'completed'); assert.equal(mid.status.narrative.state, 'generating');
assert.equal(status.narrative.state, 'completed'); assert.equal(status.narrative.attempts, 1); assert.equal(final.compaction.status, 'skipped');
const snapshot = await json(`state/dreams/results/${final.jobId}.json`); const mod = await import(pathToFileURL(join(meta.artifact, 'dist/dream/episodes.js'))); mod.validateEpisodeDigest(result.digest, snapshot.snapshot);
const files = await json('final-memory.json');
for (const [p, text] of Object.entries(files)) assert.equal(await readFile(join(root, 'memory', p), 'utf8'), text);
for (const p of ['AGENTS.md', 'journal.md', 'ideas/uncertain.md', ...Object.keys(baseline).filter(n => n.startsWith('daily/'))]) assert.equal(files[p], baseline[p], p);
assert.equal((await readFile(join(root, 'memory/long-term.md'), 'utf8')).includes('- 合成记忆：阿澄的红杯子是在旧货店买的。'), false, 'The exact fictional wrong mug entry should be replaced; correction may preserve historical quotation');
assert.ok(files['long-term.md'].includes('小河送'));
assert.ok(result.digest.episodes.some(e => e.category === 'relationship'));
assert.ok(result.digest.episodes.some(e => ['low-priority', 'temporary'].includes(e.category) && e.retention === 'archive-only'));
const input = await json('dream-input.json'); assert.equal(input.episodes.snapshotId, snapshot.snapshot.snapshotId); assert.deepEqual(input.episodes, result.digest); assert.ok(input.conversation.messages.some(m => m.role === 'assistant')); assert.ok(input.conversation.messages.some(m => m.role === 'user'));
assert.equal(input.conversation.coverage.unavailable, 0);
const dreamTask = await json(`state/dream-tasks/${final.jobId}.json`); assert.equal(dreamTask.inputDigest, status.narrative.inputDigest); assert.equal(dreamTask.state, 'completed');
assert.equal(dreamTask.input.conversation.messages.some(m => m.sessionId !== meta.sourceId), false);
const auditNames = await readdir(join(root, 'audit')); const audits = await Promise.all(auditNames.filter(n => n.endsWith('.json')).map(n => json('audit/' + n)));
assert.equal(audits.filter(a => a.phase === 'organize').length, meta.organizerReplayPath ? 0 : 1);
if (meta.organizerReplayPath) assert.deepEqual(JSON.parse(await readFile(meta.organizerReplayPath, 'utf8')), await json('organizer-replay.json'));
 assert.equal(audits.filter(a => a.phase === 'deep').length, 1); assert.equal(audits.filter(a => a.phase === 'dream').length, 1);
assert.equal(audits.filter(a => a.phase === 'review').length, final.reviews.length); assert.equal(new Set(audits.map(a => a.id)).size, audits.length);
for (const a of audits) {
  assert.notEqual(a.id, meta.sessionId); assert.equal(a.messages.length, 1); assert.equal(a.messages[0].role, 'user');
  assert.equal(a.requestKeys.some(k => ['tools', 'system', 'toolHistory', 'replayState'].includes(k)), false);
  assert.ok((await readFile(join(root, 'raw', a.id + '.txt'), 'utf8')).trim());
  if (a.phase === 'review') { const p = JSON.parse(a.messages[0].content[0].text.split('\nUNTRUSTED_REVIEW_INPUT_JSON\n')[1]); assert.equal(p.episodes, undefined); assert.equal(p.mood, undefined); assert.equal(p.dream, undefined); }
}
const dreamAudit = audits.find(a => a.phase === 'dream'); assert.ok(Date.parse(dreamAudit.at) >= Date.parse(mid.at));
const changes = files['long-term.md']; assert.equal(changes.includes(dreamTask.output.dream), false); assert.equal(changes.includes(dreamTask.output.afterFeeling), false);
const dreamFile = await readFile(dreamTask.dreamPath, 'utf8'); assert.ok(dreamFile.includes(dreamTask.output.dream)); assert.ok(dreamFile.includes('not factual evidence'));
console.log(JSON.stringify({ root, realCalls: audits.length, provider: dreamAudit.provider, model: dreamAudit.model, organizedEpisodes: result.digest.episodes.length, categories: Object.fromEntries([...new Set(result.digest.episodes.map(e => e.category))].map(c => [c, result.digest.episodes.filter(e => e.category === c).length])), proposals: final.proposals.length, reviews: final.reviews.map(r => ({ proposalId: r.proposalId, decision: r.decision })), applied: final.appliedProposalIds.length, memoryCompletedBeforeDreamInference: true, dreamAttempts: 1, contextMessages: input.conversation.messages.length, contextUnavailable: input.conversation.coverage.unavailable, unchangedPersonaAndRawInputs: true, originalMugCorrected: true, dreamIsNotEvidence: true, shasum: meta.shasum, actualHostMaintenanceTested: false, parentCompaction: false }, null, 2));
