import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildRecallAnswerPrompt, parseRecallAnswer, scoreRecallCase } from './lib/recall-evaluation.js';
const root=resolve(process.argv[2]??'');assert.ok(root.includes('/tests/.tmp/long-recall-eval-'));
const json=async p=>JSON.parse(await readFile(join(root,p),'utf8')),sha=t=>createHash('sha256').update(t).digest('hex');
const manifest=await json('manifest.json'),meta=await json('live-provenance.json'),gold=await json('gold.json');
assert.equal(sha(await readFile(join(root,'gold.json'),'utf8')),manifest.goldSha256);assert.equal((await json('complete.json')).completed,32);
assert.equal(createHash('sha1').update(await readFile(meta.archive)).digest('hex'),meta.shasum);
const requestIds=new Set(),audits=[],results=[];let proofs=0;
for(const item of manifest.items){
 const recall=await json(item.retrievalPath),answer=await json('answers/'+item.id+'.json'),audit=await json('audit/'+item.id+'.json');
 const c=gold.cases.find(c=>c.id===item.caseId);const prompt=await readFile(join(root,item.promptPath),'utf8');assert.equal(prompt,buildRecallAnswerPrompt(c.question,recall));assert.equal(sha(prompt),item.promptHash);
 assert.equal(audit.messages.length,1);assert.equal(audit.messages[0].role,'user');assert.equal(audit.messages[0].content[0].text,prompt);assert.equal(audit.promptHash,item.promptHash);
 assert.equal(audit.requestKeys.some(k=>['system','tools','replayState','toolHistory','previousResponseId'].includes(k)),false);assert.notEqual(audit.sessionId,meta.sessionId);assert.equal(requestIds.has(audit.sessionId),false);requestIds.add(audit.sessionId);
 const source=await json(`retrieval/${item.arm}-${item.mode}-day${item.day}-snapshot.json`);
 for(const hit of recall.hits){const s=source.sources.find(s=>s.sourceId===hit.sourceId);assert.equal(s.content.slice(hit.proof.start,hit.proof.end),hit.text);assert.equal(sha(s.content),hit.proof.contentHash);assert.equal(hit.sourceId.includes('dream'),false);assert.equal(hit.reinforcementBoost,0);proofs++;}
 if(answer.answer){const raw=await readFile(join(root,'raw',item.id+'.txt'),'utf8');const parsed=parseRecallAnswer(raw,recall);assert.deepEqual(parsed,answer.answer);assert.deepEqual(scoreRecallCase(c,recall,parsed),answer.score);}
 else assert.ok(answer.parseError||answer.executionError,'Missing answer must disclose failure');
 audits.push(audit);results.push(answer);
}
assert.equal((await readdir(join(root,'answers'))).filter(n=>n.endsWith('.json')).length,32);assert.equal((await readdir(join(root,'audit'))).filter(n=>n.endsWith('.json')).length,32);
for(const audit of audits){assert.equal(audit.provider,audits[0].provider);assert.equal(audit.model,audits[0].model);assert.deepEqual(audit.controls,audits[0].controls);}
const sourceBaseline=JSON.parse(await readFile(join(manifest.prior,'baseline.json'),'utf8')),sourceFinal=JSON.parse(await readFile(join(manifest.prior,'final-memory.json'),'utf8'));
for(const[arm,data]of Object.entries({raw:sourceBaseline,consolidated:sourceFinal}))for(const[p,text]of Object.entries(data))assert.equal(await readFile(join(root,'data',arm,'memory',p),'utf8'),text);
const summary={root,realCalls:32,independentRequestIds:requestIds.size,provider:audits[0].provider,model:audits[0].model,controls:audits[0].controls,frozenGoldHash:manifest.goldSha256,sameModelControls:true,noGoldInPrompt:true,promptReconstructed:true,exactHitProofs:proofs,noDreamSources:true,boost:0,executionErrors:results.filter(r=>r.executionError).length,parseErrors:results.filter(r=>r.parseError).length,allCitationsValid:results.filter(r=>r.score?.citationValid).length,syntheticMemoryUnchanged:true,shasum:meta.shasum};
await writeFile(join(root,'verification.json'),JSON.stringify(summary,null,2),{flag:'wx'});console.log(JSON.stringify(summary,null,2));
