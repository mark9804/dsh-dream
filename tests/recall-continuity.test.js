import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProposal, validateJob } from '../dist/domain/contracts.js';
import { recordReview } from '../dist/review/index.js';
import { reviewPolicyVersion, cleanReviewDigest } from '../dist/review/isolation.js';
import { recallRelations } from '../dist/dream/recall-relations.js';
import { recallMemory } from '../dist/dream/recall.js';
const scope = { scopeId: 'multi-night', agentId: 'multi-night', sessionId: 'multi-night', memoryRootId: '/synthetic/memory' };
const stamp = day => `2026-11-${String(day).padStart(2,'0')}T05:30:00+09:00`;
const applicability = { topic: 'amber pot', conditions: 'only this pot' };
const source = (id, content, writable = false, version = 1) => ({ sourceId: id, path: id, role: writable ? 'longTerm' : 'daily', content, writable, version: { revision: version }, sensitivity: 'private', protectedText: [] });
const claim = '- Synthetic amber pot origin: gift from Cousin, not a market purchase.\n';
const before = '- Synthetic amber pot origin: market purchase.\n';
const events = '\n## Separate events\n\n- November 1 Lin counted lamps and felt calm.\n- November 3 Lin counted lamps and felt worried.\n';
const diary = 'Synthetic direct correction: This amber pot was a gift from Cousin, not bought at a market.\n';
function start() { return { schemaVersion: 1, snapshotId: 'first', capturedAt: stamp(5), scope: structuredClone(scope), sources: [source('long-term.md', '# Synthetic facts\n\n'+before+events, true), source('daily/2026-11-05.md', diary)] }; }
function committed(snapshot, edits, { day = 5, jobId = 'job-'+day, strict = true } = {}) {
  const proposals = edits.map((edit, i) => ({ schemaVersion: 1, proposalId: `${jobId}-p${i}`, jobId, kind: 'fact', text: 'UNTRUSTED prose', reason: 'synthetic', targetId: 'long-term.md', operation: edit.operation ?? 'replace', before: edit.before ?? '', after: edit.after,
    evidence: edit.evidence ?? [{ sourceId: 'long-term.md', quote: edit.before && snapshot.sources[0].content.includes(edit.before) ? edit.before : snapshot.sources[0].content }, { sourceId: 'daily/2026-11-05.md', quote: diary }],
    consolidation: { action: edit.action ?? (edit.operation === 'append' ? 'add' : 'correct'), claimKey: edit.key ?? `new-${day}-${i}`, applicability: edit.applicability ?? applicability, basis: 'correction' } }));
  let job = { schemaVersion: 1, jobId, scope: structuredClone(scope), snapshot: structuredClone(snapshot), state: 'awaiting_review', proposals, reviews: [], appliedProposalIds: [], createdAt: stamp(day), updatedAt: stamp(day) };
  for (const p of proposals) job = recordReview(job, { jobId, proposalId: p.proposalId, decision: 'accept', reason: 'Synthetic exact independent review.' }, { agentId: scope.agentId, sessionId: scope.sessionId }, { reviewId: p.proposalId+'-review', now: stamp(day), authority: { kind: 'clean-model', callId: p.proposalId+'-call', provider: 'synthetic', model: 'synthetic', policyVersion: reviewPolicyVersion(snapshot,p), inputDigest: cleanReviewDigest(snapshot,p) } });
  const current = structuredClone(snapshot), target = current.sources.find(s => s.sourceId === 'long-term.md'), old = target.content;
  for (const p of proposals) target.content = applyProposal(target.content,p);
  target.version = { revision: day+100 }; current.snapshotId = `after-${day}`;
  const transaction = { schemaVersion: 1, transactionId: jobId+'-tx', jobId, status: 'applied', proposalIds: proposals.map(p=>p.proposalId), reviewIds: job.reviews.map(r=>r.reviewId), changes: [{ targetId: 'long-term.md', before: old, after: target.content, version: structuredClone(snapshot.sources[0].version) }] };
  const reload = { transactionId: transaction.transactionId, status: 'ready', acknowledgedAt: stamp(day), sources: current.sources.map(s=>({sourceId:s.sourceId,path:'/synthetic/memory/'+s.path,content:s.content,version:structuredClone(s.version)})) };
  const writtenSources = reload.sources.filter(s=>s.sourceId==='long-term.md');
  Object.assign(job,{state:'completed',appliedProposalIds:proposals.map(p=>p.proposalId),appliedTransactionIds:[transaction.transactionId],transaction,reload,
    ...(strict?{transactionWriteReceipt:{transactionId:transaction.transactionId,sources:structuredClone(writtenSources)}}:{}),
    transactionHistory:[{schemaVersion:1,transaction:structuredClone(transaction),reload:structuredClone(reload),...(strict?{writtenSources:structuredClone(writtenSources)}:{})}]});
  validateJob(job);return {job,current};
}
function first(options) { return committed(start(),[{action:'correct',key:'pot-origin',before,after:claim}],options); }
const get=(snapshot,jobs)=>recallRelations(snapshot,jobs,new Date(stamp(12)));

