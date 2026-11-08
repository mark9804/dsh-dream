import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { recallMemory } from '../dist/dream/recall.js';
import { annotateSnapshot, candidateId, candidateView } from '../dist/dream/lineage.js';
import { cleanReviewDigest, reviewPolicyVersion } from '../dist/review/isolation.js';
import { recordReview } from '../dist/review/index.js';

// Synthetic in-memory fixtures only. No files, Host, models, hooks or real memory.
const scope = { scopeId: 'synthetic-scope', agentId: 'synthetic-agent', sessionId: 'synthetic-session', memoryRootId: 'synthetic-root' };
const actor = { agentId: scope.agentId, sessionId: scope.sessionId };
const at = day => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const now = new Date(at(20));
const request = { query: 'mint tea', topic: 'drinks', conditions: 'at lunch' };
const options = { now };
const fragment = 'Synthetic mint tea at lunch.';
const source = (sourceId, content = fragment, extra = {}) => ({ sourceId, path: `daily/${sourceId}.md`, role: 'daily', content,
  version: { revision: 1 }, writable: true, sensitivity: 'private', protectedText: [], ...extra });
const snapshot = (sources = [source('a-baseline'), source('z-retained')], extra = {}) => ({ schemaVersion: 1,
  snapshotId: 'synthetic-snapshot', scope: structuredClone(scope), capturedAt: at(1), sources, ...extra });

function proposal(id = 'reinforce', extra = {}) {
  return { schemaVersion: 1, proposalId: id, jobId: `job-${id}`, kind: 'preference',
    text: 'UNTRUSTED_GENERATOR_SUMMARY', reason: 'UNTRUSTED_GENERATOR_REASON', evidence: [{ sourceId: 'z-retained', quote: fragment }],
    targetId: 'z-retained', operation: 'retain', before: fragment, after: fragment,
    consolidation: { action: 'reinforce', claimKey: 'synthetic-lunch-drink', applicability: { topic: 'drinks', conditions: 'at lunch' }, basis: 'explicit' }, ...extra };
}

function makeJob(snap, p = proposal(), day = 2, decision = 'accept') {
  const job = { schemaVersion: 1, jobId: p.jobId, scope: structuredClone(snap.scope), snapshot: structuredClone(snap),
    state: 'awaiting_review', proposals: [p], reviews: [], appliedProposalIds: [], createdAt: at(day), updatedAt: at(day) };
  return addReview(job, decision, day);
}

function addReview(job, decision, day, p = job.proposals[0]) {
  return recordReview(job, { jobId: job.jobId, proposalId: p.proposalId, decision, reason: 'Synthetic reviewed decision.' },
    { agentId: job.scope.agentId, sessionId: job.scope.sessionId }, { reviewId: `review-${p.proposalId}-${day}`, now: at(day),
      ...(decision === 'accept' ? { authority: { kind: 'clean-model', policyVersion: reviewPolicyVersion(job.snapshot, p),
        inputDigest: cleanReviewDigest(job.snapshot, p), callId: `isolated-${p.proposalId}-${day}`, provider: 'synthetic', model: 'synthetic' } } : {}) });
}

const control = (p, enabled, day, extra = {}) => ({ schemaVersion: 1, candidateId: candidateId(p.consolidation, scope), enabled,
  reason: 'Synthetic priority control.', actor: structuredClone(actor), at: at(day), scope: structuredClone(scope), ...extra });
// Isolate the original ranking/authority contract; grouping and operation links
// have dedicated integration suites using the new production defaults.
const retrieve = (snap, history = [], controls = [], req = request, opts = options) => recallMemory(snap, history, controls, req, { aggregate: false, useRelations: false, ...opts });
const retained = result => result.hits.find(hit => hit.sourceId === 'z-retained');
const diagnostic = result => result.coverage.reinforcement.items[0];
const noBoost = result => assert.ok(result.hits.every(hit => hit.reinforcementBoost === 0));

function original(status = 'verified') {
  return { schemaVersion: 1, ref: { sessionId: 'original-synthetic-session', seq: 1, blockIndex: 0, quote: fragment }, status,
    ...(status === 'verified' ? { canonical: { sessionId: 'original-synthetic-session', seq: 1, messageId: 'original-message',
      role: 'user', sourceKind: 'human', eventHash: 'a'.repeat(64) } } : { reason: 'Synthetic original source unavailable.' }),
    independentEvents: 'unknown' };
}

