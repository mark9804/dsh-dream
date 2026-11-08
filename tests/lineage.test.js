import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { annotateSnapshot, candidateId, candidateView, hasBoundProvenance, proposalLineage } from '../dist/dream/lineage.js';

const scope = { scopeId: 'synthetic-scope', agentId: 'synthetic-agent', sessionId: 'synthetic-session', memoryRootId: 'synthetic-memory' };
const digest = value => createHash('sha256').update(value).digest('hex');
const origin = (path, selectedScope = scope) => digest(JSON.stringify([selectedScope.memoryRootId, path]));
const at = day => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const consolidation = (changes = {}) => ({ action: 'add', claimKey: 'synthetic-tea', applicability: { topic: 'drink', conditions: 'at lunch' }, basis: 'observation', ...changes });

function source(path, content, extra = {}) {
  return { sourceId: path, path, role: 'daily', content, version: 1, writable: false, sensitivity: 'private', protectedText: [], ...extra };
}

function snapshot(sources, selectedScope = scope) {
  return { schemaVersion: 1, snapshotId: 'synthetic-snapshot', scope: structuredClone(selectedScope), capturedAt: at(1), sources };
}

function proposal(id, sourceId, quote, after = 'Synthetic summary.', extra = {}) {
  return { schemaVersion: 1, proposalId: id, jobId: `job-${id}`, kind: 'preference', text: 'Untrusted generator summary', reason: 'Untrusted generator reason',
    evidence: [{ sourceId, quote }], targetId: 'long-term.md', operation: 'append', before: '', after, ...extra };
}

function job(p, snap, day = 1, extra = {}) {
  return { schemaVersion: 1, jobId: p.jobId, scope: structuredClone(snap?.scope ?? scope), snapshot: snap, state: 'completed', proposals: [p], reviews: [],
    appliedProposalIds: [p.proposalId], createdAt: at(day), updatedAt: at(day), ...extra };
}

function review(p, decision, day, extra = {}) {
  return { schemaVersion: 1, reviewId: `${p.proposalId}-${decision}-${day}`, proposalId: p.proposalId, jobId: p.jobId,
    reviewer: { agentId: scope.agentId, sessionId: scope.sessionId }, decision, reason: 'Synthetic review', reviewedAt: at(day), proposalSnapshot: p,
    basis: { scope, sources: [] }, ...extra };
}

function assertUnknown(value) { assert.equal(value.independentEvents, 'unknown'); }

test('annotation clones inputs and recomputes forged provenance; revisions retain a stable path artifact', () => {
  const raw = snapshot([source('daily/a.md', 'Synthetic observation.')]);
  raw.sources[0].provenance = { schemaVersion: 1, kind: 'derived', artifactId: 'forged', contentHash: 'forged', rootIds: ['invented'], derivedFrom: ['invented'], independentEvents: 100 };
  const original = structuredClone(raw);
  const annotated = annotateSnapshot(raw, []);
  assert.deepEqual(raw, original);
  assert.notEqual(annotated, raw);
  const first = annotated.sources[0].provenance;
  assert.equal(first.artifactId, origin('daily/a.md'));
  assert.equal(first.contentHash, digest('Synthetic observation.'));
  assert.deepEqual(first.rootIds, [first.artifactId]);
  assert.deepEqual(first.derivedFrom, []);
  assertUnknown(first);
  assert.equal(hasBoundProvenance(annotated.sources[0], scope), true);
  const revised = annotateSnapshot(snapshot([source('daily/a.md', 'Synthetic revised observation.', { version: 2 })]), []);
  assert.equal(revised.sources[0].provenance.artifactId, first.artifactId);
  assert.deepEqual(revised.sources[0].provenance.rootIds, first.rootIds);
  assert.notEqual(revised.sources[0].provenance.contentHash, first.contentHash);
});

