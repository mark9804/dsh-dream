import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../dist/engine.js';
import { validateConfig } from '../dist/config.js';
import { createWorkerGenerator } from '../dist/scheduler/executor.js';
import { localDate } from '../dist/scheduler/window.js';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { createStore } from '../dist/storage/index.js';
import { createCleanReviewer } from '../dist/harness/clean-review.js';

const generatedRoot = fileURLToPath(new URL('../tests/.tmp/', import.meta.url));
await mkdir(generatedRoot, { recursive: true });
const directory = await mkdtemp(join(generatedRoot, 'demo-'));
const local = createLocalFiles(directory);
const localPath = (path) => isAbsolute(path) ? relative(directory, path) : path;
const files = {
  ...local,
  read: (path, options) => local.read(localPath(path), options),
  write: (path, text, version) => local.write(localPath(path), text, version),
  stat: (path) => local.stat(localPath(path)),
  list: (path) => local.list(localPath(path)),
  mkdir: (path) => local.mkdir(localPath(path)),
};

// Only the injected clock changes; the machine clock and real profile are untouched.
const fakeNow = new Date();
fakeNow.setHours(5, 30, 0, 0);
const day = localDate(fakeNow, 'local');
const config = validateConfig({
  sessionId: 'synthetic-demo-session',
  memoryRoot: join(directory, 'memory'),
  stateRoot: join(directory, 'state'),
  timeoutMs: 10000,
});
const scope = {
  scopeId: 'synthetic-demo', agentId: config.sessionId, sessionId: config.sessionId,
  memoryRootId: config.memoryRoot,
};
const actor = { agentId: scope.agentId, sessionId: scope.sessionId };
const diaryPath = `daily/${day}.md`;
const fact = '合成实验已经完成。';
const feeling = '合成角色看到测试结果时感到轻松。';
const acceptedText = '- [合成事实] 合成实验已经完成。\n';
const deferredText = '- [合成角色的主观感受] 看到测试结果时感到轻松。\n';
const initialMemory = '# 合成长期记忆\n\n## pinned\n- 合成角色的称呼不可修改。\n\n## 普通记忆\n';
await files.mkdir(join(config.memoryRoot, 'daily'));
await files.mkdir(join(config.memoryRoot, 'ideas'));
for (const [path, text] of [
  ['long-term.md', initialMemory],
  ['decisions.md', '# 合成决策\n'],
  ['journal.md', '# 合成日志\n这里仅有演示资料，不含真实用户记录。\n'],
  [diaryPath, `# ${day} 合成日记\n${fact}${feeling}\n`],
]) await files.write(join(config.memoryRoot, path), text, null);

const stages = [];
const model = async (prompt, { signal }) => {
  signal.throwIfAborted();
  if (prompt.includes('\nLIGHT：')) {
    stages.push('light');
    return JSON.stringify({ observations: [
      { sourceId: diaryPath, quote: fact, text: '一项合成实验完成。' },
      { sourceId: diaryPath, quote: feeling, text: '合成角色记录了主观感受。' },
    ] });
  }
  if (prompt.startsWith('REM：')) {
    stages.push('rem');
    return JSON.stringify({ dream: '【合成梦境】一条纸做的鱼把测试结果折成云，梦里的轻松感属于合成角色，并不证明任何现实事件。', themes: ['完成', '轻松'] });
  }
  if (prompt.includes('\nDEEP：')) {
    stages.push('deep');
    return JSON.stringify({ proposals: [
      { kind: 'fact', text: '记录合成实验完成。', reason: '合成日记有直接记录。',
        evidence: [{ sourceId: diaryPath, quote: fact }], targetId: 'long-term.md',
        operation: 'append', before: '', after: acceptedText,
        consolidation: { action: 'add', claimKey: 'synthetic-completion', applicability: { topic: 'synthetic-test', conditions: 'only this fictional experiment' }, basis: 'observation' } },
      { kind: 'feeling', text: '保留合成角色的轻松感。', reason: '合成日记明确标注了感受归属。',
        evidence: [{ sourceId: diaryPath, quote: feeling }], targetId: 'long-term.md',
        operation: 'append', before: '', after: deferredText,
        consolidation: { action: 'add', claimKey: 'synthetic-feeling', applicability: { topic: 'synthetic-test', conditions: 'at this particular time only' }, basis: 'observation' } },
    ] });
  }
  throw new Error('Unexpected fake-model stage');
};

