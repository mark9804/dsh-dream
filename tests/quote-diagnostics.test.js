import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuoteValidationIssue, formatQuoteValidationIssue, QuoteValidationError, validateQuoteValidationIssue } from '../dist/domain/quote-diagnostics.js';
import { organizeEpisodes, validateEpisodeDigest } from '../dist/dream/episodes.js';

function source(content, extra = {}) {
  return { sourceId: 'synthetic-daily', path: 'daily/synthetic.md', role: 'daily', content, version: 'v1', writable: false, sensitivity: 'private', protectedText: [], ...extra };
}

function issue(content, quote, extra = {}) {
  return createQuoteValidationIssue({ episodeIndex: 1, evidenceIndex: 2, episodeId: 'synthetic-event-2', sourceId: 'synthetic-daily', source: source(content), quote, ...extra });
}

function fixture() {
  const snapshot = { schemaVersion: 1, snapshotId: 'snapshot', scope: { scopeId: 'scope', agentId: 'agent', sessionId: 'session', memoryRootId: 'root' }, capturedAt: '2026-11-09T00:00:00Z',
    sources: [source('We walked beside the river.\nWe compared notes.'), source('Other source has the invented quote.', { sourceId: 'other', path: 'other.md' })] };
  const episode = { episodeId: 'synthetic-event-1', summary: 'Synthetic walk.', when: 'unknown', participants: [], status: 'reported', category: 'relationship', importanceReason: 'Synthetic shared experience.', retention: 'recent', evidence: [{ sourceId: 'synthetic-daily', quote: 'We walked beside the river.' }] };
  const digest = { schemaVersion: 1, snapshotId: snapshot.snapshotId, episodes: [episode], coverage: { sourceIds: ['synthetic-daily'], omittedSourceIds: ['other'] } };
  return { snapshot, digest };
}

function assertOriginal(result, content) {
  assert.equal(validateQuoteValidationIssue(result), result);
  assert.equal(result.kind, 'quote-not-found');
  assert.equal(result.algorithm, 'character-bigram-dice-v1');
  assert.equal(result.debugOnly, true);
  assert.equal(result.exactMatch, false);
  assert.ok(result.search.candidates <= 4096);
  assert.ok(result.search.searchedCharacters <= 262144);
  if (result.nearest) {
    assert.equal(result.nearest.text, content.slice(result.nearest.start, result.nearest.end));
    assert.ok(result.nearest.text.length <= 2048);
    assert.ok(result.nearest.similarity >= 0 && result.nearest.similarity <= 1);
    assert.equal(result.nearest.lineStart, content.slice(0, result.nearest.start).split('\n').length);
    assert.equal(result.nearest.lineEnd, content.slice(0, result.nearest.end - 1).split('\n').length);
  }
}

test('English typo diagnostics report real same-source excerpt and zero-based episode/evidence indices', () => {
  const content = 'Synthetic heading.\nWe walked beside the river.\nUnrelated closing line.';
  const result = issue(content, 'We walked beside the rivez.');
  assertOriginal(result, content);
  assert.equal(result.episodeIndex, 1);
  assert.equal(result.evidenceIndex, 2);
  assert.equal(result.episodeId, 'synthetic-event-2');
  assert.equal(result.sourceId, 'synthetic-daily');
  assert.equal(result.sourcePath, 'daily/synthetic.md');
  // The shorter contiguous excerpt has the higher raw bigram Dice score;
  // sentence punctuation must not override the scoring algorithm.
  assert.equal(result.nearest.text, 'We walked beside the river');
  assert.equal(result.nearest.lineStart, 2);
  assert.equal(result.nearest.lineEnd, 2);
  assert.ok(result.nearest.similarity > 0.8);
  assert.equal(result.quoteTruncated, false);
});

test('Chinese rewrites and changed whitespace remain rejected diagnostic hints without normalization', () => {
  for (const [content, quote] of [
    ['合成记录：今天一起沿河散步。\n后来整理了笔记。', '合成记录：今天一起沿海散步。'],
    ['Synthetic alpha\n beta\tand gamma.', 'Synthetic alpha beta and gamma.'],
    ['Synthetic one\r\ntwo\r\nthree.', 'Synthetic one\ntwo\nthree!'],
  ]) {
    assert.ok(!content.includes(quote));
    const result = issue(content, quote);
    assertOriginal(result, content);
    assert.ok(result.nearest);
    assert.equal(result.quote, quote);
    assert.equal(result.exactMatch, false);
  }
});

test('unknown and accidentally foreign sources never search another source', () => {
  for (const selected of [undefined, source('Secret text must never appear.', { sourceId: 'foreign' })]) {
    const result = createQuoteValidationIssue({ episodeIndex: 0, evidenceIndex: 0, episodeId: 'event', sourceId: 'missing', quote: 'Secret text must never appear.', source: selected });
    assert.equal(result.nearest, null);
    assert.equal(Object.hasOwn(result, 'sourcePath'), false);
    assert.deepEqual(result.search, { sourceCharacters: 0, searchedCharacters: 0, candidates: 0, truncated: false });
    assert.equal(validateQuoteValidationIssue(result), result);
  }
});