test('baseline returns actual current paragraphs with source/version and exact raw-content proof', () => {
  const snap = snapshot([source('z-retained', `Unrelated bicycle paragraph.\n\n${fragment}\n\nA third irrelevant paragraph.`), source('a-baseline')]);
  const result = retrieve(snap);
  assert.deepEqual(result.hits.map(hit => hit.sourceId), ['a-baseline', 'z-retained']);
  assert.equal(result.hits.length, 2);
  for (const hit of result.hits) {
    const input = snap.sources.find(item => item.sourceId === hit.sourceId);
    assert.equal(hit.text, fragment);
    assert.equal(hit.path, input.path);
    assert.deepEqual(hit.version, input.version);
    assert.equal(hit.baseScore, 1);
    assert.equal(hit.reinforcementBoost, 0);
    assert.equal(hit.score, hit.baseScore);
    assert.equal(input.content.slice(hit.proof.start, hit.proof.end), hit.text);
    assert.equal(hit.proof.contentHash, createHash('sha256').update(input.content).digest('hex'));
    assert.equal(hit.proof.textBytes, Buffer.byteLength(hit.text));
    assert.equal(hit.proof.truncated, false);
    assert.equal(hit.sourceVerification.independentEvents, 'unknown');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(result.coverage.resultsTruncated, false);
});

test('historical recall cannot revive a reinforcement approval whose ordinary current basis rolled over', () => {
  const original = snapshot(); const job = makeJob(original);
  const current = snapshot([structuredClone(original.sources[1])]);
  const expanded = structuredClone(original);
  const result = retrieve(expanded, [job], [], request, { now, reinforcementBasis: current });
  noBoost(result); assert.ok(diagnostic(result).disabledReasons.includes('current-basis-changed'));
  assert.ok(result.hits.every(h => h.sourceRole === 'daily' && h.temporalStatus === 'dated-record-not-current-status'));
  assert.throws(() => retrieve(expanded, [job], [], request, { now, reinforcementBasis: snapshot([source('z-retained', 'different text')]) }), /basis differs/);
  assert.throws(() => retrieve(expanded, [job], [], request, { now, reinforcementBasis: { ...current, scope: { ...scope, sessionId: 'foreign' } } }), /scope mismatch/);
});

test('clean accepted reinforce reorders equally relevant sources without changing their lexical score', () => {
  const snap = snapshot();
  const job = makeJob(snap);
  const result = retrieve(snap, [job]);
  assert.equal(result.hits[0].sourceId, 'z-retained');
  assert.equal(result.hits[0].baseScore, 1);
  assert.equal(result.hits[0].reinforcementBoost, 0.25);
  assert.equal(result.hits[0].score, 1.25);
  assert.equal(result.hits[1].reinforcementBoost, 0);
  assert.equal(result.hits[0].candidateId, candidateId(job.proposals[0].consolidation, scope));
  assert.deepEqual(result.hits[0].applicability, { topic: 'drinks', conditions: 'at lunch' });
  assert.equal(diagnostic(result).eligible, true);
  assert.deepEqual(diagnostic(result).disabledReasons, []);
});

test('ten repeated approvals and duplicated history never accumulate boost', () => {
  const snap = snapshot();
  const history = Array.from({ length: 10 }, (_, i) => makeJob(snap, proposal(`repeat-${i}`), i + 2));
  const result = retrieve(snap, [...history, ...history].reverse());
  assert.equal(retained(result).reinforcementBoost, 0.25);
  assert.equal(result.coverage.reinforcement.total, 1);
  assert.equal(diagnostic(result).reviewId, 'review-repeat-9-11');
  assert.equal(retained(retrieve(snap, history, [], request, { now, boost: 0.1 })).reinforcementBoost, 0.1);
  assert.equal(retained(retrieve(snap, history, [], request, { now, boost: 100 })).reinforcementBoost, 1);
  noBoost(retrieve(snap, history, [], request, { now, boost: -2 }));
});

test('topic and conditions require exact explicitly documented normalized equality, not synonyms or subsets', () => {
  const snap = snapshot();
  const job = makeJob(snap);
  const normalized = retrieve(snap, [job], [], { ...request, topic: '  ＤＲＩＮＫＳ  ', conditions: 'AT\t LUNCH' });
  assert.equal(retained(normalized).reinforcementBoost, 0.25);
  assert.match(normalized.policy.applicability, /NFKC.*exact|exact.*NFKC/u);
  assert.deepEqual(normalized.policy.normalizedRequest, { topic: 'drinks', conditions: 'at lunch' });
  for (const [changes, reason] of [[{ topic: 'beverages' }, 'topic-mismatch'], [{ topic: 'drink' }, 'topic-mismatch'],
    [{ conditions: 'at dinner' }, 'conditions-mismatch'], [{ conditions: 'at lunch on weekdays' }, 'conditions-mismatch']]) {
    const result = retrieve(snap, [job], [], { ...request, ...changes });
    noBoost(result);
    assert.ok(diagnostic(result).disabledReasons.includes(reason));
    assert.deepEqual(diagnostic(result).applicability, job.proposals[0].consolidation.applicability);
  }
});

test('inclusive validity bounds use the injected now; out-of-period candidates remain baseline only', () => {
  const snap = snapshot();
  const p = proposal();
  p.consolidation.applicability.validFrom = at(10);
  p.consolidation.applicability.validUntil = at(20);
  const job = makeJob(snap, p);
  for (const day of [10, 15, 20]) assert.equal(retained(retrieve(snap, [job], [], request, { now: new Date(at(day)) })).reinforcementBoost, 0.25);
  const early = retrieve(snap, [job], [], request, { now: new Date(at(9)) });
  noBoost(early); assert.ok(diagnostic(early).disabledReasons.includes('not-yet-valid'));
  const late = retrieve(snap, [job], [], request, { now: new Date(at(21)) });
  noBoost(late); assert.ok(diagnostic(late).disabledReasons.includes('expired'));
});

test('revoke disables and reactivate restores only an otherwise eligible existing approval', () => {
  const snap = snapshot(), p = proposal(), job = makeJob(snap, p);
  const revoke = control(p, false, 5), enable = control(p, true, 6);
  const disabled = retrieve(snap, [job], [revoke]);
  noBoost(disabled); assert.ok(diagnostic(disabled).disabledReasons.includes('control-disabled'));
  assert.equal(retained(retrieve(snap, [job], [enable, revoke])).reinforcementBoost, 0.25);
  noBoost(retrieve(snap, [], [enable]));
  const changed = structuredClone(snap); changed.sources[0].version = 2;
  noBoost(retrieve(changed, [job], [enable]));
  noBoost(retrieve(snap, [job], [enable], { ...request, conditions: 'at dinner' }));
  noBoost(retrieve(snap, [job], [enable, { ...revoke, at: enable.at }]));
});

test('controls are exact-scope, actor-bound and timestamped; future or malformed controls cannot toggle priority', () => {
  const snap = snapshot(), p = proposal(), job = makeJob(snap, p);
  const ignored = [control(p, false, 21), control(p, false, 5, { actor: { ...actor, agentId: 'foreign' } }),
    control(p, false, 5, { at: 'not-a-date' }), control(p, false, 5, { enabled: 'false' })];
  for (const key of Object.keys(scope)) ignored.push(control(p, false, 5, { scope: { ...scope, [key]: `foreign-${key}` } }));
  const result = retrieve(snap, [job], ignored);
  assert.equal(retained(result).reinforcementBoost, 0.25);
  assert.equal(result.coverage.controlsIgnored, ignored.length);
  const revoked = control(p, false, 5);
  noBoost(retrieve(snap, [job], [revoked, control(p, true, 6, { scope: { ...scope, sessionId: 'foreign' } })]));
});

for (const decision of ['reject', 'defer']) test(`later ${decision} in the same or a newer job suspends prior reinforcement`, () => {
  const snap = snapshot(), prior = makeJob(snap);
  for (const history of [[addReview(prior, decision, 5)], [makeJob(snap, proposal('later'), 5, decision), prior]]) {
    const result = retrieve(snap, history);
    noBoost(result);
    assert.ok(diagnostic(result).disabledReasons.includes(decision === 'reject' ? 'review-rejected' : 'review-deferred'));
    noBoost(retrieve(snap, history, [control(prior.proposals[0], true, 6)]));
  }
});

for (const action of ['keep', 'needs-verification', 'correct', 'merge']) test(`a newer reviewed ${action} action suspends older same-candidate reinforcement`, () => {
  const snap = snapshot(), prior = makeJob(snap), p = proposal(`later-${action}`);
  p.consolidation.action = action;
  if (['correct', 'merge'].includes(action)) { p.operation = 'replace'; p.after = 'Synthetic corrected mint tea statement.'; }
  const result = retrieve(snap, [makeJob(snap, p, 5), prior]);
  noBoost(result);
  assert.ok(diagnostic(result).disabledReasons.includes('not-reinforce'));
  assert.equal(diagnostic(result).candidateId, candidateId(prior.proposals[0].consolidation, scope));
});

test('same-timestamp veto wins over reinforcement independent of history ordering', () => {
  const snap = snapshot(), accept = makeJob(snap), veto = makeJob(snap, proposal('veto'), 2, 'reject');
  noBoost(retrieve(snap, [accept, veto]));
  noBoost(retrieve(snap, [veto, accept]));
});

test('stale, invalidated, manual or corrupted later acceptance never resurrects an older approval', () => {
  const snap = snapshot(), prior = makeJob(snap), later = makeJob(snap, proposal('later'), 5);
  const mutations = [job => { job.invalidatedReviewIds = [job.reviews[0].reviewId]; },
    job => { delete job.reviews[0].authority; }, job => { job.reviews[0].authority.inputDigest = 'forged'; },
    job => { job.proposals[0].reason = 'Changed after review'; }, job => { job.reviews[0].reviewedAt = 'not-a-date'; },
    job => { job.reviews[0].reviewer.agentId = 'foreign'; }];
  for (const mutate of mutations) {
    const broken = structuredClone(later); mutate(broken);
    const result = retrieve(snap, [prior, broken]);
    noBoost(result); assert.ok(diagnostic(result).disabledReasons.includes('invalid-review'));
  }
  const other = structuredClone(snap); other.sources[0].version = 2;
  noBoost(retrieve(snap, [prior, makeJob(other, proposal('other-basis'), 5)]));
});

test('all current reviewed source bytes and versions must match, even uncited sources', () => {
  const snap = snapshot(), job = makeJob(snap);
  const changes = [s => { s.sources[1].version = 2; }, s => { s.sources[1].content += ' Changed'; },
    s => { s.sources[0].version = 2; }, s => { s.sources[0].content += ' Contradiction'; },
    s => { s.sources[0].path = 'daily/renamed.md'; }, s => { s.sources.pop(); },
    s => { s.sources.push(source('new-context')); }, s => { s.sources[0].protectedText.push(fragment); },
    s => { s.sources[0].sensitivity = 'sensitive'; }];
  for (const mutate of changes) {
    const current = structuredClone(snap); mutate(current);
    const result = retrieve(current, [job]);
    noBoost(result); assert.ok(diagnostic(result).disabledReasons.includes('current-basis-changed'));
  }
  const revised = structuredClone(snap); revised.sources[0].version = 2;
  const fresh = makeJob(revised, proposal('fresh'), 6);
  assert.equal(retained(retrieve(revised, [job, fresh])).reinforcementBoost, 0.25);
});

test('changed applied text invalidates priority by version; restoring bytes does not restore old authority', () => {
  const snap = snapshot(), job = makeJob(snap);
  const current = structuredClone(snap);
  current.sources[1].content = 'Synthetic coffee instead of mint tea.'; current.sources[1].version = { revision: 2 };
  noBoost(retrieve(current, [job]));
  current.sources[1].content = fragment; current.sources[1].version = { revision: 3 };
  const result = retrieve(current, [job]);
  noBoost(result);
  assert.ok(diagnostic(result).disabledReasons.includes('current-basis-changed'));
});

test('new provenance or candidate views do not invalidate unchanged reviewed source bytes', () => {
  const snap = snapshot(), job = makeJob(snap);
  const annotated = annotateSnapshot(snap, [job]);
  annotated.candidates = candidateView([job], scope, 64);
  assert.equal(retained(retrieve(annotated, [job])).reinforcementBoost, 0.25);
  const annotatedJob = makeJob(annotated, proposal('annotated'), 5);
  const noMetadata = structuredClone(annotated);
  delete noMetadata.candidates;
  for (const s of noMetadata.sources) delete s.provenance;
  assert.equal(retained(retrieve(noMetadata, [annotatedJob])).reinforcementBoost, 0.25);
});

test('any changed scope key excludes history, candidates and controls without leaking their diagnostics', () => {
  const snap = snapshot(), p = proposal();
  for (const key of Object.keys(scope)) {
    const foreign = snapshot(undefined, { scope: { ...scope, [key]: `foreign-${key}` } });
    const result = retrieve(snap, [makeJob(foreign, p)], [control(p, true, 6, { scope: foreign.scope })]);
    noBoost(result);
    assert.equal(result.coverage.historyJobsIgnored, 1);
    assert.equal(result.coverage.reinforcement.total, 0);
  }
  const inconsistent = makeJob(snap); inconsistent.snapshot.scope.sessionId = 'foreign';
  assert.equal(retrieve(snap, [inconsistent]).coverage.historyJobsIgnored, 1);
});

test('an irrelevant query returns no hits regardless of approval, topic, receipts or enabled control', () => {
  const snap = snapshot(), p = proposal(), job = makeJob(snap, p);
  const result = retrieve(snap, [job], [control(p, true, 5)], { ...request, query: 'quantum galaxies' });
  assert.deepEqual(result.hits, []);
  assert.ok(diagnostic(result).disabledReasons.includes('no-query-relevance'));
  assert.deepEqual(diagnostic(result).applicability, p.consolidation.applicability);
  assert.deepEqual(retrieve(snap, [job], [], { ...request, query: '!!!' }).hits, []);
  assert.deepEqual(retrieve(snap, [job], [], { ...request, query: 'teapot' }).hits, []);
});

test('only the exact retained fragment is boosted; neighboring lexical paragraphs stay baseline and never overlap', () => {
  const text = `Mint tea before breakfast. ${fragment} Mint tea after dinner.\n\nAnother mint tea paragraph.`;
  const snap = snapshot([source('z-retained', text)]), job = makeJob(snap);
  const result = retrieve(snap, [job]);
  assert.equal(result.hits.filter(hit => hit.reinforcementBoost > 0).length, 1);
  assert.equal(result.hits[0].text, fragment);
  assert.equal(result.hits.length, 4);
  const ranges = result.hits.map(hit => hit.proof).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i - 1].end <= ranges[i].start);
  const unrelated = retrieve(snap, [job], [], { ...request, query: 'breakfast' });
  noBoost(unrelated);
  assert.equal(unrelated.hits.length, 1);
  assert.ok(!unrelated.hits[0].candidateId);
});

