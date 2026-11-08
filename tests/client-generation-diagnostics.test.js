import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const localRequire = createRequire(import.meta.url), React = localRequire('react'), { renderToStaticMarkup } = localRequire('react-dom/server');
const result = await build({ entryPoints: ['client/GenerationDiagnostics.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] });
const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(localRequire, module, module.exports);
const Component = module.exports.GenerationDiagnostics;
const diagnostic = {
  schemaVersion: 1, attemptId: 'synthetic-attempt', snapshotId: 'synthetic-snapshot', mode: 'memory-v2', state: 'timed_out', stage: 'deep', startedAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:15:00Z', elapsedMs: 900000, timeoutMs: 900000,
  finishedAt: '2026-11-08T00:15:00Z', settledAt: '2026-11-08T00:15:01Z', failureCode: 'DREAM_EXECUTOR_TIMEOUT', input: { sourceCount: 1, contentBytes: 10, serializedSourceBytes: 20 },
  stages: [{ stage: 'deep', startedAt: '2026-11-08T00:00:00Z', finishedAt: '2026-11-08T00:15:00Z', elapsedMs: 900000 }],
  calls: [{ sequence: 1, stage: 'deep', state: 'cancelled', startedAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:15:00Z', elapsedMs: 900000, inputBytes: 20, outputBytes: 3, reasoningBytes: 4, chunkCount: 2, callId: 'synthetic-call', provider: 'fake', model: 'fake-model', firstTokenAt: '2026-11-08T00:00:01Z', usage: { inputTokens: 10 }, failureCode: 'DREAM_EXECUTOR_TIMEOUT' }],
};
const jobs = [{ jobId: 'synthetic-job', state: 'failed', generationDiagnostics: diagnostic }];
test('diagnostic disclosure renders translated stage, minutes, route and actual settlement without controls', () => {
  const html = renderToStaticMarkup(React.createElement(Component, { jobs, language: 'zh-CN' }));
  for (const value of ['生成阶段诊断', '整理提案', '超时', '执行器已退出', 'synthetic-call', '15 min', 'fake-model', '不记录素材']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /<input|<button|<form|<script/);
});
test('older jobs are explicitly unavailable and unfinished cancellation is not described as drained', () => {
  const old = renderToStaticMarkup(React.createElement(Component, { jobs: [{ jobId: 'old', state: 'failed' }], language: 'en' }));
  assert.ok(old.includes('cannot be reconstructed retrospectively'));
  const d = structuredClone(diagnostic); delete d.settledAt;
  const pending = renderToStaticMarkup(React.createElement(Component, { jobs: [{ ...jobs[0], generationDiagnostics: d }], language: 'en' }));
  assert.ok(pending.includes('waiting for the call to settle')); assert.ok(!pending.includes('Executor settled'));
  assert.equal(renderToStaticMarkup(React.createElement(Component, { jobs: [], language: 'zh' })), '');
});
test('existing settings runtime panel consumes diagnostics without new polling or mutation authority', async () => {
  const source = await readFile(new URL('../client/SettingsPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /<GenerationDiagnostics jobs=\{snapshot\.status\.jobs\} language=\{locale\.getSnapshot\(\)\.active\} \/>/);
  const component = await readFile(new URL('../client/GenerationDiagnostics.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(component, /fetch\(|\bapi\.[a-zA-Z]+\(|setInterval|dangerouslySetInnerHTML/);
});
