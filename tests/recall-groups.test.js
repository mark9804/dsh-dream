import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { groupRecallHits } from '../dist/dream/recall-groups.js';

// All fixtures are synthetic current bytes in memory. No models, FS or Host.
const scope = { scopeId: 'synthetic-scope', agentId: 'synthetic-agent', sessionId: 'synthetic-session', memoryRootId: 'synthetic-memory' };
const sha = text => createHash('sha256').update(text).digest('hex');
const body = 'Synthetic mint tea at lunch.';
const source = (sourceId, content = body, extra = {}) => ({ sourceId, path: `daily/${sourceId}.md`, role: 'daily', content,
  version: { revision: 1 }, writable: false, sensitivity: 'private', protectedText: [], ...extra });
const snapshot = (sources, selectedScope = scope) => ({ schemaVersion: 1, snapshotId: 'synthetic-snapshot', scope: structuredClone(selectedScope), capturedAt: '2026-11-05T00:00:00.000Z', sources });

function hit(source, { fragmentStart = 0, fragmentEnd = source.content.length, start = fragmentStart, end = fragmentEnd, ...changes } = {}) {
  const text = source.content.slice(start, end);
  return { sourceId: source.sourceId, path: source.path, sourceRole: source.role,
    temporalStatus: source.role === 'daily' ? 'dated-record-not-current-status' : 'current-file-not-independent-truth',
    version: structuredClone(source.version), text, score: 1, baseScore: 1, reinforcementBoost: 0,
    sourceVerification: { verified: 0, unavailable: 0, invalid: 0, independentEvents: 'unknown', meaning: 'original-location-only-not-factual-credibility' },
    proof: { kind: 'current-source', contentHash: sha(source.content), start, end, fragmentStart, fragmentEnd, offsetUnit: 'utf16-code-units',
      textBytes: Buffer.byteLength(text), fragmentBytes: Buffer.byteLength(source.content.slice(fragmentStart, fragmentEnd)), truncated: start !== fragmentStart || end !== fragmentEnd },
    ...changes };
}
const group = (sources, hits = sources.map(source => hit(source))) => groupRecallHits(hits, snapshot(sources));

function withoutGroup(hit) { const copy = structuredClone(hit); delete copy.group; return copy; }

test('exact duplicate bodies become one display row with every dated location and unchanged representative proof', () => {
  const sources = [source('2026-10-01'), source('2026-10-02'), source('2026-10-03')];
  const inputs = sources.map(source => hit(source));
  const result = group(sources, inputs);
  assert.equal(result.hits.length, 1);
  assert.deepEqual(withoutGroup(result.hits[0]), inputs[0]);
  assert.equal(result.hits[0].group.kind, 'display-only-not-event-identity');
  assert.equal(result.hits[0].group.independentEvents, 'unknown');
  assert.equal(result.hits[0].group.memberCount, 3);
  assert.deepEqual(result.hits[0].group.members.map(member => member.path), sources.map(source => source.path));
  for (const member of result.hits[0].group.members) {
    const original = sources.find(source => source.sourceId === member.sourceId);
    assert.deepEqual(member.version, original.version);
    assert.equal(original.content.slice(member.proof.start, member.proof.end), body);
    assert.equal(member.proof.contentHash, sha(original.content));
    assert.equal(Object.hasOwn(member, 'text'), false);
  }
  assert.deepEqual([result.coverage.inputHits, result.coverage.groups, result.coverage.collapsedHits, result.coverage.memberLocations], [3, 1, 2, 3]);
  assert.match(result.coverage.nearDuplicatesOnlyDisplay, /not-event-identity/u);
});

test('fifty duplicate locations use one top-K position but expose bounded honest member coverage', () => {
  const sources = Array.from({ length: 50 }, (_, index) => source(`location-${String(index).padStart(2, '0')}`));
  const result = group(sources);
  assert.equal(result.hits.length, 1);
  const display = result.hits[0].group;
  assert.equal(display.memberCount, 50);
  assert.equal(display.members.length, 16);
  assert.equal(display.omittedMembers, 34);
  assert.ok(Buffer.byteLength(JSON.stringify(display)) <= 16384);
  assert.equal(result.coverage.collapsedHits, 49);
  assert.equal(result.coverage.memberLocations, 50);
  assert.equal(result.coverage.omittedMemberLocations, 34);
});

test('only NFKC and whitespace are normalized; full raw member bytes and scores stay distinct', () => {
  const sources = [source('a', '  Synthetic　mint\t tea at lunch.\n'), source('b', 'Ｓｙｎｔｈｅｔｉｃ mint tea at lunch.')];
  const inputs = [hit(sources[0], { score: 0.8, baseScore: 0.8 }), hit(sources[1], { score: 1, baseScore: 1 })];
  const result = group(sources, inputs);
  assert.equal(result.hits.length, 1);
  assert.deepEqual(withoutGroup(result.hits[0]), inputs[1]);
  assert.equal(result.hits[0].text, sources[1].content);
  assert.equal(result.hits[0].group.members.length, 2);
});