test('empty source returns no nearest; one-character and zero-similarity comparisons stay finite', () => {
  assert.equal(issue('', 'Synthetic missing quote.').nearest, null);
  for (const [content, quote] of [['x', 'y'], ['xyz', 'a'], ['a', 'long synthetic text']]) {
    const result = issue(content, quote);
    assertOriginal(result, content);
    assert.equal(result.nearest.similarity, 0);
  }
});

test('ties and repeated candidates are deterministic and earliest equal-scoring span wins', () => {
  const content = 'abz\nabz';
  const first = issue(content, 'abc');
  assert.deepEqual(issue(content, 'abc'), first);
  assert.equal(first.nearest.text, 'ab');
  assert.equal(first.nearest.similarity, 2 / 3);
  assert.equal(first.nearest.start, 0);
  assertOriginal(first, content);
});

test('reported spans stay contiguous across newlines and use UTF-16 offsets with Unicode', () => {
  const content = '鲸🐳 prefix\nSynthetic alpha\nbeta gamma.\nend';
  const result = issue(content, 'Synthetic alpha\nbeta gammb.');
  assertOriginal(result, content);
  assert.ok(result.nearest.text.includes('\n'));
  assert.equal(result.nearest.lineStart, 2);
  assert.equal(result.nearest.lineEnd, 3);
  assert.equal(result.nearest.start, content.indexOf('Synthetic'));
});

test('long quote display truncation and source prefix coverage are explicit and bounded', () => {
  const content = 'Synthetic '.repeat(40_000) + 'THE_UNSEARCHED_TAIL';
  const quote = 'Synthetic '.repeat(300) + 'invented ending';
  const result = issue(content, quote);
  assertOriginal(result, content);
  assert.equal(result.quote.length, 2048);
  assert.equal(result.quoteTruncated, true);
  assert.equal(result.search.sourceCharacters, content.length);
  assert.equal(result.search.searchedCharacters, 262144);
  assert.equal(result.search.truncated, true);
  assert.ok(!result.nearest.text.includes('THE_UNSEARCHED_TAIL'));
  assert.ok(result.search.candidates <= 4096);
});

test('surrogate pairs are not split by quote/source excerpt display limits', () => {
  const content = 'x'.repeat(262143) + '🐳tail';
  const quote = 'y'.repeat(2047) + '🐳quoted tail';
  const result = issue(content, quote);
  assertOriginal(result, content);
  assert.equal(result.quote.length, 2047);
  assert.equal(result.search.searchedCharacters, 262143);
  assert.equal(result.quoteTruncated, true);
  assert.equal(result.search.truncated, true);
  assert.ok(!/[\uD800-\uDBFF]$/.test(result.quote));
});

test('large boundary-rich text obeys fixed scoring budget rather than scoring every window', () => {
  const content = 'x.\n'.repeat(90_000);
  const result = issue(content, 'Synthetic unrelated quote.');
  assertOriginal(result, content);
  assert.equal(result.search.searchedCharacters, 262144);
  assert.ok(result.search.candidates > 0 && result.search.candidates <= 4096);
  assert.equal(result.search.truncated, true);
});

test('strict validator rejects unknown fields, false authority, unbounded payloads and inconsistent spans', () => {
  const valid = issue('Synthetic original evidence.', 'Synthetic original evidencx.');
  const changes = [
    value => { value.extra = 'injected'; },
    value => { value.search.extra = true; },
    value => { value.nearest.extra = true; },
    value => { value.kind = 'accepted'; },
    value => { value.debugOnly = false; },
    value => { value.exactMatch = true; },
    value => { value.algorithm = 'semantic-probability'; },
    value => { value.episodeIndex = 128; },
    value => { value.evidenceIndex = -1; },
    value => { value.episodeId = 'x'.repeat(2049); },
    value => { value.sourceId = 'x'.repeat(2049); },
    value => { value.sourcePath = 'x'.repeat(4097); },
    value => { value.quote = 'x'.repeat(2049); },
    value => { value.quoteTruncated = 'false'; },
    value => { value.nearest.text = 'x'.repeat(2049); },
    value => { value.nearest.start = -1; },
    value => { value.nearest.end++; },
    value => { value.nearest.lineStart = 0; },
    value => { value.nearest.lineEnd++; },
    value => { value.nearest.similarity = NaN; },
    value => { value.nearest.similarity = 1.1; },
    value => { value.search.candidates = 4097; },
    value => { value.search.searchedCharacters = 262145; },
    value => { value.search.sourceCharacters = -1; },
    value => { value.search.sourceCharacters++; value.search.truncated = false; },
    value => { value.quoteTruncated = true; value.search.truncated = false; },
    value => { value.nearest = null; },
    value => { value.search.candidates = 0; },
  ];
  for (const change of changes) {
    const invalid = structuredClone(valid);
    change(invalid);
    assert.throws(() => validateQuoteValidationIssue(invalid), TypeError);
  }
  assert.deepEqual(validateQuoteValidationIssue(JSON.parse(JSON.stringify(valid))), valid);
});

