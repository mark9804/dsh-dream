import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { validateConfig } from '../dist/config.js';
import { createEngine } from '../dist/engine.js';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { createStore } from '../dist/storage/index.js';
import { candidateView } from '../dist/dream/lineage.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

const temporaryRoot = fileURLToPath(new URL('./.tmp/', import.meta.url));
const kept = '- For synthetic build failures, prefer a concise diagnosis.\n';
const initialMemory = `# Synthetic memory\n${kept}UNCHANGED_MEMORY_SENTINEL\n`;
const request = 'Synthetic user request: for build failures, give a concise diagnosis.';
const applicability = { topic: 'synthetic build-failure replies', conditions: 'Only while diagnosing synthetic build failures.',
  validFrom: '2026-10-26T00:00:00Z', validUntil: '2026-11-02T00:00:00Z' };

// All semantic choices and verdicts below are deterministic synthetic model output.
// These tests verify orchestration and write boundaries, not model truth judgments.
async function fixture(t, { memory = initialMemory, journal = `${request}\n`, config: overrides = {}, generate, cleanReview } = {}) {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'reinforcement-flow-'));
  const local = createLocalFiles(directory);
  const localPath = path => isAbsolute(path) ? relative(directory, path) : path;
  const writes = [];
  const files = {
    ...local,
    read: (path, options) => local.read(localPath(path), options),
    stat: path => local.stat(localPath(path)),
    list: path => local.list(localPath(path)),
    mkdir: path => local.mkdir(localPath(path)),
    async write(path, content, version) {
      const result = await local.write(localPath(path), content, version);
      writes.push({ path: localPath(path), content });
      return result;
    },
  };
  const config = validateConfig({ sessionId: 'synthetic-session', memoryRoot: join(directory, 'memory'), stateRoot: join(directory, 'state'),
    timeZone: 'UTC', singleRun: false, ...overrides });
  const scope = { scopeId: 'synthetic-scope', agentId: 'synthetic-agent', sessionId: config.sessionId, memoryRootId: config.memoryRoot };
  const actor = { agentId: scope.agentId, sessionId: scope.sessionId };
  let clock = new Date('2026-10-26T05:30:00Z');
  let sequence = 0;
  let round = 0;
  let idle;
  let release;
  const busy = () => { if (!idle) idle = new Promise(resolve => { release = resolve; }); };
  const becomeIdle = () => { const done = release; idle = undefined; release = undefined; done?.(); };
  const controller = new AbortController();
  const calls = { generated: [], reviewed: [], maintain: 0, compact: 0, review: [], reload: [], notify: [] };
  await files.mkdir(join(config.memoryRoot, 'daily'));
  await files.mkdir(join(config.memoryRoot, 'ideas'));
  await files.write(join(config.memoryRoot, 'long-term.md'), memory, null);
  await files.write(join(config.memoryRoot, 'decisions.md'), '# Synthetic decisions\n', null);
  await files.write(join(config.memoryRoot, 'journal.md'), journal, null);
  writes.length = 0;
  const store = createStore(files, { root: config.stateRoot, lockKey: scope.memoryRootId, changeBudget: config, now: () => clock.toISOString() });
  const engine = createEngine({ config, scope, files, store, signal: controller.signal, now: () => new Date(clock), id: () => `synthetic-${++sequence}`,
    generate: async (snapshot, jobId) => {
      calls.generated.push(structuredClone(snapshot));
      const proposals = await generate(snapshot, jobId, round++);
      return { dream: 'DREAM_SUMMARY_SENTINEL: a fictional synthetic dream, not evidence.', proposals };
    },
    cleanReview: async (snapshot, proposal) => {
      calls.reviewed.push({ snapshot: structuredClone(snapshot), proposal: structuredClone(proposal) });
      const verdict = await cleanReview?.(snapshot, proposal) ?? { decision: 'accept', reason: 'Scripted synthetic clean-model judgment.' };
      return { ...verdict, authority: syntheticCleanAuthority(snapshot, proposal, { callId: `synthetic-review-${++sequence}` }) };
    },
    host: {
      async waitForIdle() { if (idle) await idle; },
      async maintain(operation) { assert.equal(idle, undefined); calls.maintain++; return operation(controller.signal); },
      async compact() { calls.compact++; return { compactionId: `synthetic-compaction-${calls.compact}` }; },
      async requestReview(text, metadata) { calls.review.push({ text, ...metadata }); busy(); },
      async requestReload(text, metadata) { calls.reload.push({ text, ...metadata }); },
      async notify(text, metadata) { calls.notify.push({ text, ...metadata }); },
    },
  });
  t.after(async () => {
    becomeIdle();
    controller.abort(new Error('Synthetic fixture cleanup'));
    await engine.flush().catch(() => {});
    const cleanup = resolve(directory);
    assert.equal(resolve(temporaryRoot, relative(temporaryRoot, cleanup)), cleanup);
    assert.ok(cleanup.startsWith(`${resolve(temporaryRoot)}/reinforcement-flow-`));
    await rm(cleanup, { recursive: true, force: true });
  });
  async function put(name, content) {
    const path = join(config.memoryRoot, name);
    const current = await files.read(path);
    await files.write(path, content, current?.version ?? null);
  }
  return { engine, store, files, config, scope, calls, writes, put,
    nextDay() { clock = new Date(clock.getTime() + 86400000); },
    date: () => clock.toISOString().slice(0, 10),
    memory: () => files.read(join(config.memoryRoot, 'long-term.md')),
    memoryWrites: () => writes.filter(write => write.path.startsWith('memory/')),
    async review(job, index = 0, decision = 'review') {
      busy();
      return engine.review({ jobId: job.jobId, proposalId: job.proposals[index].proposalId, decision, reason: 'Synthetic main-agent request, never clean-model evidence.' }, { actor });
    },
    async settle(job) { becomeIdle(); await engine.flush(); return store.loadJob(job.jobId); },
    async acknowledge(job) {
      const pending = await store.loadJob(job.jobId);
      assert.equal(pending.state, 'awaiting_reload');
      for (const source of pending.reload.sources) assert.equal((await files.read(source.path)).content, source.content);
      return engine.ackReload({ jobId: job.jobId, transactionId: pending.reload.transactionId,
        readSourceIds: pending.reload.sources.map(source => source.sourceId) }, { actor });
    },
  };
}