test('numbers, dates, negation, subject, punctuation, case and ordinal/copy prefixes never disappear', () => {
  const texts = ['Alex drank 1 cup.', 'Alex drank 2 cups.', 'Alex did not drink 1 cup.', 'Blair drank 1 cup.',
    'Alex drank 1 cup!', 'alex drank 1 cup.', 'Alex drank 1 cup on 2026-10-01.', 'Alex drank 1 cup on 2026-10-02.',
    '- Alex drank 1 cup.', '1. Alex drank 1 cup.', '2. Alex drank 1 cup.', '合成旧稿整理第1份：Alex drank 1 cup.', '合成旧稿整理第2份：Alex drank 1 cup.'];
  const sources = texts.map((text, i) => source(`source-${i}`, text));
  const result = group(sources);
  assert.equal(result.hits.length, texts.length);
  assert.ok(result.hits.every(hit => !hit.group));
  assert.equal(result.coverage.collapsedHits, 0);
});

test('matching clipped snippets cannot group different complete current fragments', () => {
  const prefix = `${body} ${'Synthetic context. '.repeat(200)}`;
  const sources = [source('a', `${prefix}The answer was 1.`), source('b', `${prefix}The answer was not 1.`)];
  const inputs = sources.map(source => hit(source, { end: body.length }));
  assert.equal(inputs[0].text, inputs[1].text);
  const result = group(sources, inputs);
  assert.equal(result.hits.length, 2);
  assert.ok(result.hits.every(hit => !hit.group));
});

test('identical complete fragments with different snippet windows group using full raw proof', () => {
  const text = `${body} ${'Surrounding synthetic content. '.repeat(100)}`;
  const sources = [source('a', text), source('b', text)];
  const inputs = [hit(sources[0], { end: body.length }), hit(sources[1], { start: 5, end: 20 })];
  const result = group(sources, inputs);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].group.memberCount, 2);
  assert.equal(result.hits[0].group.members[1].proof.start, 5);
});

test('highest original score wins without cumulative reinforcement, support or receipt weighting', () => {
  const sources = [source('a'), source('b'), source('c')];
  const inputs = sources.map((source, index) => hit(source, { score: index === 1 ? 1.25 : 1, reinforcementBoost: index === 1 ? 0.25 : 0,
    candidateId: `synthetic-candidate-${index}`, applicability: { topic: 'drinks', conditions: index === 1 ? 'at lunch' : 'at dinner' } }));
  inputs[0].sourceVerification.verified = 1000;
  const result = group(sources, inputs);
  assert.deepEqual(withoutGroup(result.hits[0]), inputs[1]);
  assert.equal(result.hits[0].score, 1.25);
  assert.equal(result.hits[0].reinforcementBoost, 0.25);
  assert.equal(result.hits[0].sourceVerification.verified, 0);
  assert.match(result.coverage.policy, /never sum scores/u);
});

test('invalid or stale proof endpoints stay independent instead of collapsing valid evidence', () => {
  const mutations = [hit => { hit.proof.contentHash = 'forged'; }, hit => { hit.version.revision = 2; },
    hit => { hit.path = 'foreign.md'; }, hit => { hit.sourceRole = 'longTerm'; }, hit => { hit.text = 'forged'; },
    hit => { hit.proof.fragmentStart = -1; }, hit => { hit.proof.fragmentEnd += 1; },
    hit => { hit.proof.start = 1.5; }, hit => { hit.proof.end = 0; }, hit => { hit.proof.textBytes += 1; },
    hit => { hit.proof.fragmentBytes += 1; }, hit => { hit.proof.truncated = true; }, hit => { hit.proof.offsetUnit = 'bytes'; }];
  for (const mutate of mutations) {
    const sources = [source('a'), source('b')]; const inputs = sources.map(source => hit(source)); mutate(inputs[1]);
    const result = group(sources, inputs);
    assert.equal(result.hits.length, 2);
    assert.ok(result.hits.every(hit => !hit.group));
  }
  const sources = [source('a')];
  const result = group(sources, [hit(sources[0]), hit(source('missing'))]);
  assert.equal(result.hits.length, 2);
});

test('a surrogate-splitting endpoint is not a groupable exact UTF-16 location', () => {
  const sources = [source('a', `🐋${body}`), source('b', `🐋${body}`)];
  const inputs = sources.map(source => hit(source, { start: 1, fragmentStart: 1 }));
  assert.equal(group(sources, inputs).hits.length, 2);
});