test('ten successive reprocessings and derivations never turn one origin into ten supports', () => {
  const history = [];
  let snap = snapshot([source('daily/origin.md', 'Synthetic original statement.')]);
  for (let cycle = 1; cycle <= 10; cycle++) {
    const annotated = annotateSnapshot(snap, history);
    const p = proposal(`cycle-${cycle}`, snap.sources[0].sourceId, snap.sources[0].content, `Synthetic derived statement ${cycle}.`);
    const roots = proposalLineage(p, annotated);
    assert.deepEqual(roots.rootIds, [origin('daily/origin.md')]);
    assertUnknown(roots);
    assert.equal(roots.derivedFrom.length, cycle - 1);
    // Leave stored lineage absent to exercise recursive legacy reconstruction.
    history.push(job(p, snap, cycle));
    snap = snapshot([source('long-term.md', p.after, { writable: true, role: 'longTerm', version: cycle })]);
  }
  const final = annotateSnapshot(snap, history).sources[0].provenance;
  assert.equal(final.kind, 'derived');
  assert.deepEqual(final.rootIds, [origin('daily/origin.md')]);
  assert.equal(final.derivedFrom.length, 10);
  assertUnknown(final);
});

test('exact copies in one snapshot and history use one deterministic origin; historical origin wins new copies', () => {
  const text = 'Synthetic exact duplicate.';
  const raw = snapshot([source('daily/a.md', text), source('ideas/copy.md', text)]);
  const first = annotateSnapshot(raw, []);
  const reordered = annotateSnapshot(snapshot([...raw.sources].reverse()), []);
  assert.deepEqual(first.sources[0].provenance.rootIds, first.sources[1].provenance.rootIds);
  assert.deepEqual(first.sources[0].provenance.rootIds, reordered.sources[0].provenance.rootIds);
  const initial = snapshot([source('daily/known.md', text)]);
  const marker = proposal('marker', 'daily/known.md', text, '', { operation: 'retain' });
  const past = job(marker, initial, 1, { appliedProposalIds: [] });
  const current = annotateSnapshot(snapshot([source('ideas/new-copy.md', text)]), [past]);
  assert.deepEqual(current.sources[0].provenance.rootIds, [origin('daily/known.md')]);
  const revised = annotateSnapshot(snapshot([source('ideas/new-copy.md', `${text} Revision.`, { version: 2 })]), [past, job(marker, snapshot([source('ideas/new-copy.md', text)]), 2, { appliedProposalIds: [] })]);
  assert.deepEqual(revised.sources[0].provenance.rootIds, current.sources[0].provenance.rootIds);
});

test('mixed-file evidence resolves exact cited ranges, not all derived text in the file', () => {
  const raw = snapshot([source('daily/first.md', 'Synthetic first observation.')]);
  const p = proposal('first', 'daily/first.md', raw.sources[0].content, 'Synthetic derived tea preference.');
  const history = [job(p, raw)];
  const fresh = 'Synthetic unrelated new observation.';
  const mixed = annotateSnapshot(snapshot([source('long-term.md', `${p.after}\n${fresh}`)]), history);
  const provenance = mixed.sources[0].provenance;
  assert.equal(provenance.kind, 'mixed');
  assert.deepEqual(provenance.rootIds, [origin('daily/first.md'), origin('long-term.md')].sort());
  assert.equal(provenance.spans.map(span => span.text).join(''), mixed.sources[0].content);
  const oldCitation = proposalLineage(proposal('old', 'long-term.md', 'derived tea preference'), mixed);
  assert.deepEqual(oldCitation.rootIds, [origin('daily/first.md')]);
  assert.deepEqual(oldCitation.derivedFrom, ['first']);
  const newCitation = proposalLineage(proposal('new', 'long-term.md', fresh), mixed);
  assert.deepEqual(newCitation.rootIds, [origin('long-term.md')]);
  assert.deepEqual(newCitation.derivedFrom, []);
  const combined = proposalLineage(proposal('both', 'long-term.md', mixed.sources[0].content), mixed);
  assert.deepEqual(combined.rootIds, provenance.rootIds);
  assertUnknown(combined);
});

test('exact copies of mixed content preserve original and derived roots without a new copy root', () => {
  const raw = snapshot([source('daily/event.md', 'Synthetic event.')]);
  const p = proposal('derived', 'daily/event.md', raw.sources[0].content, 'Synthetic known derived text.');
  const text = `${p.after}\nSynthetic independent file addition.`;
  const mixed = snapshot([source('long-term.md', text)]);
  const prior = job(proposal('none', 'long-term.md', text, '', { operation: 'retain' }), mixed, 2, { appliedProposalIds: [] });
  const annotated = annotateSnapshot(snapshot([source('ideas/copy.md', text)]), [prior, job(p, raw)]);
  const roots = proposalLineage(proposal('cite-copy', 'ideas/copy.md', 'Synthetic independent file addition.'), annotated);
  assert.deepEqual(roots.rootIds, [origin('long-term.md')]);
  assert.deepEqual(roots.derivedFrom, []);
});