function proposal(jobId, suffix, overrides = {}) {
  return { schemaVersion: 1, proposalId: `${jobId}-${suffix}`, jobId, kind: 'preference',
    text: 'GENERATOR_TEXT_SENTINEL', reason: 'GENERATOR_REASON_SENTINEL',
    evidence: [{ sourceId: 'journal.md', quote: request }], targetId: 'long-term.md',
    operation: 'retain', before: kept, after: kept,
    consolidation: { action: 'keep', claimKey: 'synthetic-build-response', applicability, basis: 'explicit' }, ...overrides };
}

async function assertNoMemoryChanges(f, original = initialMemory) {
  assert.equal((await f.memory()).content, original);
  assert.deepEqual(f.memoryWrites(), []);
  assert.deepEqual(await f.store.listTransactions(), []);
  assert.equal(f.calls.maintain, 0);
  assert.equal(f.calls.compact, 0);
  assert.deepEqual(f.calls.reload, []);
  assert.equal(f.calls.notify.some(message => message.transactionId), false);
}

test('reinforcement policy has explicit positive byte, promotion and candidate defaults', () => {
  const base = { sessionId: 'synthetic', memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state' };
  const defaults = validateConfig(base);
  assert.equal(defaults.maxChangeBytes, 32768);
  assert.equal(defaults.maxPromotions, 4);
  assert.equal(defaults.maxCandidates, 64);
  assert.equal(defaults.singleRun, false);
  for (const field of ['maxChangeBytes', 'maxPromotions', 'maxCandidates']) {
    for (const invalid of [0, -1, 1.5, Infinity]) assert.throws(() => validateConfig({ ...base, [field]: invalid }), /positive integer/);
  }
});

test('scripted keep/reinforce across rereads, copied files and new evidence never duplicates correct memory', async t => {
  const newRequest = 'Another synthetic request: under build failures, concise diagnosis still applies.';
  const f = await fixture(t, { generate(snapshot, jobId, round) {
    const evidence = [{ sourceId: 'journal.md', quote: request }];
    if (round >= 2) evidence.push({ sourceId: `daily/${f.date()}.md`, quote: round === 2 ? request : newRequest });
    return [proposal(jobId, 'retain', { evidence,
      consolidation: { action: round ? 'reinforce' : 'keep', claimKey: 'synthetic-build-response', applicability, basis: 'explicit' } })];
  } });
  const original = await f.memory();
  const roots = [];
  for (let round = 0; round < 4; round++) {
    if (round) f.nextDay();
    if (round === 1) await f.put('journal.md', `${request}\nSynthetic bookkeeping revision, not a new event.\n`);
    if (round === 2) await f.put(`daily/${f.date()}.md`, (await f.files.read(join(f.config.memoryRoot, 'journal.md'))).content);
    if (round === 3) await f.put(`daily/${f.date()}.md`, `${newRequest}\n`);
    f.writes.length = 0;
    const job = await f.engine.dream();
    assert.equal(job.state, 'awaiting_review');
    const retained = job.proposals[0];
    assert.equal(retained.operation, 'retain');
    assert.equal(retained.before, kept);
    assert.equal(retained.after, kept);
    assert.equal(retained.lineage.independentEvents, 'unknown');
    roots.push(retained.lineage.rootIds);
    if (round) {
      assert.equal(job.snapshot.candidates.items.length, 1);
      assert.equal(job.snapshot.candidates.items[0].status, 'retained');
      assert.equal(job.snapshot.candidates.items[0].independentEvents, 'unknown');
    }
    if (round === 2) {
      const journal = job.snapshot.sources.find(source => source.sourceId === 'journal.md');
      const copy = job.snapshot.sources.find(source => source.sourceId === `daily/${f.date()}.md`);
      assert.notEqual(copy.provenance.artifactId, journal.provenance.artifactId);
      assert.deepEqual(copy.provenance.rootIds, journal.provenance.rootIds);
    }
    await f.review(job);
    const completed = await f.settle(job);
    assert.equal(completed.state, 'reviewed_no_changes');
    assert.deepEqual(completed.appliedProposalIds, []);
    assert.equal(completed.reviews[0].decision, 'accept');
    assert.equal(completed.reviews[0].authority.policyVersion, 2);
    assert.equal(completed.transaction, undefined);
    assert.equal(completed.reportDelivery, undefined);
    await assertNoMemoryChanges(f);
    assert.deepEqual(await f.memory(), original, 'Retain does not even refresh the memory file version');
    const reread = await f.engine.dream();
    assert.equal(reread.reused, true, 'Unchanged inputs do not schedule endless candidate rehearsal');
    assert.equal(reread.jobId, job.jobId);
  }
  assert.equal(f.calls.generated.length, 4, 'Changed materials on four in-window days are not singleRun reuse');
  assert.equal(roots[0].length, 1);
  assert.deepEqual(roots[1], roots[0], 'Revising the same artifact does not create another root');
  assert.deepEqual(roots[2], roots[0], 'An exact copied artifact is not another support root');
  assert.equal(roots[3].length, 2, 'A new artifact is traceable, not proof of an independent event');
  const view = candidateView(await f.store.listJobs(), f.scope, f.config.maxCandidates);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].proposalIds.length, 4);
  assert.deepEqual(view.items[0].rootIds, roots[3]);
  assert.equal(view.items[0].independentEvents, 'unknown');
  assert.deepEqual(f.calls.notify, []);
});