test('overlapping approvals and duplicate candidate fragments never duplicate results or stack boosts', () => {
  const snap = snapshot(), whole = proposal(), subset = proposal('subset', { before: 'mint tea', after: 'mint tea' });
  subset.consolidation.claimKey = 'synthetic-subset';
  const history = [makeJob(snap, whole), makeJob(snap, subset, 3)];
  const result = retrieve(snap, history);
  assert.equal(result.hits.filter(hit => hit.sourceId === 'z-retained' && hit.reinforcementBoost > 0).length, 1);
  assert.equal(result.hits[0].reinforcementBoost, 0.25);
  const copy = proposal('copy'); copy.consolidation.claimKey = 'synthetic-copy';
  const duplicated = retrieve(snap, [makeJob(snap, whole), makeJob(snap, copy, 3)]);
  assert.equal(duplicated.hits.filter(hit => hit.sourceId === 'z-retained').length, 1);
});

test('repeated retained text is ambiguous and fails closed, even with a reused file version', () => {
  const snap = snapshot(), job = makeJob(snap), ambiguous = structuredClone(snap);
  ambiguous.sources[1].content = `${fragment}\n\n${fragment}`;
  const result = retrieve(ambiguous, [job]);
  noBoost(result);
  assert.ok(diagnostic(result).disabledReasons.includes('fragment-not-unique'));
});

