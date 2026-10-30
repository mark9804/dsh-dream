// Read-only verification of explicitly selected synthetic test roots.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildCleanReviewPayload } from '../dist/review/isolation.js';
const root = resolve(process.argv[2] ?? '');
const stage = process.argv[3] ?? 'completed';
assert.ok(root.startsWith(resolve(import.meta.dirname, '../tests/.tmp/clean-')));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const provenance = await json(join(root, 'provenance.json'));
const baseline = await json(join(root, 'baseline.json'));
const jobs = (await readdir(join(root, 'state/jobs'))).filter(p => p.endsWith('.json'));
assert.equal(jobs.length, 1);
const job = await json(join(root, 'state/jobs', jobs[0]));
assert.equal(job.scope.sessionId, provenance.sessionId);
if (stage === 'completed') assert.ok(['completed', 'reviewed_no_changes'].includes(job.state));
const expected = { ...baseline };
assert.equal(new Set(job.appliedProposalIds).size, job.appliedProposalIds.length);
for (const pid of job.appliedProposalIds) {
  const p = job.proposals.find(p => p.proposalId === pid);
  assert.ok(p);
  const review = job.reviews.findLast(r => r.proposalId === pid);
  assert.equal(review.decision, 'accept');
  assert.equal(review.authority.kind, 'clean-model');
  if (p.operation === 'append') expected[p.targetId] += p.after;
  else if (p.operation === 'replace') { assert.equal(expected[p.targetId].split(p.before).length, 2); expected[p.targetId] = expected[p.targetId].replace(p.before, p.after); }
  else throw new Error('Unexpected archival operation in fixture');
}
for (const [path, text] of Object.entries(expected)) assert.equal(await readFile(join(root, 'memory', path), 'utf8'), text, path);
assert.equal(await readFile(join(root, 'memory/AGENTS.md'), 'utf8'), baseline['AGENTS.md'], 'Fictional persona must remain unchanged');
const inventory = (await readdir(join(root, 'memory'), { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => join(e.parentPath, e.name).slice(join(root, 'memory').length + 1));
const lockPattern = /^\.dsh-dream-(?:generation-)?locks\/\d{12}\.(?:acquire|released)\.json$/;
assert.deepEqual(inventory.filter(p => !lockPattern.test(p)).sort(), Object.keys(baseline).sort());
for (const path of inventory.filter(p => lockPattern.test(p) && p.endsWith('.acquire.json'))) {
  const acquire = await json(join(root, 'memory', path));
  const release = await json(join(root, 'memory', path.replace('.acquire.json', '.released.json')));
  assert.equal(acquire.ownerToken, release.ownerToken);
}
const audits = await Promise.all((await readdir(join(root, 'audit'))).filter(p => p.endsWith('.json')).map(p => json(join(root, 'audit', p))));
const clean = audits.filter(a => a.messages[0].content[0].text.startsWith('Clean memory review policy'));
for (const review of job.reviews.filter(r => r.authority)) {
  const matches = clean.filter(a => a.sessionId === review.authority.callId);
  assert.equal(matches.length, 1);
  const a = matches[0];
  assert.notEqual(a.sessionId, provenance.sessionId);
  assert.equal(a.provider, review.authority.provider); assert.equal(a.model, review.authority.model);
  assert.equal(a.messages.length, 1); assert.equal(a.messages[0].role, 'user');
  const prompt = a.messages[0].content[0].text;
  for (const marker of ['DREAM_CONTAMINATION_SENTINEL', 'GENERATOR_SUMMARY_SENTINEL', 'GENERATOR_REASON_SENTINEL', 'GENERATOR_IMPACT_SENTINEL']) assert.equal(prompt.includes(marker), false);
  const text = prompt.split('\nUNTRUSTED_REVIEW_INPUT_JSON\n')[1];
  assert.ok(text);
  assert.equal(createHash('sha256').update(text).digest('hex'), review.authority.inputDigest);
  const payload = JSON.parse(text);
  assert.deepEqual(payload, buildCleanReviewPayload({ scope: review.basis.scope, sources: review.basis.sources }, review.proposalSnapshot));
  assert.deepEqual(Object.keys(payload.proposal).sort(), ['proposalId','jobId','kind','targetId','operation','before','after','evidence'].sort());
  assert.equal(payload.sources.length, Object.keys(baseline).length);
  assert.equal(payload.sources.find(s => s.role === 'persona').content, baseline['AGENTS.md']);
}
assert.equal(clean.length, job.reviews.filter(r => r.authority).length, 'Every clean request must have an inspected result; failed requests require separate diagnosis');
if (job.appliedProposalIds.length && stage === 'completed') {
  assert.equal(job.state, 'completed'); assert.ok(job.reload.acknowledgedAt);
  assert.equal(job.reload.transactionId, job.transaction.transactionId);
  assert.equal(job.compactionChoice.transactionId, job.transaction.transactionId);
  assert.equal(job.reportDelivery.state, 'sent');
  if (job.compactionChoice.decision === 'skip') { assert.equal(job.compaction.status, 'skipped'); assert.equal(job.compactionAttempts, 0); }
}
if (provenance.fixedGeneration && stage === 'completed') {
  assert.equal(job.proposals.length, 2);
  assert.equal(job.reviews.findLast(r => r.proposalId === job.proposals[0].proposalId).decision, 'accept');
  assert.equal(job.reviews.findLast(r => r.proposalId === job.proposals[1].proposalId).decision, 'reject');
  assert.deepEqual(job.appliedProposalIds, [job.proposals[0].proposalId]);
  assert.equal(audits.length, 2);
} else if (!provenance.fixedGeneration) assert.equal(audits.length - clean.length, 3);
// The installed production dist must remain byte-identical to the verified artifact.
const files = (await readdir(join(root, 'bundle/dist'), { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => join(e.parentPath, e.name).slice(join(root, 'bundle/dist').length + 1));
for (const file of files) assert.deepEqual(await readFile(join(root, 'bundle/dist', file)), await readFile(join(provenance.artifact, 'dist', file)), file);
console.log(JSON.stringify({ root, jobId: job.jobId, state: job.state, applied: job.appliedProposalIds, decisions: job.reviews.map(r=>({proposalId:r.proposalId,decision:r.decision,authority:r.authority})), compaction: job.compaction, compactionChoice: job.compactionChoice, acknowledgedAt: job.reload?.acknowledgedAt, report: job.reportDelivery, originalFixtureSources: Object.keys(baseline).length, cleanCalls: clean.length, realGenerationCalls: audits.length-clean.length, exactChanges: true, inputIsolation: true, personaUnchanged: true, artifactIdentical: true },null,2));