test('scripted bounded correction replaces an exact wrong fragment, then retains it without automatic deletion', async t => {
  const wrong = '- Every synthetic reply must always be concise.\n';
  const original = initialMemory.replace(kept, wrong);
  const correction = 'Synthetic user correction: concise diagnosis applies only to synthetic build failures during this trial; other replies are unchanged.';
  const f = await fixture(t, { memory: original, journal: `${correction}\n`,
    generate(snapshot, jobId, round) {
      return [proposal(jobId, 'bounded', { evidence: [{ sourceId: 'journal.md', quote: correction }],
        operation: round ? 'retain' : 'replace', before: round ? kept : wrong, after: kept,
        consolidation: { action: round ? 'keep' : 'correct', claimKey: 'synthetic-build-response', applicability, basis: 'correction' } })];
    },
    cleanReview(snapshot, current) {
      assert.deepEqual(current.consolidation.applicability, applicability);
      assert.equal(current.after, kept);
      assert.ok(snapshot.sources.find(source => source.sourceId === 'journal.md').content.includes(correction));
      return { decision: 'accept', reason: 'Scripted agent selects the bounded correction, not deletion or a universal rule.' };
    },
  });
  const job = await f.engine.dream();
  assert.equal((await f.memory()).content, original, 'Generating a correction cannot decide or apply it automatically');
  await f.review(job);
  const committed = await f.settle(job);
  assert.equal(committed.state, 'awaiting_reload');
  assert.deepEqual(committed.transaction.changes.map(change => ({ targetId: change.targetId, before: change.before, after: change.after })),
    [{ targetId: 'long-term.md', before: original, after: initialMemory }]);
  assert.equal((await f.memory()).content, initialMemory);
  assert.equal(f.memoryWrites().length, 1);
  assert.equal(f.memoryWrites().some(write => write.path.includes('/archive/')), false);
  await f.acknowledge(job);
  f.nextDay();
  await f.put('journal.md', `${correction}\nSynthetic trial bookkeeping update.\n`);
  f.writes.length = 0;
  const again = await f.engine.dream();
  await f.review(again);
  assert.equal((await f.settle(again)).state, 'reviewed_no_changes');
  assert.deepEqual(f.memoryWrites(), []);
  assert.equal((await f.memory()).content, initialMemory);
  assert.equal((await f.store.listTransactions()).length, 1);
  assert.equal(f.calls.compact, 1);
});