test('forward derivation and correction preserve parents and add only the actual correction origin', () => {
  const raw = snapshot([source('daily/old.md', 'Synthetic original tea choice.')]);
  const p1 = proposal('tea', 'daily/old.md', raw.sources[0].content, 'Synthetic tea summary.');
  const next = snapshot([source('long-term.md', p1.after), source('daily/correction.md', 'Synthetic explicit correction to coffee.')]);
  const p2 = proposal('coffee', 'long-term.md', p1.after, 'Synthetic corrected coffee summary.', {
    operation: 'replace', before: p1.after, evidence: [{ sourceId: 'long-term.md', quote: p1.after }, { sourceId: 'daily/correction.md', quote: next.sources[1].content }],
  });
  const history = [job(p2, next, 2), job(p1, raw)];
  const annotated = annotateSnapshot(snapshot([source('long-term.md', p2.after)]), history);
  const lineage = proposalLineage(proposal('followup', 'long-term.md', p2.after), annotated);
  assert.deepEqual(lineage.rootIds, [origin('daily/old.md'), origin('daily/correction.md')].sort());
  assert.deepEqual(lineage.derivedFrom, ['coffee', 'tea']);
  assertUnknown(lineage);
});

test('scope isolation uses the entire scope and also rejects mismatched stored snapshots', () => {
  const text = 'Synthetic scoped output.';
  const raw = snapshot([source('daily/private.md', 'Synthetic scoped original.')]);
  const p = proposal('scoped', 'daily/private.md', raw.sources[0].content, text);
  const foreign = [];
  for (const key of Object.keys(scope)) {
    const altered = { ...scope, [key]: `different-${key}` };
    foreign.push(job(p, snapshot(raw.sources, altered)));
  }
  foreign.push(job(p, snapshot(raw.sources, { ...scope, extra: 'scope dimension' })));
  foreign.push(job(p, raw, 1, { snapshot: snapshot(raw.sources, { ...scope, sessionId: 'mismatch' }) }));
  const current = annotateSnapshot(snapshot([source('long-term.md', text)]), foreign);
  assert.equal(current.sources[0].provenance.kind, 'file-artifact');
  assert.deepEqual(current.sources[0].provenance.rootIds, [origin('long-term.md')]);
  assert.deepEqual(candidateView(foreign.map(item => ({ ...item, proposals: [{ ...p, consolidation: consolidation() }] })), scope, 100).items, []);
});

test('unknown paraphrases stay unknown file artifacts, never claimed as detected independent events', () => {
  const raw = snapshot([source('daily/a.md', 'Synthetic original tea observation.')]);
  const p = proposal('tea-original', 'daily/a.md', raw.sources[0].content, 'Synthetic person likes tea.');
  const paraphrase = annotateSnapshot(snapshot([source('ideas/paraphrase.md', 'Synthetic preference: a warm cup of tea.')]), [job(p, raw)]);
  const provenance = paraphrase.sources[0].provenance;
  assert.equal(provenance.kind, 'file-artifact');
  assert.deepEqual(provenance.derivedFrom, []);
  assert.deepEqual(provenance.rootIds, [origin('ideas/paraphrase.md')]);
  assertUnknown(provenance);
});

test('acceptance alone and retain operations cannot label current source bytes as plugin-written', () => {
  const raw = snapshot([source('daily/a.md', 'Synthetic original.')]);
  const approved = proposal('approved-only', 'daily/a.md', raw.sources[0].content, 'Synthetic approved but not written.');
  const retained = proposal('retained-only', 'daily/a.md', raw.sources[0].content, 'Synthetic retained text.', { operation: 'retain' });
  const history = [job(approved, raw, 1, { appliedProposalIds: [], reviews: [review(approved, 'accept', 1)] }), job(retained, raw, 2)];
  const annotated = annotateSnapshot(snapshot([source('long-term.md', `${approved.after}\n${retained.after}`)]), history);
  assert.equal(annotated.sources[0].provenance.kind, 'file-artifact');
  assert.deepEqual(annotated.sources[0].provenance.derivedFrom, []);
});