test('an acknowledged correction survives a later unrelated approved append without renewing old approval',()=>{
  const a=first(), b=committed(a.current,[{operation:'append',after:'\n- Synthetic unrelated: Elm notebook is blue.\n'}],{day:6});
  const r=get(b.current,[a.job,b.job]);assert.equal(r.relations.length,1);const rel=r.relations[0];assert.equal(rel.after.text,claim);assert.deepEqual(rel.continuity.continuedThrough,[b.job.transaction.transactionId]);assert.equal(rel.reviewId,a.job.reviews[0].reviewId);
  assert.equal(b.current.sources[0].content.slice(rel.after.proof.start,rel.after.proof.end),claim);assert.ok(b.current.sources[0].content.includes(events));
});

test('a prior replacement shifts the exact endpoint while leaving its raw quote and scope unchanged',()=>{
  const a=first(), b=committed(a.current,[{before:'# Synthetic facts',after:'# Synthetic ordinary facts collection'}],{day:6});
  // Heading is a protected semantic context, not an unrelated edit; do not carry.
  assert.ok(get(b.current,[a.job,b.job]).relations.every(rel=>rel.jobId!==a.job.jobId));
  const initial=start();initial.sources[0].content='Synthetic unrelated preface.\n\n'+initial.sources[0].content;
  const c=committed(initial,[{action:'correct',key:'pot-origin',before,after:claim}]);
  const d=committed(c.current,[{before:'Synthetic unrelated preface.',after:'Synthetic unrelated expanded preface kept separately.'}],{day:6});
  const r=get(d.current,[c.job,d.job]);const continued=r.relations.find(rel=>rel.jobId===c.job.jobId);assert.ok(continued);assert.ok(continued.after.proof.start>get(c.current,[c.job]).relations[0].after.proof.start);
});

test('touch then restore, adjacent negation and title reversal break continuity even if final claim bytes survive',()=>{
  const a0=first(),a1=committed(a0.current,[{before:claim,after:'- Synthetic temporary claim.\n'}],{day:6}),a2=committed(a1.current,[{before:'- Synthetic temporary claim.\n',after:claim}],{day:7});
  assert.ok(get(a2.current,[a0.job,a1.job,a2.job]).relations.every(rel=>rel.jobId!==a0.job.jobId));
  for(const edits of[
    [{before:claim,after:'NOT CURRENT: '+claim}],
    [{before:'# Synthetic facts',after:'# Withdrawn counterexamples'}],
  ]){const a=first(),b=committed(a.current,edits,{day:6});assert.ok(get(b.current,[a.job,b.job]).relations.every(rel=>rel.jobId!==a.job.jobId));}
});

test('external rewrites and same bytes with a new opaque version cannot be bridged by later clean unrelated work',()=>{
  const a=first();const edited=structuredClone(a.current);edited.sources[0].version={revision:999};const b=committed(edited,[{operation:'append',after:'\n- unrelated approved text\n'}],{day:6});
  assert.equal(get(b.current,[a.job,b.job]).relations.length,0);
  assert.equal(get(edited,[a.job]).relations.length,0);
});

test('missing write version receipts and ACK-before-external-same-byte versions are never continuity edges',()=>{
  const a=first({strict:false}),b=committed(a.current,[{operation:'append',after:'\n- new line\n'}],{day:6});assert.equal(get(b.current,[a.job,b.job]).relations.length,0);
  const c=first(),d=committed(c.current,[{operation:'append',after:'\n- new line\n'}],{day:6});d.job.transactionHistory[0].writtenSources[0].version={revision:999};
  assert.equal(get(d.current,[c.job,d.job]).relations.length,0);
});