test('needs-verification retains a read-only source candidate and later promotes that existing candidate on explicit new evidence', async t => {
  const tentative = 'Synthetic observation: a checklist may help this dry-run trial.';
  const confirmed = 'Synthetic user instruction: preserve the checklist for this dry-run trial only.';
  const promoted = '- Use the synthetic checklist for this dry-run trial only.\n';
  const scope = { topic: 'synthetic dry-run checklist', conditions: 'Only this synthetic dry-run trial.' };
  const f = await fixture(t, { journal: `${tentative}\n`, generate(snapshot, jobId, round) {
    if (!round) return [proposal(jobId, 'candidate', { targetId: 'journal.md', before: tentative, after: tentative,
      evidence: [{ sourceId: 'journal.md', quote: tentative }],
      consolidation: { action: 'needs-verification', claimKey: 'synthetic-checklist', applicability: scope, basis: 'uncertain' } })];
    const existing = snapshot.candidates.items.find(candidate => candidate.claimKey === 'synthetic-checklist');
    assert.equal(existing.status, 'retained');
    return [proposal(jobId, 'promote', { operation: 'append', before: '', after: promoted,
      evidence: [{ sourceId: 'journal.md', quote: confirmed }],
      consolidation: { action: 'promote', claimKey: existing.claimKey, applicability: scope, candidateId: existing.candidateId, basis: 'explicit' } })];
  } });
  const first = await f.engine.dream();
  assert.equal(first.snapshot.sources.find(source => source.sourceId === 'journal.md').writable, false);
  await f.review(first);
  const retained = await f.settle(first);
  assert.equal(retained.state, 'reviewed_no_changes');
  await assertNoMemoryChanges(f);
  f.nextDay();
  await f.put('journal.md', `${tentative}\n${confirmed}\n`);
  f.writes.length = 0;
  const second = await f.engine.dream();
  const existing = second.snapshot.candidates.items[0];
  assert.equal(existing.status, 'retained');
  assert.deepEqual(existing.proposalIds, [first.proposals[0].proposalId]);
  assert.equal(second.proposals[0].consolidation.candidateId, existing.candidateId);
  assert.deepEqual(second.proposals[0].lineage.rootIds, first.proposals[0].lineage.rootIds, 'A new explicit statement in one artifact is not another root');
  assert.equal(second.proposals[0].lineage.independentEvents, 'unknown');
  await f.review(second);
  const applied = await f.settle(second);
  assert.deepEqual(applied.appliedProposalIds, [second.proposals[0].proposalId]);
  assert.equal((await f.memory()).content, initialMemory + promoted);
  assert.equal(f.memoryWrites().length, 1);
  await f.acknowledge(second);
  assert.deepEqual(await f.store.loadJob(first.jobId), retained, 'Promotion does not rewrite the original candidate judgment');
  const view = candidateView(await f.store.listJobs(), f.scope, f.config.maxCandidates);
  assert.equal(view.total, 1);
  assert.equal(view.items[0].candidateId, existing.candidateId);
  assert.equal(view.items[0].status, 'active');
  assert.equal(view.items[0].proposalIds.length, 2);
  assert.equal(view.items[0].independentEvents, 'unknown');
});