test('stored applied lineage survives incomplete legacy snapshots; missing evidence stays unknown without a new root', () => {
  const p = proposal('legacy', 'missing.md', 'Synthetic unavailable evidence.', 'Synthetic legacy output.');
  const noParents = annotateSnapshot(snapshot([source('long-term.md', p.after)]), [job(p, undefined)]);
  assert.equal(noParents.sources[0].provenance.kind, 'derived');
  assert.deepEqual(noParents.sources[0].provenance.rootIds, []);
  assert.deepEqual(noParents.sources[0].provenance.derivedFrom, ['legacy']);
  const known = { ...p, lineage: { policyVersion: 1, rootIds: ['stored-origin', 'stored-origin'], derivedFrom: ['older'], independentEvents: 'unknown' } };
  const inherited = annotateSnapshot(snapshot([source('long-term.md', p.after)]), [job(known, undefined)]);
  assert.deepEqual(inherited.sources[0].provenance.rootIds, ['stored-origin']);
  assert.deepEqual(inherited.sources[0].provenance.derivedFrom, ['legacy', 'older']);
});

test('proposal self-supplied lineage is ignored and stale source bindings are recomputed', () => {
  const annotated = annotateSnapshot(snapshot([source('daily/a.md', 'Synthetic evidence.')]), []);
  const p = proposal('forgery', 'daily/a.md', 'Synthetic evidence.', 'Synthetic after.', {
    lineage: { policyVersion: 1, rootIds: ['model-invented-root'], derivedFrom: ['model-invented-parent'], independentEvents: 'unknown' },
  });
  assert.deepEqual(proposalLineage(p, annotated).rootIds, [origin('daily/a.md')]);
  annotated.sources[0].content += ' Synthetic new bytes.';
  assert.equal(hasBoundProvenance(annotated.sources[0], scope), false);
  assert.deepEqual(proposalLineage(p, annotated).derivedFrom, []);
  assert.deepEqual(proposalLineage({ ...p, evidence: [{ sourceId: 'daily/a.md', quote: 'not in source' }] }, annotated).rootIds, []);
  assert.deepEqual(proposalLineage({ ...p, evidence: [{ sourceId: 'daily/a.md', quote: '' }] }, annotated).rootIds, []);
});

test('overlapping after spans combine inherited roots precisely and malformed spans cannot leak into evidence', () => {
  const a = snapshot([source('daily/a.md', 'Synthetic A.')]);
  const b = snapshot([source('daily/b.md', 'Synthetic B.')]);
  const p1 = proposal('overlap-a', 'daily/a.md', 'Synthetic A.', 'Synthetic shared span');
  const p2 = proposal('overlap-b', 'daily/b.md', 'Synthetic B.', 'shared span ending');
  const annotated = annotateSnapshot(snapshot([source('long-term.md', 'Synthetic shared span ending\nFresh synthetic text.')]), [job(p1, a), job(p2, b, 2)]);
  const overlap = proposalLineage(proposal('overlap', 'long-term.md', 'shared span'), annotated);
  assert.deepEqual(overlap.rootIds, [origin('daily/a.md'), origin('daily/b.md')].sort());
  assert.deepEqual(overlap.derivedFrom, ['overlap-a', 'overlap-b']);
  annotated.sources[0].provenance.spans = [{ text: 'unbound bytes', rootIds: ['forged'], derivedFrom: [] }];
  assert.equal(hasBoundProvenance(annotated.sources[0], scope), false);
});

test('candidate registry unions origins, distinguishes retained from applied, and uses the latest actual diff', () => {
  const raw = snapshot([source('daily/a.md', 'Synthetic origin A.')]);
  const p1 = proposal('retain', 'daily/a.md', raw.sources[0].content, 'Synthetic first retained claim.', { operation: 'retain', consolidation: consolidation({ action: 'keep' }) });
  const retain = job(p1, raw, 1, { appliedProposalIds: [], reviews: [review(p1, 'accept', 1)] });
  const first = candidateView([retain], scope, 20);
  assert.equal(first.items[0].status, 'retained');
  assert.equal(first.items[0].text, p1.after);
  const next = snapshot([source('daily/b.md', 'Synthetic origin B.')]);
  const p2 = proposal('apply', 'daily/b.md', next.sources[0].content, 'Synthetic actual applied correction.', { consolidation: consolidation({ action: 'correct', basis: 'correction', candidateId: 'untrusted-id' }) });
  const apply = job(p2, next, 2, { reviews: [review(p2, 'accept', 2)] });
  const view = candidateView([apply, retain, retain], scope, 20);
  assert.equal(view.total, 1);
  assert.equal(view.truncated, false);
  assert.equal(view.items[0].status, 'active');
  assert.deepEqual(view.items[0].proposalIds, ['apply', 'retain']);
  assert.deepEqual(view.items[0].rootIds, [origin('daily/a.md'), origin('daily/b.md')].sort());
  assert.equal(view.items[0].text, p2.after);
  assert.notEqual(view.items[0].text, p2.reason);
  assert.notEqual(view.items[0].text, p2.text);
  assert.equal(view.items[0].candidateId, first.items[0].candidateId);
  assertUnknown(view.items[0]);
});

