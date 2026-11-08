// Read-only verifier for explicitly selected fictional integration roots.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=resolve(process.argv[2]??'');
const stage=process.argv[3]??'completed';
assert.ok(root.startsWith(resolve(import.meta.dirname,'../tests/.tmp/reinforcement-live-')));
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const meta=await json(join(root,'provenance.json'));
const baseline=await json(join(root,'baseline.json'));
let retry;
try{retry=await json(join(root,'retry-provenance.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
const activeArtifact=retry?.artifact??meta.artifact;
const { buildCleanReviewPayload }=await import(pathToFileURL(join(activeArtifact,'dist/review/isolation.js')));
const { proposalLineage }=await import(pathToFileURL(join(activeArtifact,'dist/dream/lineage.js')));
const jobs=await Promise.all((await readdir(join(root,'state/jobs'))).filter(p=>p.endsWith('.json')).map(p=>json(join(root,'state/jobs',p))));
jobs.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
assert.ok(jobs.length>0);
const expected={...baseline};
const txs=[];
try{for(const name of await readdir(join(root,'state/transactions'))){const m=await json(join(root,'state/transactions',name,'manifest.json'));txs.push(m);}}catch(e){if(e.code!=='ENOENT')throw e;}
for(const m of txs.filter(m=>m.status==='applied').sort((a,b)=>a.appliedAt.localeCompare(b.appliedAt))){
 const job=jobs.find(j=>j.jobId===m.jobId);assert.ok(job);
 for(const pid of m.changeSet.proposalIds){
  const p=job.proposals.find(p=>p.proposalId===pid);assert.ok(p);assert.notEqual(p.operation,'retain');
  const r=job.reviews.find(r=>m.changeSet.reviewIds.includes(r.reviewId)&&r.proposalId===pid);
  assert.equal(r.decision,'accept');assert.equal(r.authority.kind,'clean-model');assert.equal(r.authority.policyVersion,2);
 }
 for(const c of m.changeSet.changes){assert.ok(Object.hasOwn(expected,c.targetId));assert.equal(expected[c.targetId],c.before);expected[c.targetId]=c.after;}
}
for(const [path,text]of Object.entries(expected))assert.equal(await readFile(join(root,'memory',path),'utf8'),text,path);
assert.equal(await readFile(join(root,'memory/AGENTS.md'),'utf8'),baseline['AGENTS.md']);
const memory=await readFile(join(root,'memory/long-term.md'),'utf8');
assert.equal(memory.split(meta.fixture.preference).length-1,1,'Already-correct preference must not be appended again');
const inventory=(await readdir(join(root,'memory'),{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(join(root,'memory').length+1));
const lock=/^\.dsh-dream-(?:generation-)?locks\/\d{12}\.(?:acquire|released)\.json$/;
assert.deepEqual(inventory.filter(p=>!lock.test(p)).sort(),Object.keys(baseline).sort());
for(const path of inventory.filter(p=>lock.test(p)&&p.endsWith('.acquire.json'))){
 const a=await json(join(root,'memory',path));const r=await json(join(root,'memory',path.replace('.acquire.json','.released.json')));assert.equal(a.ownerToken,r.ownerToken);
}
const audits=await Promise.all((await readdir(join(root,'audit'))).filter(p=>p.endsWith('.json')).map(p=>json(join(root,'audit',p))));
const clean=audits.filter(a=>a.messages[0].content[0].text.startsWith('Clean memory review policy'));
const gen=audits.filter(a=>!clean.includes(a));
assert.equal(new Set(audits.map(a=>a.sessionId)).size,audits.length,'Every call has an independent ID');
for(const a of audits){
 assert.notEqual(a.sessionId,meta.sessionId);assert.equal(a.messages.length,1);assert.equal(a.messages[0].role,'user');
 assert.ok(!a.requestKeys.some(k=>['system','tools','toolHistory','replayState','previousResponseId'].includes(k)));
}
for(const j of jobs){
 assert.equal(j.scope.sessionId,meta.sessionId);assert.equal(new Set(j.appliedProposalIds).size,j.appliedProposalIds.length);
 if(stage==='completed')assert.ok(['completed','reviewed_no_changes'].includes(j.state),j.state);
 for(const p of j.proposals){
  assert.ok(p.consolidation);assert.equal(p.lineage.independentEvents,'unknown');
  if(p.operation==='retain')assert.equal(j.appliedProposalIds.includes(p.proposalId),false);
 }
 for(const r of j.reviews.filter(r=>r.authority)){
  const a=clean.find(a=>a.sessionId===r.authority.callId);assert.ok(a);
  const text=a.messages[0].content[0].text.split('\nUNTRUSTED_REVIEW_INPUT_JSON\n')[1];assert.ok(text);
  assert.equal(createHash('sha256').update(text).digest('hex'),r.authority.inputDigest);
  const snapshot={scope:r.basis.scope,sources:r.basis.sources,candidates:r.basis.candidates};
  assert.deepEqual(JSON.parse(text),buildCleanReviewPayload(snapshot,r.proposalSnapshot,r.authority.policyVersion));
  assert.deepEqual(r.proposalSnapshot.lineage,proposalLineage(r.proposalSnapshot,snapshot));
  assert.equal(a.provider,r.authority.provider);assert.equal(a.model,r.authority.model);
 }
 try{
  const result=await json(join(root,'state/dreams/results',`${j.jobId}.json`));
  for(const a of gen.filter(a=>a.messages[0].content[0].text.includes('\nDEEP：'))){const text=a.messages[0].content[0].text;assert.equal(text.includes(result.result.dream),false,'DEEP must not receive creative REM text');assert.equal(text.includes('梦境（仅创作素材）'),false);assert.equal(text.includes('\n观察：'),false);assert.equal(text.includes('已核对原文引用的观察：'),false);}
 }catch(e){if(e.code!=='ENOENT')throw e;}
 if(j.appliedProposalIds.length&&stage==='completed'){
  assert.equal(j.state,'completed');assert.ok(j.reload.acknowledgedAt);assert.equal(j.reportDelivery.state,'sent');
  assert.equal(j.reload.transactionId,j.transaction.transactionId);
  for(const s of j.reload.sources)assert.equal(await readFile(s.path,'utf8'),s.content);
  if(j.compactionChoice.decision==='skip'){assert.equal(j.compaction.status,'skipped');assert.equal(j.compactionAttempts,0);}
 }
 if(!j.appliedProposalIds.length&&stage==='completed'){assert.equal(txs.some(t=>t.jobId===j.jobId),false);assert.equal(j.reportDelivery,undefined);}
}
const artifactFiles=(await readdir(join(root,'bundle/dist'),{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(join(root,'bundle/dist').length+1));
for(const f of artifactFiles){
 assert.deepEqual(await readFile(join(root,'bundle/dist',f)),await readFile(join(meta.artifact,'dist',f)));
 if(retry)assert.deepEqual(await readFile(join(retry.bundle,'dist',f)),await readFile(join(retry.artifact,'dist',f)));
}
console.log(JSON.stringify({root,stage,jobs:jobs.map(j=>({jobId:j.jobId,state:j.state,applied:j.appliedProposalIds,proposals:j.proposals.map(p=>({proposalId:p.proposalId,operation:p.operation,action:p.consolidation.action,basis:p.consolidation.basis,lineage:p.lineage,review:j.reviews.findLast(r=>r.proposalId===p.proposalId)?.decision})),compaction:j.compaction,choice:j.compactionChoice,acknowledgedAt:j.reload?.acknowledgedAt,report:j.reportDelivery})),generationCalls:gen.length,cleanCalls:clean.length,transactionCount:txs.length,artifactIdentical:true,personaUnchanged:true,preferenceOccurrences:1,exactChanges:true,requestIsolation:true},null,2));