for (const basis of ['recurrence', 'uncertain']) test(`${basis} cannot obtain a writable acceptance even from a scripted accepting reviewer`, async t => {
  const f = await fixture(t, { generate(snapshot, jobId) {
    return [proposal(jobId, 'unverified', { operation: 'append', before: '', after: '- An unverified synthetic conclusion.\n',
      consolidation: { action: 'add', claimKey: 'unverified-synthetic-claim', applicability, basis } })];
  } });
  const job = await f.engine.dream();
  f.writes.length = 0;
  await assert.rejects(f.review(job), { code: 'NEEDS_VERIFICATION' });
  assert.equal(f.calls.reviewed.length, 1, 'A synthetic clean verdict is exercised, not skipped');
  assert.deepEqual(f.writes, [], 'Invalid acceptance cannot persist an approving review');
  assert.deepEqual((await f.store.loadJob(job.jobId)).reviews, []);
  await f.review(job, 0, 'defer');
  const pending = await f.settle(job);
  assert.equal(pending.state, 'awaiting_review');
  assert.equal(pending.reviews[0].decision, 'defer');
  await assertNoMemoryChanges(f);
  assert.equal(candidateView([pending], f.scope, f.config.maxCandidates).items[0].status, 'pending');
});

test('candidate view cap discloses omitted candidates to generation and status without erasing history', async t => {
  const f = await fixture(t, { config: { maxCandidates: 1 }, generate(snapshot, jobId, round) {
    return round ? [] : ['alpha', 'beta', 'gamma'].map(key => proposal(jobId, key, {
      consolidation: { action: 'needs-verification', claimKey: `synthetic-${key}`, applicability, basis: 'uncertain' },
    }));
  } });
  const first = await f.engine.dream();
  for (let index = 0; index < first.proposals.length; index++) await f.review(first, index);
  assert.equal((await f.settle(first)).state, 'reviewed_no_changes');
  f.nextDay();
  await f.put('journal.md', `${request}\nSynthetic next-day bookkeeping.\n`);
  f.writes.length = 0;
  const second = await f.engine.dream();
  const view = f.calls.generated[1].candidates;
  assert.equal(view.items.length, 1);
  assert.equal(view.total, 3);
  assert.equal(view.truncated, true);
  assert.equal(view.items[0].status, 'retained');
  assert.deepEqual((await f.engine.status({ jobId: second.jobId })).candidates, view);
  assert.equal((await f.store.loadJob(first.jobId)).proposals.length, 3);
  await assertNoMemoryChanges(f);
});

async function assertBudgetDeferred(f, job, originals) {
  for (let index = 0; index < job.proposals.length; index++) await f.review(job, index);
  const pending = await f.settle(job);
  assert.equal(pending.state, 'awaiting_review');
  assert.equal(pending.recovery.action, 'reduce_batch');
  assert.match(pending.recovery.message, /exceeds change budget/);
  assert.deepEqual(pending.proposals.map(item => ({ before: item.before, after: item.after })), originals);
  assert.equal(pending.reviews.length, job.proposals.length);
  assert.ok(pending.reviews.every(review => review.decision === 'accept'));
  assert.deepEqual(pending.appliedProposalIds, []);
  assert.equal(pending.transaction, undefined);
  await assertNoMemoryChanges(f);
  assert.equal(f.calls.notify.length, 1, 'One budget attention notice, not a change report');
  assert.equal(pending.reportDelivery, undefined);
  f.engine.submit({ jobId: job.jobId });
  await f.engine.flush();
  await assertNoMemoryChanges(f);
  assert.equal(f.calls.notify.length, 1, 'Retry neither commits a prefix nor repeats the notice');
}