test('original-location receipts are disclosed, never lexical scores or factual trust multipliers', () => {
  const raw = snapshot(), annotated = snapshot();
  annotated.sources[1].originals = [original(), original('unavailable'), original('invalid')];
  const before = retrieve(raw), result = retrieve(annotated);
  assert.deepEqual(result.hits.map(hit => [hit.sourceId, hit.baseScore, hit.score]), before.hits.map(hit => [hit.sourceId, hit.baseScore, hit.score]));
  assert.deepEqual(retained(result).sourceVerification, { verified: 1, unavailable: 1, invalid: 1, independentEvents: 'unknown', meaning: 'original-location-only-not-factual-credibility' });
  assert.match(result.policy.sourceVerification, /never multiply/u);
  annotated.sources[1].originals = [original()];
  const job = makeJob(annotated);
  assert.equal(retained(retrieve(annotated, [job])).reinforcementBoost, 0.25);
});

test('previously reviewed verified original becoming unavailable or invalid removes boost until fresh review', () => {
  const snap = snapshot(); snap.sources[0].originals = [original()];
  const job = makeJob(snap);
  assert.equal(retained(retrieve(snap, [job])).reinforcementBoost, 0.25);
  for (const status of ['unavailable', 'invalid']) {
    const current = structuredClone(snap); current.sources[0].originals = [original(status)];
    const result = retrieve(current, [job], [control(job.proposals[0], true, 6)]);
    noBoost(result);
    assert.ok(diagnostic(result).disabledReasons.includes('current-basis-changed'));
    const fresh = makeJob(current, proposal(`fresh-${status}`), 7);
    assert.equal(retained(retrieve(current, [job, fresh])).reinforcementBoost, 0.25);
  }
});