let releaseIdle;
const idle = new Promise((resolve) => { releaseIdle = resolve; });
let reviewing = true;
const hostCalls = { review: [], reload: [], reports: [], compactions: 0 };
const host = {
  async waitForIdle() { if (reviewing) await idle; },
  async maintain(work) {
    assert.equal(reviewing, false, 'Submission must wait for the synthetic review turn to finish');
    return work();
  },
  async compact() {
    hostCalls.compactions++;
    return { compactionId: 'fake-compaction-1' };
  },
  async requestReview(text, receipt) { hostCalls.review.push({ text, ...receipt }); },
  async requestReload(text, receipt) { hostCalls.reload.push({ text, ...receipt }); },
  async notify(text, receipt) { hostCalls.reports.push({ text, ...receipt }); },
};
const store = createStore(files, { root: config.stateRoot, lockKey: scope.memoryRootId, now: () => fakeNow.toISOString() });
const worker = createWorkerGenerator(model, config);
let executorThreadId;
const generate = async (...args) => {
  const result = await worker(...args);
  executorThreadId = result.executorThreadId;
  return result;
};
const controller = new AbortController();
// Synthetic transport, real clean-review prompt/parser/provenance boundary.
const reviewRequests = [];
const cleanReview = createCleanReviewer({ llm: { async prepareCall(config) {
  return { config, async *stream(request) {
    reviewRequests.push(request);
    assert.equal(request.messages.length, 1);
    assert.equal(request.messages[0].content[0].text.includes('纸做的鱼'), false);
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ decision: 'accept', reason: '合成审核：原始日记直接支持该完成记录。' }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
} } }, { session: { id: config.sessionId }, options: { provider: 'synthetic', model: 'fixture-reviewer' } }, config);
const engine = createEngine({ config, scope, files, store, generate, cleanReview, host,
  signal: controller.signal, now: () => new Date(fakeNow) });

try {
  const job = await engine.dream();
  assert.equal(job.state, 'awaiting_review');
  assert.equal(hostCalls.review.length, 1);
  assert.equal(job.proposals.length, 2);
  assert.ok(executorThreadId > 0, 'The generator must run in a real worker thread');
  assert.equal((await files.read(join(config.memoryRoot, 'long-term.md'))).content, initialMemory);

  await engine.review({ jobId: job.jobId, proposalId: job.proposals[0].proposalId,
    decision: 'review', reason: '请求隔离核查合成日记；此理由不传给审核模型。' }, { actor });
  await engine.review({ jobId: job.jobId, proposalId: job.proposals[1].proposalId,
    decision: 'defer', reason: '合成审核端暂缓决定是否长期保留这份感受。' }, { actor });
  assert.equal((await files.read(join(config.memoryRoot, 'long-term.md'))).content, initialMemory);
  reviewing = false;
  releaseIdle();
  await engine.flush();

  const submitted = await store.loadJob(job.jobId);
  assert.equal(submitted.state, 'awaiting_reload');
  assert.equal(hostCalls.reload.length, 1);
  assert.equal(hostCalls.reports.length, 0, 'An unacknowledged reload is not completion');
  const memory = await files.read(join(config.memoryRoot, 'long-term.md'));
  assert.equal(memory.content, initialMemory + acceptedText);
  assert.equal(memory.content.includes(deferredText), false);

  const readSourceIds = [];
  for (const source of submitted.reload.sources) {
    assert.ok(await files.read(source.path));
    readSourceIds.push(source.sourceId);
  }
  const receipt = { jobId: job.jobId, transactionId: submitted.reload.transactionId, readSourceIds };
  await engine.ackReload(receipt, { actor });
  await engine.ackReload(receipt, { actor });
  await engine.flush();
  const finalJob = await store.loadJob(job.jobId);
  assert.equal(finalJob.state, 'awaiting_review');
  assert.deepEqual(finalJob.appliedProposalIds, [job.proposals[0].proposalId]);
  assert.equal(finalJob.reviews.findLast((review) => review.proposalId === job.proposals[1].proposalId).decision, 'defer');
  assert.equal(hostCalls.reports.length, 1);
  assert.equal(hostCalls.compactions, 1);

  const repeated = await engine.dream();
  assert.equal(repeated.reused, true);
  assert.equal(repeated.jobId, job.jobId);
  assert.deepEqual(stages, ['light', 'rem', 'deep']);
  const transactions = await store.listTransactions();
  assert.equal(transactions.length, 1);
  const summary = {
    schemaVersion: 1,
    demonstration: 'fake model / fake Host；非实机集成；全部内容均为合成数据',
    directory,
    fakeClock: { localDate: day, localTime: '05:30', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    executorThreadId,
    modelStages: stages,
    modelCallCount: stages.length,
    jobId: job.jobId,
    finalState: finalJob.state,
    acceptedAndApplied: [job.proposals[0].proposalId],
    deferred: [job.proposals[1].proposalId],
    fakeCompactionCount: hostCalls.compactions,
    reloadAcknowledged: true,
    reportCount: hostCalls.reports.length,
    repeatedInputReused: repeated.reused,
    paths: {
      memory: join(config.memoryRoot, 'long-term.md'),
      dream: finalJob.dreamPath,
      job: join(config.stateRoot, 'jobs', `${encodeURIComponent(job.jobId)}.json`),
      backups: transactions.flatMap((transaction) => transaction.entries.map((entry) => entry.backup).filter(Boolean)),
    },
  };
  await files.write('summary.json', `${JSON.stringify(summary, null, 2)}\n`, null);
  console.log('合成演示完成：fake model / fake Host，非实机集成。');
  console.log(`全部生成资料保留在：${directory}`);
  console.log(`摘要：${join(directory, 'summary.json')}`);
  console.log(JSON.stringify({ modelCalls: stages.length, workerThreadId: executorThreadId,
    applied: 1, deferred: 1, reports: hostCalls.reports.length, repeatedInputReused: repeated.reused }, null, 2));
} finally {
  reviewing = false;
  releaseIdle();
  controller.abort(new Error('Synthetic demo finished'));
  await engine.flush().catch(() => {});
}