test('UTF-8 byte budget defers the complete approved batch rather than truncating edits or writing a prefix', async t => {
  const additions = ['- Synthetic café tip one.\n', '- Synthetic café tip two.\n'];
  const cap = additions.reduce((total, text) => total + Buffer.byteLength(text), 0) - 1;
  assert.ok(additions.every(text => Buffer.byteLength(text) <= cap));
  const f = await fixture(t, { config: { maxChangeBytes: cap }, generate(snapshot, jobId) {
    return additions.map((after, index) => proposal(jobId, `byte-${index}`, { operation: 'append', before: '', after,
      consolidation: { action: 'add', claimKey: `synthetic-byte-${index}`, applicability, basis: 'explicit' } }));
  } });
  const job = await f.engine.dream();
  await assertBudgetDeferred(f, job, additions.map(after => ({ before: '', after })));
});

test('promotion budget defers all promotions of existing candidates without partial writes', async t => {
  const additions = ['- Synthetic promotion alpha.\n', '- Synthetic promotion beta.\n'];
  const f = await fixture(t, { config: { maxPromotions: 1 }, generate(snapshot, jobId, round) {
    return additions.map((after, index) => {
      const claimKey = `synthetic-promotion-${index}`;
      const existing = snapshot.candidates.items.find(candidate => candidate.claimKey === claimKey);
      if (round) assert.equal(existing.status, 'retained');
      return proposal(jobId, `promotion-${index}`, round ? { operation: 'append', before: '', after,
        consolidation: { action: 'promote', claimKey, applicability, candidateId: existing.candidateId, basis: 'explicit' } }
        : { consolidation: { action: 'needs-verification', claimKey, applicability, basis: 'uncertain' } });
    });
  } });
  const first = await f.engine.dream();
  for (let index = 0; index < first.proposals.length; index++) await f.review(first, index);
  assert.equal((await f.settle(first)).state, 'reviewed_no_changes');
  f.nextDay();
  await f.put('journal.md', `${request}\nSynthetic explicit request to preserve both bounded tips.\n`);
  f.writes.length = 0;
  const second = await f.engine.dream();
  assert.equal(second.snapshot.candidates.total, 2);
  await assertBudgetDeferred(f, second, additions.map(after => ({ before: '', after })));
});

test('deferred sibling review inherits the current job applied proposal root after partial commit and reload', async t => {
  const derived = '- Synthetic build-failure diagnosis stays concise during this trial.\n';
  const draft = `Unconfirmed draft: ${derived}`;
  const original = `${initialMemory}${draft}`;
  const expected = `${initialMemory}${derived}`;
  const f = await fixture(t, { memory: original, generate(snapshot, jobId) {
    return [proposal(jobId, 'first-commit', { operation: 'replace', before: draft, after: derived,
      consolidation: { action: 'correct', claimKey: 'synthetic-partial-correction', applicability, basis: 'correction' },
    }), proposal(jobId, 'deferred-sibling', { before: derived, after: derived, evidence: [{ sourceId: 'long-term.md', quote: derived }],
      consolidation: { action: 'reinforce', claimKey: 'synthetic-partial-reinforcement', applicability, basis: 'explicit' },
    })];
  } });
  const job = await f.engine.dream();
  const parent = job.proposals[0];
  const sibling = job.proposals[1];
  const memoryRoot = job.snapshot.sources.find(source => source.sourceId === 'long-term.md').provenance.artifactId;
  assert.deepEqual(sibling.lineage.rootIds, [memoryRoot], 'Before any commit the draft is only a memory artifact');
  assert.deepEqual(sibling.lineage.derivedFrom, []);
  assert.ok(!parent.lineage.rootIds.includes(memoryRoot));
  await f.review(job);
  await f.review(job, 1, 'defer');
  const partial = await f.settle(job);
  assert.equal(partial.state, 'awaiting_reload');
  assert.deepEqual(partial.appliedProposalIds, [parent.proposalId]);
  assert.equal((await f.memory()).content, expected);
  await f.acknowledge(job);
  assert.equal((await f.store.loadJob(job.jobId)).state, 'awaiting_review');
  f.writes.length = 0;
  await f.review(job, 1);
  const reviewed = f.calls.reviewed.at(-1);
  assert.equal(reviewed.proposal.proposalId, sibling.proposalId);
  assert.deepEqual(reviewed.proposal.lineage.rootIds, parent.lineage.rootIds);
  assert.deepEqual(reviewed.proposal.lineage.derivedFrom, [parent.proposalId]);
  assert.equal(reviewed.proposal.lineage.independentEvents, 'unknown');
  assert.ok(!reviewed.proposal.lineage.rootIds.includes(memoryRoot), 'Applied sibling output is not fresh independent memory evidence');
  assert.deepEqual(reviewed.snapshot.candidates, { items: [], total: 0, truncated: false }, 'Only candidate presentation excludes the current job');
  const completed = await f.settle(job);
  assert.equal(completed.state, 'completed');
  assert.deepEqual(completed.proposals[1].lineage, reviewed.proposal.lineage);
  assert.deepEqual(completed.reviews.at(-1).proposalSnapshot.lineage, reviewed.proposal.lineage);
  assert.deepEqual(completed.appliedProposalIds, [parent.proposalId]);
  assert.deepEqual(f.memoryWrites(), []);
  assert.equal((await f.memory()).content, expected);
  assert.equal((await f.store.listTransactions()).length, 1);
  assert.equal(f.calls.compact, 1);
  assert.equal(f.calls.notify.length, 1, 'The retain review does not generate another change report');
});