test('latest defer is pending instead of reviving an earlier semantic verdict', () => {
  const raw = snapshot([source('daily/a.md', 'Synthetic recurring origin.')]);
  const p = proposal('reviewed', 'daily/a.md', raw.sources[0].content, 'Synthetic claim.', { operation: 'retain', consolidation: consolidation() });
  for (const earlier of ['accept', 'reject']) {
    const history = [job(p, raw, 1, { appliedProposalIds: [], reviews: [review(p, earlier, 1), review(p, 'defer', 2)] })];
    const item = candidateView(history, scope, 10).items[0];
    assert.equal(item.status, 'pending');
    assert.equal(item.text, p.after);
    assert.deepEqual(item.rootIds, [origin('daily/a.md')]);
  }
});

test('latest invalidated acceptance cannot fall through to earlier retained or rejected verdicts', () => {
  const raw = snapshot([source('daily/a.md', 'Synthetic event.')]);
  const p = proposal('retained', 'daily/a.md', raw.sources[0].content, 'Synthetic retained claim.', { operation: 'retain', consolidation: consolidation() });
  const latest = review(p, 'accept', 2);
  for (const earlier of ['accept', 'reject']) {
    const item = candidateView([job(p, raw, 1, { appliedProposalIds: [], reviews: [review(p, earlier, 1), latest], invalidatedReviewIds: [latest.reviewId] })], scope, 10).items[0];
    assert.equal(item.status, 'pending');
    assert.equal(item.text, p.after);
  }
});

test('latest unreviewed candidate text never borrows acceptance from a historical revision', () => {
  const raw = snapshot([source('daily/a.md', 'Synthetic event.')]);
  const retained = proposal('earlier', 'daily/a.md', raw.sources[0].content, 'Synthetic accepted old text.', { operation: 'retain', consolidation: consolidation() });
  const revised = proposal('latest', 'daily/a.md', raw.sources[0].content, 'Synthetic unreviewed new text.', { operation: 'retain', consolidation: consolidation() });
  const prior = job(retained, raw, 1, { appliedProposalIds: [], reviews: [review(retained, 'accept', 1)] });
  const latest = job(revised, raw, 2, { appliedProposalIds: [], reviews: [] });
  const item = candidateView([latest, prior], scope, 10).items[0];
  assert.equal(item.status, 'pending');
  assert.equal(item.text, revised.after);
  assert.deepEqual(item.proposalIds, ['earlier', 'latest']);
  const stale = job({ ...retained, after: revised.after }, raw, 1, { appliedProposalIds: [], reviews: [review(retained, 'accept', 1)] });
  assert.equal(candidateView([stale], scope, 10).items[0].status, 'pending');
  const rejected = { ...latest, reviews: [review(revised, 'reject', 2)] };
  assert.equal(candidateView([prior, rejected], scope, 10).items[0].status, 'rejected');
});

test('candidate identity uses exact applicability and whole scope, ignores action and preserves visible truncation', () => {
  const base = consolidation();
  assert.equal(candidateId(base, scope), candidateId({ ...base, action: 'reinforce', basis: 'recurrence', applicability: { conditions: 'at lunch', topic: 'drink' } }, { memoryRootId: scope.memoryRootId, sessionId: scope.sessionId, agentId: scope.agentId, scopeId: scope.scopeId }));
  assert.notEqual(candidateId(base, scope), candidateId({ ...base, applicability: { ...base.applicability, validUntil: '2027-01-01' } }, scope));
  assert.notEqual(candidateId(base, scope), candidateId(base, { ...scope, sessionId: 'other-session' }));
  const raw = snapshot([source('daily/a.md', 'Synthetic event.')]);
  const proposals = [0, 1, 2].map(index => proposal(`candidate-${index}`, 'daily/a.md', raw.sources[0].content, `Synthetic diff ${index}.`, { consolidation: consolidation({ applicability: { topic: 'drink', conditions: `condition ${index}` } }) }));
  const history = proposals.map((p, index) => job(p, raw, index + 1, { appliedProposalIds: [] }));
  history.push(job(proposal('legacy-no-consolidation', 'daily/a.md', raw.sources[0].content), raw));
  const view = candidateView(history, scope, 2);
  assert.equal(view.total, 3);
  assert.equal(view.items.length, 2);
  assert.equal(view.truncated, true);
  assert.equal(candidateView(history, scope, 0).items.length, 0);
  assert.equal(candidateView(history, scope, 3).truncated, false);
  assert.ok(view.items.every(item => item.status === 'pending'));
});

