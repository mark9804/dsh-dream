import assert from 'node:assert/strict';
import test from 'node:test';
import { organizeEpisodes, validateEpisodeDigest } from '../dist/dream/episodes.js';

const limits = { maxOutputBytes: 16384, maxEpisodes: 8 };

function fixture() {
  const snapshot = {
    schemaVersion: 1, snapshotId: 'snapshot', capturedAt: '2026-11-03T05:00:00+09:00',
    scope: { scopeId: 'scope', agentId: 'agent', sessionId: 'session', memoryRootId: 'memory' },
    sources: [
      { sourceId: 'daily', path: 'daily/2026-11-03.md', role: 'daily', content: 'We walked together by the river. We will compare notes tomorrow.', version: 'v1', writable: false, sensitivity: 'private', protectedText: [] },
      { sourceId: 'memory', path: 'long-term.md', role: 'longTerm', content: 'Keep the pinned name.\n', version: 'v2', writable: true, sensitivity: 'private', protectedText: ['Keep the pinned name.'] },
    ],
  };
  const episode = {
    summary: 'A shared walk by the river.', when: '未知', participants: ['user', 'agent'],
    status: 'reported', category: 'relationship', importanceReason: 'A shared experience worth retaining for continuity.',
    retention: 'durable', evidence: [{ sourceId: 'daily', quote: 'We walked together by the river.' }],
  };
  const output = { episodes: [episode], coveredSourceIds: ['daily'] };
  const digest = {
    schemaVersion: 1, snapshotId: snapshot.snapshotId, episodes: [{ ...structuredClone(episode), episodeId: 'job-event-1' }],
    coverage: { sourceIds: ['daily'], omittedSourceIds: ['memory'] },
  };
  return { snapshot, episode, output, digest };
}

function scripted(output) {
  const calls = [];
  return { calls, model: async prompt => {
    calls.push(prompt);
    assert.equal(calls.length, 1, 'The organizer makes exactly one model call');
    return typeof output === 'string' ? output : JSON.stringify(output);
  } };
}

test('organizer assigns IDs and derives honest source coverage without changing inputs', async () => {
  const { snapshot, output } = fixture();
  const before = structuredClone({ snapshot, output });
  const fake = scripted(output);
  const digest = await organizeEpisodes(snapshot, 'job', fake.model, limits);
  assert.equal(fake.calls.length, 1);
  assert.equal(digest.episodes[0].episodeId, 'job-event-1');
  assert.deepEqual(digest.coverage, { sourceIds: ['daily'], omittedSourceIds: ['memory'] });
  assert.equal(validateEpisodeDigest(digest, snapshot), digest);
  assert.match(fake.calls[0], /该声明不是全部事件已收录的保证/);
  assert.deepEqual({ snapshot, output }, before);
});

test('all categories remain cited records and low priority never deletes source text', async () => {
  const { snapshot, episode } = fixture();
  const categories = ['must-keep', 'future-useful', 'relationship', 'temporary', 'low-priority'];
  const statuses = ['reported', 'confirmed', 'uncertain', 'open', 'resolved'];
  const episodes = categories.map((category, index) => ({
    ...episode, category, status: statuses[index], retention: category === 'low-priority' ? 'archive-only' : 'recent',
    importanceReason: `Preserve the original event with category ${category}; no deletion.`,
  }));
  const before = structuredClone(snapshot);
  const fake = scripted({ episodes, coveredSourceIds: ['daily'] });
  const digest = await organizeEpisodes(snapshot, 'job', fake.model, limits);
  assert.deepEqual(digest.episodes.map(item => item.category), categories);
  assert.deepEqual(digest.episodes.map(item => item.episodeId), categories.map((_, index) => `job-event-${index + 1}`));
  assert.equal(digest.episodes.at(-1).retention, 'archive-only');
  assert.deepEqual(snapshot, before);
  assert.match(fake.calls[0], /关系经历本身有价值/);
  assert.match(fake.calls[0], /重要性不等于真实性/);
  assert.match(fake.calls[0], /low-priority\/temporary 不等于删除/);
  assert.match(fake.calls[0], /“confirmed”不证明内容真实/);
  assert.match(fake.calls[0], /importanceReason 必须说明为什么保留/);
});

test('empty and partially covered outputs do not silently claim all sources were checked', async () => {
  const { snapshot } = fixture();
  for (const coveredSourceIds of [[], ['memory'], ['memory', 'daily']]) {
    const digest = await organizeEpisodes(snapshot, 'job', scripted({ episodes: [], coveredSourceIds }).model, limits);
    assert.deepEqual(digest.episodes, []);
    assert.deepEqual(digest.coverage.sourceIds, snapshot.sources.filter(item => coveredSourceIds.includes(item.sourceId)).map(item => item.sourceId));
    assert.deepEqual(digest.coverage.omittedSourceIds, snapshot.sources.filter(item => !coveredSourceIds.includes(item.sourceId)).map(item => item.sourceId));
    assert.equal(Object.hasOwn(digest.coverage, 'full'), false);
  }
});

