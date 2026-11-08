// Read-only, explicit fictional integration root; never reads real memory/profile/session DB.
import assert from 'node:assert/strict';
import {readFile,readdir}from'node:fs/promises';
import {join,resolve}from'node:path';
import {pathToFileURL}from'node:url';
import {createHash}from'node:crypto';
const root=resolve(process.argv[2]??'');const stage=process.argv[3]??'completed';
assert.ok(root.startsWith(resolve(import.meta.dirname,'../tests/.tmp/original-recall-live-')));
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const list=async p=>{try{return await readdir(p);}catch(e){if(e.code==='ENOENT')return[];throw e;}};
const meta=await json(join(root,'provenance.json'));const baseline=await json(join(root,'baseline.json'));
let retry;try{retry=await json(join(root,'retry-provenance.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
const artifact=retry?.artifact??meta.artifact;
const {buildCleanReviewPayload}=await import(pathToFileURL(join(artifact,'dist/review/isolation.js')));
const {proposalLineage}=await import(pathToFileURL(join(artifact,'dist/dream/lineage.js')));
const jobs=await Promise.all((await list(join(root,'state/jobs'))).filter(n=>n.endsWith('.json')).map(n=>json(join(root,'state/jobs',n))));jobs.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));assert.ok(jobs.length);
const transactions=await Promise.all((await list(join(root,'state/transactions'))).map(n=>json(join(root,'state/transactions',n,'manifest.json'))));
const phases=await Promise.all((await list(root)).filter(n=>/^phase-\d+\.json$/.test(n)).map(n=>json(join(root,n))));phases.sort((a,b)=>a.phase-b.phase);
const expected=structuredClone(baseline);
// Fixture phases only append to a readonly daily source. They cannot modify any target.
for(const p of phases){assert.equal(p.synthetic,true);expected[`daily/${meta.fixture.today}.md`]+='\n'+p.text+'\n';}
for(const tx of transactions.filter(t=>t.status==='applied').sort((a,b)=>a.appliedAt.localeCompare(b.appliedAt))){
 const j=jobs.find(j=>j.jobId===tx.jobId);assert.ok(j);
 for(const id of tx.changeSet.proposalIds){const p=j.proposals.find(p=>p.proposalId===id);assert.ok(p);assert.notEqual(p.operation,'retain');
 const review=j.reviews.find(r=>r.proposalId===id&&tx.changeSet.reviewIds.includes(r.reviewId));assert.equal(review.decision,'accept');assert.equal(review.authority.kind,'clean-model');assert.equal(review.authority.policyVersion,3);}
 for(const c of tx.changeSet.changes){assert.ok(Object.hasOwn(expected,c.targetId));assert.equal(expected[c.targetId],c.before);expected[c.targetId]=c.after;}
}
for(const [p,text]of Object.entries(expected))assert.equal(await readFile(join(root,'memory',p),'utf8'),text,p);
assert.equal(expected['AGENTS.md'],baseline['AGENTS.md']);assert.equal(expected['long-term.md'].split(meta.fixture.preference).length-1,1);
const inventory=(await readdir(join(root,'memory'),{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(join(root,'memory').length+1));
const lock=/^\.dsh-dream-(?:generation-)?locks\/\d{12}\.(?:acquire|released)\.json$/;
assert.deepEqual(inventory.filter(p=>!lock.test(p)).sort(),Object.keys(baseline).sort());
if(stage==='completed')for(const p of inventory.filter(p=>lock.test(p)&&p.endsWith('.acquire.json'))){const a=await json(join(root,'memory',p));const r=await json(join(root,'memory',p.replace('.acquire.json','.released.json')));assert.equal(a.ownerToken,r.ownerToken);}
const audits=await Promise.all((await list(join(root,'audit'))).filter(n=>n.endsWith('.json')).map(n=>json(join(root,'audit',n))));
const clean=audits.filter(a=>a.messages[0].content[0].text.startsWith('Clean memory review policy'));const generation=audits.filter(a=>!clean.includes(a));
assert.equal(new Set(audits.map(a=>a.sessionId)).size,audits.length);
for(const a of audits){assert.notEqual(a.sessionId,meta.sessionId);assert.notEqual(a.sessionId,meta.sourceSessionId);assert.equal(a.messages.length,1);assert.equal(a.messages[0].role,'user');assert.equal(a.requestKeys.some(k=>['system','tools','toolHistory','replayState','previousResponseId'].includes(k)),false);}
const originals=new Map();
for(const j of jobs){
 assert.equal(j.scope.sessionId,meta.sessionId);assert.equal(j.scope.memoryRootId,join(root,'memory'));assert.equal(new Set(j.appliedProposalIds).size,j.appliedProposalIds.length);
 if(stage==='completed')assert.ok(['completed','reviewed_no_changes'].includes(j.state),j.state);
 for(const s of j.snapshot.sources)for(const r of s.originals??[]){assert.equal(r.status,'verified');assert.equal(r.ref.sessionId,meta.sourceSessionId);assert.equal(r.canonical.sessionId,r.ref.sessionId);assert.equal(r.canonical.seq,r.ref.seq);assert.equal(r.canonical.role,'user');assert.equal(r.canonical.sourceKind,'user');assert.equal(r.independentEvents,'unknown');assert.ok(s.content.includes(r.ref.quote));const id=`${r.ref.sessionId}:${r.ref.seq}`;const old=originals.get(id);if(old)assert.equal(old,r.canonical.eventHash);else originals.set(id,r.canonical.eventHash);}
 for(const p of j.proposals){assert.ok(p.consolidation);assert.equal(p.lineage.independentEvents,'unknown');if(p.operation==='retain')assert.equal(j.appliedProposalIds.includes(p.proposalId),false);}
 for(const r of j.reviews.filter(r=>r.authority)){
  assert.equal(r.authority.policyVersion,3);const a=clean.find(a=>a.sessionId===r.authority.callId);assert.ok(a);const text=a.messages[0].content[0].text.split('\nUNTRUSTED_REVIEW_INPUT_JSON\n')[1];assert.ok(text);
  assert.equal(createHash('sha256').update(text).digest('hex'),r.authority.inputDigest);const snap={...r.basis};assert.deepEqual(JSON.parse(text),buildCleanReviewPayload(snap,r.proposalSnapshot,r.authority.policyVersion));assert.deepEqual(r.proposalSnapshot.lineage,proposalLineage(r.proposalSnapshot,snap));assert.equal(a.provider,r.authority.provider);assert.equal(a.model,r.authority.model);
 }
 const results=await list(join(root,'state/dreams/results'));if(results.includes(`${j.jobId}.json`)){const result=await json(join(root,'state/dreams/results',`${j.jobId}.json`));for(const a of generation.filter(a=>a.messages[0].content[0].text.includes('\nDEEP：'))){const t=a.messages[0].content[0].text;assert.equal(t.includes(result.result.dream),false);assert.equal(t.includes('已核对原文引用的观察：'),false);assert.equal(t.includes('\n观察：'),false);}}
 if(stage==='completed'&&j.appliedProposalIds.length){assert.ok(j.reload.acknowledgedAt);assert.equal(j.reload.transactionId,j.transaction.transactionId);assert.equal(j.reportDelivery.state,'sent');if(j.compactionChoice.decision==='skip'){assert.equal(j.compaction.status,'skipped');assert.equal(j.compactionAttempts,0);}}
 if(stage==='completed'&&!j.appliedProposalIds.length){assert.equal(transactions.some(t=>t.jobId===j.jobId),false);assert.equal(j.reportDelivery,undefined);}
}
const files=(await readdir(join(root,'bundle/dist'),{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(join(root,'bundle/dist').length+1));for(const f of files)assert.deepEqual(await readFile(join(root,'bundle/dist',f)),await readFile(join(meta.artifact,'dist',f)));
assert.equal(createHash('sha1').update(await readFile(meta.archive)).digest('hex'),meta.shasum);
if(retry){for(const f of files)assert.deepEqual(await readFile(join(retry.bundle,'dist',f)),await readFile(join(retry.artifact,'dist',f)));assert.equal(createHash('sha1').update(await readFile(retry.archive)).digest('hex'),retry.shasum);}
console.log(JSON.stringify({root,stage,jobs:jobs.map(j=>({jobId:j.jobId,state:j.state,applied:j.appliedProposalIds,proposals:j.proposals.map(p=>({proposalId:p.proposalId,action:p.consolidation.action,operation:p.operation,decision:j.reviews.findLast(r=>r.proposalId===p.proposalId)?.decision,candidateId:p.consolidation.candidateId})),compaction:j.compaction,acknowledgedAt:j.reload?.acknowledgedAt,report:j.reportDelivery?.state})),phases:phases.map(p=>p.phase),transactions:transactions.length,generationCalls:generation.length,cleanCalls:clean.length,distinctOriginalRecordIds:originals.size,independentEvents:'unknown',exactMemoryChanges:true,preferenceOccurrences:1,personaUnchanged:true,artifactIdentical:true},null,2));
