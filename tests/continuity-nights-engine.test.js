import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEngine } from '../dist/engine.js';
import { validateConfig } from '../dist/config.js';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { createStore } from '../dist/storage/index.js';
import { recordReview } from '../dist/review/index.js';
import { localDate } from '../dist/scheduler/window.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

// Synthetic generation and review authority, real confined storage/engine/ACK.
// This test is independent of the real Host/model multi-night experiment.
test('three real engine nights preserve reviewed continuity, replace only the corrected claim and never rewrite raw episodes', async t => {
  const generated = fileURLToPath(new URL('./.tmp/', import.meta.url));
  await mkdir(generated, { recursive: true });
  const root = await mkdtemp(join(generated, 'continuity-three-nights-'));
  const writes = [], engines = [], generationCalls = [];
  let clock = new Date('2026-11-05T05:30:00+09:00');
  let nextId = 0;
  const tripScope = { topic: 'synthetic trip', conditions: 'only synthetic trips' };
  const potScope = { topic: 'synthetic amber pot', conditions: 'only this synthetic amber pot' };
  const beforeTrip = '- Synthetic trip: changes are fine; no delegated extra meetings.\n- Synthetic trip: flexible plans, never accept extra meetings for me.\n';
  const afterTrip = '- Synthetic trip only: changes are fine; no delegated extra meetings.\n';
  const beforePot = '- Synthetic amber pot origin: market purchase.\n';
  const afterPot = '- Synthetic amber pot origin: gift from Cousin, not a market purchase.\n';
  const correctedPot = '- Synthetic amber pot origin: gift from Aunt; Cousin account was mistaken, not a market purchase.\n';
  const separateEvents = '- 2026-11-03 Synthetic lamp counting: Lin felt calm.\n- 2026-11-04 Synthetic lamp counting: Lin felt worried.\n';
  const firstDiary = 'Synthetic direct request: Those two trip statements express the same boundary; keep changes allowed and no delegated extra meetings, only on trips.\n\nSynthetic direct correction: The amber pot was a gift from Cousin, not a market purchase.\n';
  const secondDiary = 'Synthetic recorded event: The separate Elm notebook has a blue cover.\n';
  const thirdDiary = 'Synthetic direct correction: The amber pot was a gift from Aunt, not Cousin; the previous Cousin account was mistaken.\n';
  const appended = '\n- Synthetic unrelated notebook: the Elm notebook has a blue cover.\n';
  const initial = '# Synthetic retained memories\n\n' + beforeTrip + '\n' + beforePot + '\n## Separate shared episodes\n\n' + separateEvents;
  const config = validateConfig({
    sessionId: 'synthetic-three-nights', memoryRoot: join(root, 'memory'), stateRoot: join(root, 'state'),
    timeZone: 'Asia/Tokyo', dreamMode: 'off', compactionMode: 'agent', reinforcementBoost: 0,
  });
  const scope = { scopeId: config.sessionId, agentId: config.sessionId, sessionId: config.sessionId, memoryRootId: config.memoryRoot };
  const actor = { agentId: config.sessionId, sessionId: config.sessionId };
  const memoryPath = join(config.memoryRoot, 'long-term.md');
  function newFiles() {
    const local = createLocalFiles(root);
    const localPath = path => isAbsolute(path) ? relative(root, path) : path;
    return {
      ...local,
      read: (path, options) => local.read(localPath(path), options),
      stat: path => local.stat(localPath(path)),
      list: path => local.list(localPath(path)),
      mkdir: path => local.mkdir(localPath(path)),
      async write(path, content, version) {
        const next = await local.write(localPath(path), content, version);
        writes.push(localPath(path)); return next;
      },
    };
  }
  const files = newFiles();
  for (const directory of ['daily', 'ideas']) await files.mkdir(join(config.memoryRoot, directory));
  const originalDiaries = new Map([
    ['daily/2026-11-03.md', 'Synthetic independent episode on 2026-11-03: Lin counted lamps and felt calm.\n'],
    ['daily/2026-11-04.md', 'Synthetic independent episode on 2026-11-04: Lin counted lamps and felt worried.\n'],
    ['daily/2026-11-05.md', firstDiary],
  ]);
  for (const [path, content] of [['long-term.md', initial], ['decisions.md', '# Synthetic decisions\n'], ['journal.md', '# Synthetic source index\n'], ...originalDiaries]) {
    await files.write(join(config.memoryRoot, path), content, null);
  }
  const originalDiaryFiles = new Map(await Promise.all([...originalDiaries.keys()].map(async path => [path, await files.read(join(config.memoryRoot, path))])));
  const host = {
    async waitForIdle() {}, async maintain(work) { return work(new AbortController().signal); },
    async compact() { assert.fail('The fixture explicitly skips compaction'); },
    async requestReview() {}, async requestReload() {}, async notify() {},
  };
  const generate = async (snapshot, jobId) => {
    const night = localDate(clock, config.timeZone);
    generationCalls.push({ night, jobId });
    const base = { schemaVersion: 1, jobId, reason: 'Synthetic scripted original-source proposal.', targetId: 'long-term.md' };
    let proposals;
    if (night === '2026-11-05') {
      proposals = [
        { ...base, proposalId: `${jobId}-trip`, kind: 'preference', text: 'Merge equivalent trip boundary.', operation: 'replace', before: beforeTrip, after: afterTrip,
          evidence: [{ sourceId: 'long-term.md', quote: beforeTrip }, { sourceId: 'daily/2026-11-05.md', quote: firstDiary.split('\n\n')[0] }],
          consolidation: { action: 'merge', claimKey: 'trip-boundary', applicability: tripScope, basis: 'explicit' } },
        { ...base, proposalId: `${jobId}-pot`, kind: 'fact', text: 'Correct the amber pot origin.', operation: 'replace', before: beforePot, after: afterPot,
          evidence: [{ sourceId: 'long-term.md', quote: beforePot }, { sourceId: 'daily/2026-11-05.md', quote: firstDiary.split('\n\n')[1].trim() }],
          consolidation: { action: 'correct', claimKey: 'amber-pot-origin', applicability: potScope, basis: 'correction' } },
      ];
    } else if (night === '2026-11-06') {
      proposals = [{ ...base, proposalId: `${jobId}-notebook`, kind: 'fact', text: 'Keep the separate notebook detail.', operation: 'append', before: '', after: appended,
        evidence: [{ sourceId: 'daily/2026-11-06.md', quote: secondDiary.trim() }],
        consolidation: { action: 'add', claimKey: 'elm-notebook-cover', applicability: { topic: 'synthetic notebook', conditions: 'only the Elm notebook' }, basis: 'observation' } }];
    } else if (night === '2026-11-07') {
      const existing = snapshot.candidates.items.find(candidate => candidate.claimKey === 'amber-pot-origin');
      assert.ok(existing, 'Third night must identify the existing scoped pot candidate');
      assert.deepEqual(existing.applicability, potScope);
      proposals = [{ ...base, proposalId: `${jobId}-pot-new`, kind: 'fact', text: 'Correct the later pot account.', operation: 'replace', before: afterPot, after: correctedPot,
        evidence: [{ sourceId: 'long-term.md', quote: afterPot }, { sourceId: 'daily/2026-11-07.md', quote: thirdDiary.trim() }],
        consolidation: { action: 'correct', claimKey: 'amber-pot-origin', applicability: potScope, basis: 'correction', candidateId: existing.candidateId } }];
    } else assert.fail(`Unexpected generation night ${night}`);
    const sourceId = proposals[0].evidence.find(item => item.sourceId.startsWith('daily/')).sourceId;
    return { mode: 'memory-v2', proposals, digest: {
      schemaVersion: 1, snapshotId: snapshot.snapshotId,
      episodes: [{ episodeId: `${jobId}-event-1`, summary: 'Synthetic nightly source event.', when: 'Only the explicit date in the cited daily record', participants: [], status: 'reported', category: 'future-useful', importanceReason: 'Preserve the dated source for exact recall.', retention: 'recent', evidence: [proposals[0].evidence.find(item => item.sourceId === sourceId)] }],
      coverage: { sourceIds: [sourceId], omittedSourceIds: snapshot.sources.filter(source => source.sourceId !== sourceId).map(source => source.sourceId) },
    } };
  };
  function instance(targetFiles = files) {
    const store = createStore(targetFiles, { root: config.stateRoot, lockKey: config.memoryRoot, now: () => clock.toISOString() });
    const engine = createEngine({ config, scope, files: targetFiles, store, host, generate,
      now: () => new Date(clock), id: () => `synthetic-night-${String(++nextId).padStart(4, '0')}` });
    engines.push(engine); return { engine, store, files: targetFiles };
  }
  t.after(async () => { await Promise.all(engines.map(engine => engine.flush())); });
  let active = instance();
  async function runNight() {
    const job = await active.engine.dream();
    assert.equal(job.state, 'awaiting_review');
    for (const proposal of job.proposals) {
      await active.store.updateJob(job.jobId, current => recordReview(current,
        { jobId: job.jobId, proposalId: proposal.proposalId, decision: 'accept', reason: 'Synthetic independent review, not real model authority.' }, actor,
        { reviewId: `${proposal.proposalId}-review`, now: clock.toISOString(), authority: syntheticCleanAuthority(current.snapshot, proposal) }));
    }
    active.engine.submit({ jobId: job.jobId }); await active.engine.flush();
    let status = await active.engine.status({ jobId: job.jobId });
    assert.equal(status.state, 'awaiting_compaction', JSON.stringify(status.error));
    await active.engine.decideCompaction({ jobId: job.jobId, transactionId: status.compactionTransactionId, decision: 'skip', reason: 'Synthetic test reads actual post-commit files without compacting a Host.' }, { actor });
    await active.engine.flush(); status = await active.engine.status({ jobId: job.jobId });
    assert.equal(status.state, 'awaiting_reload');
    for (const source of status.reload.sources) assert.ok(await active.files.read(source.path));
    await active.engine.ackReload({ jobId: job.jobId, transactionId: status.reload.transactionId, readSourceIds: status.reload.sources.map(source => source.sourceId) }, { actor });
    await active.engine.flush();
    const completed = await active.store.loadJob(job.jobId);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.transactionHistory.length, 1);
    assert.ok(completed.transactionHistory[0].writtenSources.length > 0);
    assert.deepEqual(completed.appliedProposalIds, completed.proposals.map(proposal => proposal.proposalId));
    return completed;
  }
  async function query(topic, text) {
    const result = await active.engine.recall({ query: text, ...topic, limit: 8 });
    assert.ok(result.hits.every(hit => hit.reinforcementBoost === 0));
    return result;
  }
  async function assertRawUnchanged() {
    for (const [path, file] of originalDiaryFiles) assert.deepEqual(await active.files.read(join(config.memoryRoot, path)), file, `${path} must keep exact bytes and version`);
    assert.ok((await active.files.read(memoryPath)).content.includes(separateEvents));
  }

  const first = await runNight();
  const firstHistory = structuredClone(first.transactionHistory);
  const firstTrip = first.proposals.find(proposal => proposal.consolidation.claimKey === 'trip-boundary');
  const firstPot = first.proposals.find(proposal => proposal.consolidation.claimKey === 'amber-pot-origin');
  assert.equal((await files.read(memoryPath)).content, initial.replace(beforeTrip, afterTrip).replace(beforePot, afterPot));
  const firstPotRecall = await query(potScope, 'amber pot market');
  assert.ok(firstPotRecall.relations.some(relation => relation.proposalId === firstPot.proposalId));
  assert.equal(firstPotRecall.hits[0].sourceId, 'long-term.md');
  assert.equal(firstPotRecall.hits[0].consolidation.role, 'current-after-image');
  await assertRawUnchanged();

  clock = new Date('2026-11-06T05:30:00+09:00');
  await files.write(join(config.memoryRoot, 'daily/2026-11-06.md'), secondDiary, null);
  originalDiaryFiles.set('daily/2026-11-06.md', await files.read(join(config.memoryRoot, 'daily/2026-11-06.md')));
  const second = await runNight();
  for (const [scopeRequest, text, oldProposal] of [[tripScope, 'trip delegated meetings', firstTrip], [potScope, 'amber pot market', firstPot]]) {
    const recalled = await query(scopeRequest, text);
    const relation = recalled.relations.find(item => item.proposalId === oldProposal.proposalId);
    assert.ok(relation, JSON.stringify(recalled.coverage.relations));
    assert.deepEqual(relation.continuity.continuedThrough, [second.transaction.transactionId]);
    assert.equal(relation.reviewId, `${oldProposal.proposalId}-review`, 'Continuity never manufactures a renewed review');
  }
  const count = generationCalls.length, beforeRepeat = writes.length;
  const noNewMaterial = await active.engine.dream();
  assert.ok(noNewMaterial.reused || noNewMaterial.reason === 'no_new_material');
  assert.equal(generationCalls.length, count);
  assert.equal(writes.length, beforeRepeat, 'Same-material dreaming must not write state or memory');
  await assertRawUnchanged();

  // Fresh adapters and engine exercise persisted history rather than retained JS state.
  active = instance(newFiles());
  await active.engine.resume(); await active.engine.flush();
  const restarted = await query(potScope, 'amber pot market');
  assert.ok(restarted.relations.some(relation => relation.proposalId === firstPot.proposalId && relation.continuity.continuedThrough.includes(second.transaction.transactionId)));
  assert.equal(generationCalls.length, 2);

  clock = new Date('2026-11-07T05:30:00+09:00');
  await active.files.write(join(config.memoryRoot, 'daily/2026-11-07.md'), thirdDiary, null);
  originalDiaryFiles.set('daily/2026-11-07.md', await active.files.read(join(config.memoryRoot, 'daily/2026-11-07.md')));
  const third = await runNight();
  const potNow = await query(potScope, 'amber pot Cousin market');
  assert.ok(potNow.relations.some(relation => relation.proposalId === third.proposals[0].proposalId && relation.after.text === correctedPot));
  assert.equal(potNow.relations.some(relation => relation.proposalId === firstPot.proposalId), false, 'New correction supersedes the old same-candidate operation link');
  assert.equal(potNow.hits[0].consolidation.role, 'current-after-image');
  assert.match(potNow.hits[0].text, /gift from Aunt/);
  const tripNow = await query(tripScope, 'trip delegated meetings');
  const tripRelation = tripNow.relations.find(relation => relation.proposalId === firstTrip.proposalId);
  assert.ok(tripRelation, JSON.stringify(tripNow.coverage.relations));
  assert.deepEqual(tripRelation.continuity.continuedThrough, [second.transaction.transactionId, third.transaction.transactionId]);
  assert.equal((await active.files.read(memoryPath)).content, initial.replace(beforeTrip, afterTrip).replace(beforePot, correctedPot) + appended);
  assert.deepEqual((await active.store.loadJob(first.jobId)).transactionHistory, firstHistory);
  assert.equal(generationCalls.length, 3);
  assert.equal((await active.store.listTransactions()).length, 3);
  await assertRawUnchanged();

  active = instance(newFiles()); await active.engine.resume(); await active.engine.flush();
  const finalRecall = await query(tripScope, 'trip delegated meetings');
  assert.ok(finalRecall.relations.some(relation => relation.proposalId === firstTrip.proposalId && relation.continuity.continuedThrough.length === 2));
  const eventRecall = await active.engine.recall({ query: 'Lin counted lamps calm worried', topic: 'synthetic shared episodes', conditions: 'distinct dated episodes', limit: 8 });
  assert.ok(eventRecall.hits.some(hit => hit.sourceId === 'daily/2026-11-03.md' && hit.text.includes('calm')));
  assert.ok(eventRecall.hits.some(hit => hit.sourceId === 'daily/2026-11-04.md' && hit.text.includes('worried')));
  assert.equal(generationCalls.length, 3);
  await assertRawUnchanged();
});