test('fabricated, empty, foreign or undeclared evidence never becomes an episode', async () => {
  for (const change of [
    output => { output.episodes[0].evidence[0].quote = 'Fabricated event.'; },
    output => { output.episodes[0].evidence[0].quote = ''; },
    output => { output.episodes[0].evidence[0].sourceId = 'other-scope'; },
    output => { output.episodes[0].evidence = []; },
    output => { output.coveredSourceIds = []; },
  ]) {
    const { snapshot, output } = fixture();
    change(output);
    await assert.rejects(organizeEpisodes(snapshot, 'job', scripted(output).model, limits), /evidence|nonempty|covered/);
  }
});

test('model supplied IDs, coverage authority and nested unknown fields are rejected', async () => {
  for (const change of [
    output => { output.episodeId = 'forged'; },
    output => { output.coverage = { full: true }; },
    output => { output.schemaVersion = 1; },
    output => { output.episodes[0].episodeId = 'forged'; },
    output => { output.episodes[0].decision = 'accept'; },
    output => { output.episodes[0].provenance = { trusted: true }; },
    output => { output.episodes[0].evidence[0].verified = true; },
  ]) {
    const { snapshot, output } = fixture();
    change(output);
    await assert.rejects(organizeEpisodes(snapshot, 'job', scripted(output).model, limits), /Unexpected .* fields/);
  }
});

test('digest validator checks every object layer, IDs, snapshot and coverage partition', () => {
  for (const change of [
    digest => { digest.authority = 'trusted'; },
    digest => { digest.schemaVersion = 2; },
    digest => { digest.snapshotId = 'another-snapshot'; },
    digest => { digest.episodes[0].episodeId = ''; },
    digest => { digest.episodes.push(structuredClone(digest.episodes[0])); },
    digest => { digest.episodes[0].confirmation = 'trusted'; },
    digest => { digest.episodes[0].evidence[0].lineage = {}; },
    digest => { digest.coverage.full = true; },
    digest => { digest.coverage.sourceIds.push('daily'); },
    digest => { digest.coverage.omittedSourceIds = []; },
    digest => { digest.coverage.omittedSourceIds.push('daily'); },
    digest => { digest.coverage.omittedSourceIds = ['foreign-source']; },
  ]) {
    const { snapshot, digest } = fixture();
    change(digest);
    assert.throws(() => validateEpisodeDigest(digest, snapshot), TypeError);
  }
});

test('invalid classifications, missing reasons and coerced enum values fail closed', async () => {
  for (const [key, value] of [
    ['category', 'delete'], ['status', 'approved'], ['retention', 'discard'],
    ['status', ['confirmed']], ['retention', ['durable']], ['when', ''],
    ['summary', ''], ['importanceReason', ' '], ['participants', ['user', 'user']], ['participants', 'user'],
  ]) {
    const { snapshot, output } = fixture();
    output.episodes[0][key] = value;
    await assert.rejects(organizeEpisodes(snapshot, 'job', scripted(output).model, limits), TypeError);
  }
});

test('maxEpisodes is validated before calls and enforced on model output and stored digests', async () => {
  const { snapshot, output, digest } = fixture();
  for (const maxEpisodes of [0, 129, 1.5, NaN, '2']) {
    const fake = scripted(output);
    await assert.rejects(organizeEpisodes(snapshot, 'job', fake.model, { ...limits, maxEpisodes }), /maxEpisodes/);
    assert.equal(fake.calls.length, 0);
  }
  const tooMany = { ...output, episodes: [output.episodes[0], output.episodes[0]] };
  await assert.rejects(organizeEpisodes(snapshot, 'job', scripted(tooMany).model, { ...limits, maxEpisodes: 1 }), /maxEpisodes/);
  digest.episodes = Array.from({ length: 129 }, (_, index) => ({ ...digest.episodes[0], episodeId: `job-event-${index + 1}` }));
  assert.throws(() => validateEpisodeDigest(digest, snapshot), /128/);
});

test('malformed JSON, model byte limits and input envelope fail without silent truncation', async () => {
  const { snapshot, output } = fixture();
  for (const invalid of ['{"episodes":', '[]', 'null', '```json\n{}\n```']) {
    await assert.rejects(organizeEpisodes(snapshot, 'job', scripted(invalid).model, limits), /JSON|object/);
  }
  await assert.rejects(organizeEpisodes(snapshot, 'job', scripted(output).model, { ...limits, maxOutputBytes: 8 }), /output budget/);
  snapshot.sources[0].content = 'x'.repeat(2097152);
  const fake = scripted(output);
  await assert.rejects(organizeEpisodes(snapshot, 'job', fake.model, limits), /2 MiB.*no evidence truncated/);
  assert.equal(fake.calls.length, 0);
});

test('unknown or duplicated declared source IDs are rejected instead of expanding scope', async () => {
  for (const coveredSourceIds of [['daily', 'unknown'], ['daily', 'daily']]) {
    const { snapshot, output } = fixture();
    output.coveredSourceIds = coveredSourceIds;
    await assert.rejects(organizeEpisodes(snapshot, 'job', scripted(output).model, limits), /unknown source|unique/);
  }
});