test('genuine later keep preserves a relation but cannot resurrect it after an intervening same-scope veto',()=>{
  const a=first();const b=committed(a.current,[{operation:'append',after:'\n- unrelated entry\n'}],{day:6});
  const p={...structuredClone(a.job.proposals[0]),jobId:'keep-job',proposalId:'keep',operation:'retain',before:claim,after:claim,consolidation:{...a.job.proposals[0].consolidation,action:'keep'}};
  p.evidence=[{sourceId:'long-term.md',quote:claim}];let keep={schemaVersion:1,jobId:'keep-job',scope:structuredClone(scope),snapshot:structuredClone(b.current),state:'awaiting_review',proposals:[p],reviews:[],appliedProposalIds:[],createdAt:stamp(7),updatedAt:stamp(7)};
  keep=recordReview(keep,{jobId:keep.jobId,proposalId:p.proposalId,decision:'accept',reason:'Synthetic keep.'},{agentId:scope.agentId,sessionId:scope.sessionId},{reviewId:'keep-review',now:stamp(7),authority:{kind:'clean-model',callId:'keep-call',provider:'synthetic',model:'synthetic',policyVersion:reviewPolicyVersion(b.current,p),inputDigest:cleanReviewDigest(b.current,p)}});
  assert.equal(get(b.current,[a.job,b.job,keep]).relations.length,1);
  let veto=structuredClone(keep);veto.jobId='veto';veto.proposals[0].jobId='veto';veto.reviews=[];veto=recordReview(veto,{jobId:'veto',proposalId:'keep',decision:'reject',reason:'New uncertainty.'},{agentId:scope.agentId,sessionId:scope.sessionId},{reviewId:'veto-review',now:stamp(6)});
  assert.equal(get(b.current,[a.job,b.job,veto,keep]).relations.length,0);
});

test('a newer scoped correction replaces the old relation without preserving old current truth',()=>{
  const a=first(),newClaim='- Synthetic amber pot origin: gift from Aunt; Cousin account withdrawn.\n';
  const newerDiary=source('daily/2026-11-07.md','Synthetic correction: gift from Aunt, not Cousin.\n');const next=structuredClone(a.current);next.sources.push(newerDiary);
  const b=committed(next,[{action:'correct',key:'pot-origin',before:claim,after:newClaim,evidence:[{sourceId:'long-term.md',quote:claim},{sourceId:newerDiary.sourceId,quote:newerDiary.content}]}],{day:7});
  const r=get(b.current,[a.job,b.job]);assert.equal(r.relations.length,1);assert.equal(r.relations[0].after.text,newClaim);assert.equal(r.relations[0].proposalId,b.job.proposals[0].proposalId);
});

test('an inserted new heading before the untouched endpoint changes scope and cannot transport the old link',()=>{
  const initial=start();initial.sources[0].content=initial.sources[0].content.replace(before,'Synthetic separate intro.\n\n'+before);
  const a=committed(initial,[{action:'correct',key:'pot-origin',before,after:claim}]);
  const b=committed(a.current,[{before:'Synthetic separate intro.',after:'# Fictional counterexamples\n\nSynthetic separate intro.'}],{day:6});
  assert.ok(get(b.current,[a.job,b.job]).relations.every(rel=>rel.jobId!==a.job.jobId));
});

test('an acknowledged non-strict successor is a blocking gap, not permission to revive its predecessor',()=>{
  const a=first(),b=committed(a.current,[{before:claim,after:'- Synthetic changed origin.\n'}],{day:6,strict:false});
  assert.ok(get(a.current,[a.job,b.job]).relations.every(rel=>rel.jobId!==a.job.jobId),'rollback to earlier after-image cannot ignore a known successor');
});

test('a clock-reversed matching successor blocks rather than disappearing from the chain',()=>{
  const a=first(),b=committed(a.current,[{operation:'append',after:'\n- Synthetic later unrelated line.\n'}],{day:4});
  assert.ok(get(a.current,[a.job,b.job]).relations.every(rel=>rel.jobId!==a.job.jobId));
});

test('a target-source extra evidence quote keeps its own heading and paragraph context protected',()=>{
  const initial=start();initial.sources[0].content+='\n## Corroboration\n\nSynthetic family receipt confirms this exact pot.\n';
  const a=committed(initial,[{action:'correct',key:'pot-origin',before,after:claim,evidence:[{sourceId:'long-term.md',quote:before},{sourceId:'long-term.md',quote:'Synthetic family receipt confirms this exact pot.'},{sourceId:'daily/2026-11-05.md',quote:diary}]}]);
  const b=committed(a.current,[{before:'## Corroboration',after:'## Withdrawn counterexamples'}],{day:6});
  assert.ok(get(b.current,[a.job,b.job]).relations.every(rel=>rel.jobId!==a.job.jobId));
});