test('candidate byte budget omits whole oversized text, applicability and ids without mutation', () => {
  const raw = snapshot([source('daily/a.md', 'Synthetic budget event.')]);
  const small = proposal('small', 'daily/a.md', raw.sources[0].content, 'Synthetic fitting diff.', { consolidation: consolidation({ claimKey: 'small' }) });
  const hugeText = proposal('huge-text', 'daily/a.md', raw.sources[0].content, '鲸'.repeat(22_000), { consolidation: consolidation({ claimKey: 'huge-text' }) });
  const hugeScope = proposal('huge-applicability', 'daily/a.md', raw.sources[0].content, 'Synthetic bounded diff.', { consolidation: consolidation({ claimKey: 'huge-applicability', applicability: { topic: 'drink', conditions: 'x'.repeat(65_536) } }) });
  const hugeIds = Array.from({ length: 70 }, (_, index) => proposal(`id-${index}-${'x'.repeat(1_000)}`, 'daily/a.md', raw.sources[0].content, 'Synthetic bounded diff.', { consolidation: consolidation({ claimKey: 'huge-ids' }) }));
  const history = [small, hugeText, hugeScope, ...hugeIds].map(p => job(p, raw, 1, { appliedProposalIds: [] }));
  const original = structuredClone(history);
  const view = candidateView(history, scope, 10);
  assert.equal(view.total, 4);
  assert.equal(view.truncated, true);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].text, small.after);
  assert.deepEqual(view.items[0].proposalIds, [small.proposalId]);
  assert.deepEqual(view.items[0].rootIds, [origin('daily/a.md')]);
  assert.ok(Buffer.byteLength(JSON.stringify(view.items), 'utf8') <= 65_536);
  assert.deepEqual(history, original);
  assert.deepEqual(candidateView([job(hugeText, raw, 1, { appliedProposalIds: [] })], scope, 10), { items: [], total: 1, truncated: true });
});

test('candidate aggregate byte budget counts UTF-8 and omits rather than trims a fitting item', () => {
  const raw = snapshot([source('daily/a.md', 'Synthetic aggregate event.')]);
  const proposals = ['one', 'two'].map(id => proposal(id, 'daily/a.md', raw.sources[0].content, '鲸'.repeat(12_000), { consolidation: consolidation({ claimKey: id }) }));
  const view = candidateView(proposals.map(p => job(p, raw, 1, { appliedProposalIds: [] })), scope, 10);
  assert.equal(view.total, 2);
  assert.equal(view.truncated, true);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].text, proposals[0].after);
  assert.equal(view.items[0].text.length, 12_000);
  assert.ok(Buffer.byteLength(JSON.stringify(view.items), 'utf8') <= 65_536);
});