test('UTF-8 bounded snippets preserve raw offsets, include the query and disclose omitted content', () => {
  const long = `${'鲸鱼'.repeat(1500)}\n${fragment}\n${'🐋'.repeat(1000)}`;
  const snap = snapshot([source('z-retained', long)]), job = makeJob(snap);
  const baseline = retrieve(snap);
  assert.equal(baseline.hits.length, 1);
  assert.ok(baseline.hits[0].text.includes('mint tea'));
  assert.ok(Buffer.byteLength(baseline.hits[0].text) <= 2048);
  assert.equal(baseline.hits[0].proof.truncated, true);
  assert.equal(baseline.coverage.snippetsTruncated, 1);
  assert.ok(!baseline.hits[0].text.includes('\uFFFD'));
  assert.equal(long.slice(baseline.hits[0].proof.start, baseline.hits[0].proof.end), baseline.hits[0].text);
  const p = proposal('large', { before: long, after: long });
  const reinforced = retrieve(snap, [makeJob(snap, p)]);
  assert.equal(reinforced.hits[0].reinforcementBoost, 0.25);
  assert.ok(Buffer.byteLength(reinforced.hits[0].text) <= 2048);
  assert.equal(reinforced.hits[0].proof.fragmentBytes, Buffer.byteLength(long));
  assert.equal(retrieve(snap, [job]).hits[0].text, fragment);
});