test('duplicated identical stored history is deduplicated without suppressing or stacking a relation',()=>{
  const a=first(),b=committed(a.current,[{operation:'append',after:'\n- Synthetic unrelated.\n'}],{day:6});
  const r=get(b.current,[a.job,structuredClone(a.job),b.job,structuredClone(b.job)]);assert.equal(r.relations.length,1);assert.deepEqual(r.relations[0].continuity.continuedThrough,[b.job.transaction.transactionId]);
});

test('Setext and indented ATX title changes cannot be treated as unrelated edits',()=>{
  for(const heading of['Synthetic facts\n===============','   # Synthetic facts']){
    const initial=start();initial.sources[0].content=initial.sources[0].content.replace('# Synthetic facts',heading);
    const a=committed(initial,[{action:'correct',key:'pot-origin',before,after:claim}]);
    const b=committed(a.current,[{before:heading,after:heading.replace('Synthetic facts','Withdrawn fictional counterexamples')}],{day:6});
    assert.ok(get(b.current,[a.job,b.job]).relations.every(rel=>rel.jobId!==a.job.jobId));
  }
});

test('case and whitespace equivalent applicability cannot evade a later scoped veto',()=>{
  const a=first();const p={...structuredClone(a.job.proposals[0]),jobId:'veto-normalized',proposalId:'veto',consolidation:{...a.job.proposals[0].consolidation,applicability:{topic:' AMBER  POT ',conditions:'ONLY  THIS POT'}}};
  let job={schemaVersion:1,jobId:p.jobId,scope:structuredClone(scope),snapshot:structuredClone(a.current),state:'awaiting_review',proposals:[p],reviews:[],appliedProposalIds:[],createdAt:stamp(6),updatedAt:stamp(6)};
  job=recordReview(job,{jobId:job.jobId,proposalId:p.proposalId,decision:'reject',reason:'Synthetic normalized scope veto.'},{agentId:scope.agentId,sessionId:scope.sessionId},{reviewId:'veto-normalized-review',now:stamp(6)});
  assert.equal(get(a.current,[a.job,job]).relations.length,0);
});

test('a final paragraph with trailing newline survives a separate appended paragraph',()=>{
  const initial=start();initial.sources[0].content='# Synthetic facts\n\n'+before;
  const a=committed(initial,[{action:'correct',key:'pot-origin',before,after:claim}]);
  const b=committed(a.current,[{operation:'append',after:'\n- Synthetic unrelated blue notebook.\n'}],{day:6});
  assert.ok(get(b.current,[a.job,b.job]).relations.some(rel=>rel.jobId===a.job.jobId));
});

test('an earlier sibling context reversal cannot change what a later correction was reviewed under',()=>{
  const a=committed(start(),[{before:'# Synthetic facts',after:'# Withdrawn fictional counterexamples'},{action:'correct',key:'pot-origin',before,after:claim}]);
  assert.ok(get(a.current,[a.job]).relations.every(rel=>rel.proposalId!==a.job.proposals[1].proposalId));
});

test('earlier same-batch siblings cannot reverse the context of extra target evidence before its anchor is created',()=>{
  const initial=start();initial.sources[0].content+='\n## Corroboration\n\nSynthetic receipt confirms this pot.\n';
  const a=committed(initial,[{before:'## Corroboration',after:'## Withdrawn counterexamples'},{action:'correct',key:'pot-origin',before,after:claim,evidence:[{sourceId:'long-term.md',quote:before},{sourceId:'long-term.md',quote:'Synthetic receipt confirms this pot.'},{sourceId:'daily/2026-11-05.md',quote:diary}]}]);
  assert.ok(get(a.current,[a.job]).relations.every(rel=>rel.proposalId!==a.job.proposals[1].proposalId));
});

test('query after a week uses continued relation while repeated old copies still occupy one display position',()=>{
  const a=first(),b=committed(a.current,[{operation:'append',after:'\n- Synthetic unrelated blue notebook.\n'}],{day:6});b.current.sources.push(source('daily/old-copies.md',Array(20).fill('Synthetic amber pot origin: market purchase.').join('\n\n')));
  const r=recallMemory(b.current,[a.job,b.job],[],{query:'amber pot market',...applicability,limit:3},{now:new Date(stamp(12)),boost:0});assert.equal(r.hits[0].consolidation.role,'current-after-image');assert.equal(r.relations[0].continuity.continuedThrough.length,1);assert.ok(r.hits.some(h=>h.group?.memberCount===20));assert.ok(r.hits.every(h=>h.reinforcementBoost===0));
});