test('format escapes hostile text, bounds identity displays, and disclaims authority/probability', () => {
  const result = issue('Synthetic original\nquote "data".', 'Synthetic altered\nquote "data".', { episodeId: 'event-' + 'x'.repeat(500) });
  const formatted = formatQuoteValidationIssue(result);
  assert.ok(formatted.includes(JSON.stringify(result.quote)));
  assert.ok(!formatted.includes('\n'));
  assert.match(formatted, /display truncated/);
  assert.match(formatted, /debugOnly=true exactMatch=false/);
  assert.match(formatted, /not an accepted quote or a probability/);
  assert.ok(formatted.length < 30_000);
});

test('diagnostics and errors never mutate sources or input records', () => {
  const selected = source('Synthetic unchanged source.');
  const input = { episodeIndex: 0, evidenceIndex: 0, episodeId: 'event', sourceId: selected.sourceId, source: selected, quote: 'Synthetic altered source.' };
  const before = structuredClone(input);
  const result = createQuoteValidationIssue(input);
  const error = new QuoteValidationError(result);
  assert.deepEqual(input, before);
  assert.ok(error instanceof TypeError);
  assert.equal(error.code, 'GENERATION_VALIDATION_FAILED');
  assert.match(error.message, /^episode evidence quote is missing from its source;/);
  assert.deepEqual(error.validationIssue, result);
  result.nearest.text = 'mutated result';
  assert.notEqual(error.validationIssue.nearest.text, result.nearest.text);
});

test('episode integration identifies the exact failing evidence and preserves the fail-closed gate', () => {
  const { snapshot, digest } = fixture();
  const original = structuredClone({ snapshot, digest });
  digest.episodes.push({ ...structuredClone(digest.episodes[0]), episodeId: 'synthetic-event-2' });
  digest.episodes[1].evidence.push({ sourceId: 'synthetic-daily', quote: 'We compared notex.' });
  assert.throws(() => validateEpisodeDigest(digest, snapshot), error => {
    assert.equal(error.code, 'GENERATION_VALIDATION_FAILED');
    assert.equal(error.validationIssue.episodeIndex, 1);
    assert.equal(error.validationIssue.evidenceIndex, 1);
    assert.equal(error.validationIssue.episodeId, 'synthetic-event-2');
    assert.equal(error.validationIssue.nearest.text, 'We compared notes');
    assert.equal(error.validationIssue.debugOnly, true);
    return true;
  });
  assert.deepEqual(snapshot, original.snapshot);
  assert.equal(validateEpisodeDigest(original.digest, snapshot), original.digest);
});

test('episode unknown source diagnostic never copies exact text from another available source', () => {
  const { snapshot, digest } = fixture();
  digest.episodes[0].evidence = [{ sourceId: 'unknown', quote: snapshot.sources[1].content }];
  assert.throws(() => validateEpisodeDigest(digest, snapshot), error => {
    assert.equal(error.validationIssue.sourceId, 'unknown');
    assert.equal(error.validationIssue.nearest, null);
    assert.equal(error.validationIssue.search.sourceCharacters, 0);
    return true;
  });
});

test('full untruncated quote determines failure even if displayed prefix matches exactly', () => {
  const { snapshot, digest } = fixture();
  snapshot.sources[0].content = 'a'.repeat(3000);
  digest.episodes[0].evidence[0].quote = 'a'.repeat(2500) + 'missing';
  assert.throws(() => validateEpisodeDigest(digest, snapshot), error => {
    assert.equal(error.validationIssue.quoteTruncated, true);
    assert.equal(error.validationIssue.quote.length, 2048);
    assert.equal(error.validationIssue.search.truncated, true);
    assert.equal(error.validationIssue.nearest.similarity, 1);
    assert.equal(error.validationIssue.exactMatch, false);
    return true;
  });
  digest.episodes[0].evidence[0].quote = snapshot.sources[0].content;
  assert.equal(validateEpisodeDigest(digest, snapshot), digest);
});

test('organizer rejects a near match once without retrying or silently substituting source text', async () => {
  const { snapshot, digest } = fixture();
  const { episodeId, ...episode } = digest.episodes[0];
  episode.evidence = [{ sourceId: 'synthetic-daily', quote: 'We walked beside the rivez.' }];
  let calls = 0;
  await assert.rejects(organizeEpisodes(snapshot, 'synthetic-job', async () => {
    calls++;
    return JSON.stringify({ episodes: [episode], coveredSourceIds: ['synthetic-daily'] });
  }, { maxEpisodes: 8, maxOutputBytes: 8192 }), error => {
    assert.equal(error.validationIssue.episodeId, 'synthetic-job-event-1');
    assert.equal(error.validationIssue.quote, episode.evidence[0].quote);
    return true;
  });
  assert.equal(calls, 1);
});