test('same source repeated paragraph positions remain separate locations without repeated-input inflation', () => {
  const s = source('one-source', `${body}\n\n${body}`);
  const first = hit(s, { fragmentEnd: body.length });
  const second = hit(s, { fragmentStart: body.length + 2 });
  const result = group([s], [first, second, structuredClone(first), structuredClone(second)]);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].group.memberCount, 2);
  assert.equal(result.hits[0].group.members.length, 2);
  assert.equal(result.coverage.memberLocations, 2);
  assert.equal(result.coverage.collapsedHits, 3);
  assert.notEqual(result.hits[0].group.members[0].proof.fragmentStart, result.hits[0].group.members[1].proof.fragmentStart);
});

test('oversized versions are omitted as whole member metadata without shortening identifiers or proof', () => {
  const sources = [source('a', body, { version: { opaque: '鲸'.repeat(1000) } }), source('b')];
  const inputs = sources.map(source => hit(source));
  const result = group(sources, inputs);
  assert.deepEqual(withoutGroup(result.hits[0]), inputs[0]);
  assert.equal(result.hits[0].version.opaque.length, 1000);
  assert.equal(result.hits[0].group.memberCount, 2);
  assert.equal(result.hits[0].group.members.length, 1);
  assert.equal(result.hits[0].group.members[0].sourceId, 'b');
  assert.equal(result.hits[0].group.omittedMembers, 1);
  assert.equal(result.coverage.omittedMemberLocations, 1);
});

test('aggregate per-group member metadata is capped even when each member fits individually', () => {
  const sources = Array.from({ length: 20 }, (_, i) => source(`source-${String(i).padStart(2, '0')}`, body, { version: { opaque: 'x'.repeat(1100) } }));
  const result = group(sources);
  const display = result.hits[0].group;
  assert.ok(display.members.length < 16);
  assert.ok(Buffer.byteLength(JSON.stringify(display)) <= 16384);
  assert.ok(display.members.every(member => Buffer.byteLength(JSON.stringify(member)) <= 2048));
  assert.equal(display.members.length + display.omittedMembers, 20);
});

test('group identity includes exact scope and does not incorporate counts, snapshots or timestamps', () => {
  const sources = [source('a'), source('b')]; const inputs = sources.map(source => hit(source));
  const base = group(sources, inputs).hits[0].group.groupId;
  const later = snapshot(sources); later.snapshotId = 'later'; later.capturedAt = '2026-11-06T00:00:00.000Z';
  assert.equal(groupRecallHits(inputs, later).hits[0].group.groupId, base);
  const added = source('c');
  assert.equal(group([...sources, added], [...inputs, hit(added)]).hits[0].group.groupId, base);
  for (const key of Object.keys(scope)) {
    assert.notEqual(groupRecallHits(inputs, snapshot(sources, { ...scope, [key]: `other-${key}` })).hits[0].group.groupId, base);
  }
});

test('input and source order do not change deterministic representative, group, member or row ordering', () => {
  const sources = [source('c', body), source('a', body), source('b', 'Different synthetic content.')];
  const inputs = sources.map(source => hit(source));
  const result = group(sources, inputs);
  assert.deepEqual(group([...sources].reverse(), [...inputs].reverse()), result);
  assert.deepEqual(result.hits.map(hit => hit.sourceId), ['a', 'b']);
});

test('grouping is detached, JSON-friendly and never mutates source or pre-ranked hit metadata', () => {
  const sources = [source('a'), source('b')]; const inputs = sources.map(source => hit(source));
  const before = structuredClone({ sources, inputs });
  const result = group(sources, inputs);
  assert.deepEqual({ sources, inputs }, before);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  result.hits[0].version.revision = 9;
  result.hits[0].group.members[0].version.revision = 10;
  result.hits[0].group.members[0].proof.start = 999;
  assert.deepEqual({ sources, inputs }, before);
});

test('already-grouped rows remain independent rather than losing members through regrouping', () => {
  const sources = [source('a'), source('b')]; const first = group(sources);
  const result = group(sources, [...first.hits, hit(sources[1])]);
  assert.equal(result.hits.length, 2);
  assert.deepEqual(result.hits[0], first.hits[0]);
  assert.equal(result.coverage.collapsedHits, 0);
});

test('empty inputs and distinct rows do not synthesize group identity or new authority', () => {
  assert.deepEqual(group([], []).hits, []);
  assert.deepEqual(group([], []).coverage.inputHits, 0);
  const sources = [source('a', 'Different 1.'), source('b', 'Different 2.')];
  const result = group(sources);
  assert.equal(result.coverage.groups, 2);
  assert.equal(result.coverage.memberLocations, 2);
  assert.equal(result.coverage.omittedMemberLocations, 0);
  assert.ok(result.hits.every(hit => !hit.group));
});