test('lexical recall supports CJK contiguous bigrams and case/fullwidth normalized words without inference', () => {
  const snap = snapshot([source('cjk', '午餐喜欢薄荷茶。'), source('latin', 'MINT ＴＥＡ at lunch.')]);
  const cjk = retrieve(snap, [], [], { ...request, query: '薄荷茶' });
  assert.equal(cjk.hits.length, 1);
  assert.equal(cjk.hits[0].sourceId, 'cjk');
  assert.equal(cjk.hits[0].baseScore, 1);
  assert.equal(retrieve(snap, [], [], { ...request, query: '茶' }).hits[0].sourceId, 'cjk');
  const latin = retrieve(snap);
  assert.equal(latin.hits.length, 1);
  assert.equal(latin.hits[0].baseScore, 1);
  assert.deepEqual(retrieve(snap, [], [], { ...request, query: 'coffee' }).hits, []);
});

test('result and diagnostic limits are explicit and scoring never depends on query repetition', () => {
  const snap = snapshot(Array.from({ length: 60 }, (_, i) => source(`source-${i}`)));
  const baseline = retrieve(snap);
  assert.equal(baseline.hits.length, 10);
  assert.equal(baseline.coverage.lexicalMatches, 60);
  assert.equal(baseline.coverage.resultsTruncated, true);
  assert.equal(retrieve(snap, [], [], { ...request, limit: 2 }).hits.length, 2);
  assert.equal(retrieve(snap, [], [], { ...request, limit: 20 }).hits.length, 20);
  assert.equal(retrieve(snap, [], [], { ...request, limit: 20 }, { now, maxResults: 5 }).hits.length, 5);
  assert.equal(retrieve(snap, [], [], { ...request, limit: 100 }, { now, maxResults: 100 }).hits.length, 50);
  assert.equal(retrieve(snap, [], [], { ...request, query: 'mint mint tea tea' }).hits[0].baseScore, 1);
  const base = snapshot();
  const history = Array.from({ length: 70 }, (_, i) => {
    const p = proposal(`candidate-${i}`); p.consolidation.claimKey = `claim-${i}`;
    return makeJob(base, p);
  });
  const result = retrieve(base, history);
  assert.equal(result.coverage.reinforcement.total, 70);
  assert.equal(result.coverage.reinforcement.items.length, 64);
  assert.equal(result.coverage.reinforcement.truncated, true);
});