test('local applied corrections preserve untouched generated spans rather than mint a target-file root', () => {
  const first = snapshot([source('daily/a.md', 'Synthetic original tea statement.'), source('long-term.md', '')]);
  const p1 = proposal('generated-sentence', 'daily/a.md', first.sources[0].content, 'Person likes tea.');
  const history = [job(p1, first)];
  const second = annotateSnapshot(snapshot([source('long-term.md', p1.after), source('daily/b.md', 'Synthetic correction: coffee.')]), history);
  const p2 = proposal('local-correction', 'daily/b.md', second.sources[1].content, 'coffee', { operation: 'replace', before: 'tea' });
  history.push(job(p2, second, 2));
  const final = annotateSnapshot(snapshot([source('long-term.md', 'Person likes coffee.')]), history);
  assert.equal(final.sources[0].provenance.kind, 'derived');
  assert.deepEqual(final.sources[0].provenance.rootIds, [origin('daily/a.md'), origin('daily/b.md')].sort());
  const prefix = proposalLineage(proposal('prefix', 'long-term.md', 'Person likes '), final);
  assert.deepEqual(prefix.rootIds, [origin('daily/a.md')]);
  assert.deepEqual(prefix.derivedFrom, ['generated-sentence']);
  const changed = proposalLineage(proposal('changed', 'long-term.md', 'coffee'), final);
  assert.deepEqual(changed.rootIds, [origin('daily/b.md')]);
  assert.deepEqual(changed.derivedFrom, ['local-correction']);
  const suffix = proposalLineage(proposal('suffix', 'long-term.md', '.'), final);
  assert.deepEqual(suffix.rootIds, [origin('daily/a.md')]);
  const wrapped = annotateSnapshot(snapshot([source('ideas/copy.md', 'New synthetic observation.\nPerson likes coffee.\nUnrelated fresh text.')]), history);
  assert.deepEqual(proposalLineage(proposal('copy-prefix', 'ideas/copy.md', 'Person likes '), wrapped).rootIds, prefix.rootIds);
  assert.deepEqual(proposalLineage(proposal('fresh', 'ideas/copy.md', 'Unrelated fresh text.'), wrapped).rootIds, [origin('ideas/copy.md')]);
  assert.deepEqual(proposalLineage(proposal('fresh-punctuation', 'ideas/copy.md', 'Unrelated fresh text.'), wrapped).derivedFrom, []);
  const uncommitted = annotateSnapshot(snapshot([source('long-term.md', 'Person likes coffee.')]), [history[0], { ...history[1], appliedProposalIds: [] }]);
  assert.equal(uncommitted.sources[0].provenance.kind, 'file-artifact');
});

test('applied multi-edit after-images preserve prior origins through successive local replacements and archive', () => {
  const first = snapshot([source('daily/a.md', 'Synthetic original.'), source('long-term.md', '')]);
  const p1 = proposal('sentence', 'daily/a.md', first.sources[0].content, 'Person likes tea. Extra.');
  const history = [job(p1, first)];
  const second = snapshot([source('long-term.md', p1.after), source('daily/b.md', 'Synthetic change.')]);
  const p2 = proposal('word', 'daily/b.md', second.sources[1].content, 'coffee', { operation: 'replace', before: 'tea' });
  const p3 = proposal('archive', 'daily/b.md', second.sources[1].content, '', { jobId: p2.jobId, operation: 'archive', before: ' Extra.' });
  history.push(job(p2, second, 2, { proposals: [p3, p2], appliedProposalIds: [p2.proposalId, p3.proposalId] }));
  const current = annotateSnapshot(snapshot([source('long-term.md', 'Person likes coffee.')]), history);
  assert.deepEqual(proposalLineage(proposal('prefix', 'long-term.md', 'Person likes '), current).rootIds, [origin('daily/a.md')]);
  assert.deepEqual(proposalLineage(proposal('replacement', 'long-term.md', 'coffee'), current).rootIds, [origin('daily/b.md')]);
  assert.ok(!current.sources[0].provenance.rootIds.includes(origin('long-term.md')));
});

test('deep recursive histories and cyclic references are bounded without recursion overflow', () => {
  const history = [];
  for (let i = 0; i < 70; i++) {
    const previous = i ? `Synthetic chain output [${i - 1}].` : 'Synthetic start.';
    const raw = snapshot([source('long-term.md', previous)]);
    const p = proposal(`chain-${i}`, 'long-term.md', previous, `Synthetic chain output [${i}].`);
    const item = job(p, raw);
    item.createdAt = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    history.push(item);
  }
  const annotated = annotateSnapshot(snapshot([source('long-term.md', 'Synthetic chain output [69].')]), history);
  assertUnknown(annotated.sources[0].provenance);
  assert.ok(annotated.sources[0].provenance.rootIds.length <= 1);
  const p1 = proposal('cycle-a', 'long-term.md', 'Synthetic cyclic B.', 'Synthetic cyclic A.');
  const p2 = proposal('cycle-b', 'long-term.md', 'Synthetic cyclic A.', 'Synthetic cyclic B.');
  const cycle = annotateSnapshot(snapshot([source('long-term.md', p2.after)]), [job(p1, snapshot([source('long-term.md', p2.after)])), job(p2, snapshot([source('long-term.md', p1.after)]), 2)]);
  assertUnknown(cycle.sources[0].provenance);
  assert.ok(cycle.sources[0].provenance.rootIds.length <= 1);
});