test('a scripted fact retain can cite only its exact current memory without inventing daily evidence', async t => {
  const f = await fixture(t, { generate(snapshot, jobId) {
    return [proposal(jobId, 'fact-retain', { kind: 'fact', evidence: [{ sourceId: 'long-term.md', quote: kept }] })];
  } });
  const job = await f.engine.dream();
  assert.deepEqual(job.proposals[0].evidence, [{ sourceId: 'long-term.md', quote: kept }]);
  await f.review(job);
  assert.equal((await f.settle(job)).state, 'reviewed_no_changes');
  await assertNoMemoryChanges(f);
});

test('final report uses only committed before/after diff, never generator summaries or uncommitted proposals', async t => {
  const before = 'previous=synthetic-alpha';
  const after = 'current=synthetic-beta!';
  const original = `${initialMemory}${before}\n`;
  const expected = `${initialMemory}${after}\n`;
  const f = await fixture(t, { memory: original, generate(snapshot, jobId) {
    return [proposal(jobId, 'report-committed', { operation: 'replace', before, after,
      consolidation: { action: 'correct', claimKey: 'synthetic-report-correction', applicability, basis: 'correction' },
    }), ...['- REJECTED_AFTER_SENTINEL\n', '- DEFERRED_AFTER_SENTINEL\n'].map((after, index) => proposal(jobId, `report-${index}`, {
      operation: 'append', before: '', after,
      consolidation: { action: 'add', claimKey: `synthetic-report-${index}`, applicability, basis: 'explicit' },
    })), proposal(jobId, 'keep')];
  } });
  const job = await f.engine.dream();
  await f.review(job);
  await f.review(job, 1, 'reject');
  await f.review(job, 2, 'defer');
  await f.review(job, 3);
  const applied = await f.settle(job);
  assert.equal(applied.state, 'awaiting_reload');
  assert.deepEqual(applied.transaction.proposalIds, [job.proposals[0].proposalId]);
  assert.equal(applied.transaction.changes[0].before, original);
  assert.equal(applied.transaction.changes[0].after, expected);
  assert.equal(f.calls.notify.length, 0, 'No final report before actual reload acknowledgement');
  await f.acknowledge(job);
  assert.equal(f.calls.notify.length, 1);
  const report = f.calls.notify[0];
  assert.equal(report.transactionId, applied.transaction.transactionId);
  assert.ok(report.text.includes(JSON.stringify([{ targetId: 'long-term.md', before, after }])));
  for (const sentinel of ['GENERATOR_TEXT_SENTINEL', 'GENERATOR_REASON_SENTINEL', 'DREAM_SUMMARY_SENTINEL',
    'REJECTED_AFTER_SENTINEL', 'DEFERRED_AFTER_SENTINEL', 'UNCHANGED_MEMORY_SENTINEL']) assert.ok(!report.text.includes(sentinel), sentinel);
  const completedBatch = await f.store.loadJob(job.jobId);
  assert.equal(completedBatch.state, 'awaiting_review', 'The deferred sibling remains pending, not silently accepted');
  assert.equal(completedBatch.reportDelivery.state, 'sent');
  assert.equal((await f.memory()).content, expected);
  assert.equal(f.memoryWrites().length, 1);
});