test('pure deterministic retrieval does not mutate inputs or expose mutable aliases', () => {
  const snap = snapshot(), p = proposal(), history = [makeJob(snap, p)], controls = [control(p, true, 5)];
  const before = structuredClone({ snap, history, controls, request });
  const result = retrieve(snap, history, controls);
  assert.deepEqual(result, retrieve(snap, history, controls));
  assert.deepEqual({ snap, history, controls, request }, before);
  retained(result).version.revision = 99;
  retained(result).applicability.topic = 'mutated';
  result.coverage.reinforcement.items[0].applicability.conditions = 'mutated';
  assert.deepEqual({ snap, history, controls, request }, before);
  assert.ok(!JSON.stringify(result).includes('UNTRUSTED_GENERATOR'));
});

function mixedCommit(targetId = 'a-baseline') {
  const before = snapshot();
  before.sources[0].originals = [original()];
  const p = proposal();
  let job = makeJob(before, p);
  const sibling = proposal('sibling', { jobId: p.jobId, targetId, operation: 'append', before: '', after: '\n\nSynthetic unrelated approved note.' });
  sibling.consolidation = { ...sibling.consolidation, action: 'add', claimKey: 'synthetic-sibling-note' };
  job.proposals.push(sibling);
  job = addReview(job, 'accept', 3, sibling);
  const target = before.sources.find(item => item.sourceId === targetId);
  job.transaction = { schemaVersion: 1, transactionId: 'synthetic-committed-tx', jobId: job.jobId, status: 'prepared',
    proposalIds: [sibling.proposalId], reviewIds: [job.reviews.at(-1).reviewId],
    changes: [{ targetId, before: target.content, after: target.content + sibling.after, version: structuredClone(target.version) }] };
  job.appliedProposalIds = [sibling.proposalId];
  job.appliedTransactionIds = [job.transaction.transactionId];
  job.state = 'completed';
  const current = structuredClone(before);
  const changed = current.sources.find(item => item.sourceId === targetId);
  changed.content += sibling.after; changed.version = { revision: 2 };
  job.reload = { transactionId: job.transaction.transactionId, status: 'ready', acknowledgedAt: at(4),
    sources: current.sources.map(item => ({ sourceId: item.sourceId, path: `/synthetic-memory/${item.path}`,
      content: item.content, version: structuredClone(item.version) })) };
  return { before, current, job, sibling };
}

test('acknowledged exact approved sibling after-images preserve reinforcement in a mixed completed job', () => {
  for (const targetId of ['a-baseline', 'z-retained']) {
    const { before, current, job } = mixedCommit(targetId);
    noBoost(retrieve(before, [job]));
    const inputs = structuredClone({ current, job });
    const result = retrieve(current, [job]);
    assert.equal(retained(result).reinforcementBoost, 0.25);
    assert.equal(retained(result).text, fragment);
    assert.deepEqual({ current, job }, inputs);
    assert.match(result.policy.freshness, /approved same-job after-images/u);
    job.transaction.status = 'applied';
    assert.equal(retained(retrieve(current, [job])).reinforcementBoost, 0.25);
  }
});

test('missing, future, mismatched or incomplete reload acknowledgment never authorizes changed basis', () => {
  const variants = [job => { delete job.reload.acknowledgedAt; }, job => { job.reload.status = 'preparing'; },
    job => { job.reload.acknowledgedAt = at(21); }, job => { job.reload.acknowledgedAt = at(1); },
    job => { job.reload.transactionId = 'another-tx'; }, job => { job.appliedTransactionIds = []; },
    job => { job.appliedProposalIds = []; }, job => { job.reload.sources = []; },
    job => { job.reload.sources.push(structuredClone(job.reload.sources[0])); },
    job => { job.reload.sources[0].version = { revision: 999 }; }, job => { job.reload.sources[0].content += ' tampered'; }];
  for (const mutate of variants) {
    const { current, job } = mixedCommit(); mutate(job);
    const result = retrieve(current, [job]);
    noBoost(result);
    assert.ok(result.coverage.reinforcement.items.find(item => item.claimKey === 'synthetic-lunch-drink').disabledReasons.includes('current-basis-changed'));
  }
});

