import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const localRequire = createRequire(import.meta.url), React = localRequire('react'), { renderToStaticMarkup } = localRequire('react-dom/server');
const result = await build({ entryPoints: ['client/ValidationFailureDetails.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] });
const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(localRequire, module, module.exports);
const Component = module.exports.ValidationFailureDetails;
const issue = { kind: 'quote-not-found', episodeIndex: 2, evidenceIndex: 1, episodeId: 'event-3', sourceId: 'daily', sourcePath: 'daily/2026-11-09.md', quote: '<script>BAD_QUOTE</script>', quoteTruncated: false, nearest: { text: 'NEAREST_SOURCE', start: 5, end: 19, lineStart: 2, lineEnd: 2, similarity: 0.75 }, algorithm: 'character-bigram-dice-v1', search: { sourceCharacters: 19, searchedCharacters: 19, candidates: 1, truncated: false }, debugOnly: true, exactMatch: false };
const details = { attemptId: 'synthetic', attemptPath: '/state/attempts/synthetic.json', stage: 'organize', validationIssue: issue, archiveState: 'saved' };
const jobs = [{ jobId: 'job', state: 'failed', error: { code: 'GENERATION_VALIDATION_FAILED', message: 'failed', details } }];
test('private failure panel displays escaped quotes, same-source excerpt, score, offsets and archive separate from content-free trace', () => {
  const html = renderToStaticMarkup(React.createElement(Component, { jobs, language: 'zh-CN' }));
  for (const value of ['私密调试', 'daily/2026-11-09.md', '75.00%', 'NEAREST_SOURCE', '&lt;script&gt;', '/state/attempts/synthetic.json', '事件 3', '引用 2']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /<script>|data-generation-diagnostics=|<button|<form/); assert.match(html, /data-generation-validation="private-content"/);
});
test('archive failure and bounded-search coverage are explicit and never claim saved output', () => {
  const other = structuredClone(jobs); other[0].error.details.archiveState = 'failed'; delete other[0].error.details.attemptPath; other[0].error.details.archiveErrorCode = 'FS_DENIED'; other[0].error.details.validationIssue.search.truncated = true;
  const html = renderToStaticMarkup(React.createElement(Component, { jobs: other, language: 'en' }));
  assert.ok(html.includes('Archive failed')); assert.ok(html.includes('not exhaustive')); assert.ok(!html.includes('/state/attempts/'));
  assert.equal(renderToStaticMarkup(React.createElement(Component, { jobs: [{ jobId: 'old', state: 'failed' }], language: 'en' })), '');
});