test('applied ledger and reload cannot authorize forged after-images or unrelated transaction changes', () => {
  const variants = [({ job }) => { job.transaction.reviewIds = ['missing-review']; },
    ({ job }) => { job.reviews.at(-1).authority.inputDigest = 'forged'; },
    ({ job }) => { job.invalidatedReviewIds = [job.reviews.at(-1).reviewId]; },
    ({ job }) => { job.transaction.changes[0].before += ' invented'; },
    ({ job }) => { job.transaction.changes[0].version = { revision: 999 }; },
    ({ current, job }) => {
      current.sources[0].content += ' Arbitrary unreviewed bytes.';
      job.transaction.changes[0].after = current.sources[0].content;
      job.reload.sources[0].content = current.sources[0].content;
    },
    ({ current, job }) => {
      current.sources[1].content += ' Unapproved extra change.'; current.sources[1].version = { revision: 2 };
      job.transaction.changes.push({ targetId: 'z-retained', before: fragment, after: current.sources[1].content, version: { revision: 1 } });
      job.reload.sources[1].content = current.sources[1].content; job.reload.sources[1].version = { revision: 2 };
    }];
  for (const mutate of variants) {
    const data = mixedCommit(); mutate(data);
    noBoost(retrieve(data.current, [data.job]));
  }
});

test('external versions, uncited edits and changed original receipts invalidate acknowledged sibling continuation', () => {
  const variants = [({ current }) => { current.sources[0].version = { revision: 3 }; },
    ({ current }) => { current.sources[0].content += ' External edit'; },
    ({ current }) => { current.sources[1].version = { revision: 2 }; },
    ({ current }) => { current.sources[1].content += ' External unrelated edit'; },
    ({ current }) => { current.sources[0].originals = [original('unavailable')]; },
    ({ current, job }) => { current.sources[0].content += ' External edit'; job.reload.sources[0].content = current.sources[0].content; }];
  for (const mutate of variants) {
    const data = mixedCommit(); mutate(data);
    noBoost(retrieve(data.current, [data.job], [control(data.job.proposals[0], true, 6)]));
  }
  // An applied sibling after-image that destroys/duplicates the retained fragment
  // never turns that old text into a valid hit, even with a matching reread.
  const { current, job } = mixedCommit('z-retained');
  current.sources[1].content += `\n${fragment}`;
  noBoost(retrieve(current, [job]));
});

test('aggregate UTF-8 result budget omits whole huge hits, diagnostics and metadata with honest coverage', () => {
  const snap = snapshot();
  const conditions = '鲸鱼'.repeat(14000);
  const history = Array.from({ length: 64 }, (_, i) => {
    const p = proposal(`large-scope-${i}`);
    p.consolidation.claimKey = `large-scope-${i}`;
    p.consolidation.applicability.conditions = conditions;
    return makeJob(snap, p);
  });
  const input = structuredClone({ snap, history });
  const result = retrieve(snap, history, [], { ...request, conditions, limit: 1 });
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  assert.ok(bytes <= 65536);
  assert.equal(result.coverage.byteBudget.maxBytes, 65536);
  assert.equal(result.coverage.byteBudget.outputBytes, bytes);
  assert.equal(result.coverage.byteBudget.omittedHits, 1);
  assert.equal(result.coverage.byteBudget.omittedDiagnostics, 64);
  assert.equal(result.coverage.returnedHits, result.hits.length);
  assert.equal(result.coverage.resultsTruncated, true);
  assert.equal(result.coverage.reinforcement.total, 64);
  assert.equal(result.coverage.reinforcement.truncated, true);
  assert.ok(result.coverage.byteBudget.omittedMetadata.includes('policy.normalizedRequest'));
  assert.equal(result.policy.normalizedRequest, null);
  assert.deepEqual({ snap, history }, input);
});

test('request and configuration validation rejects invalid values instead of broadening scope', () => {
  const snap = snapshot();
  for (const changes of [{ query: '' }, { query: 1 }, { topic: '' }, { conditions: '' }, { limit: 0 }, { limit: 1.5 }]) {
    assert.throws(() => retrieve(snap, [], [], { ...request, ...changes }), TypeError);
  }
  for (const changes of [{ now: new Date('invalid') }, { maxResults: 0 }, { maxResults: NaN }, { boost: NaN }, { boost: Infinity }]) {
    assert.throws(() => retrieve(snap, [], [], request, { ...options, ...changes }), TypeError);
  }
});
