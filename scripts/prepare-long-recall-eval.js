// Freeze retrieval comparisons and evaluator-only gold before any live answer calls.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { collectSnapshot } from '../dist/dream/materials.js';
import { collectRecallSnapshot } from '../dist/dream/recall-materials.js';
import { recallMemory } from '../dist/dream/recall.js';
import { validateConfig } from '../dist/config.js';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { buildRecallAnswerPrompt } from './lib/recall-evaluation.js';
const repo=resolve(import.meta.dirname,'..');
const prior=join(repo,'tests/.tmp/memory-v2-live-2026-11-03T20-24-38-543Z');
const baseline=JSON.parse(await readFile(join(prior,'baseline.json'),'utf8')),consolidated=JSON.parse(await readFile(join(prior,'final-memory.json'),'utf8'));
const goldText=await readFile(join(repo,'tests/fixtures/long-recall-cases.json'),'utf8');const gold=JSON.parse(goldText);
assert.equal(gold.cases.length,8);
const root=await mkdtemp(join(repo,'tests/.tmp/long-recall-eval-'));for(const d of ['data','retrieval','prompts','answers','audit','raw'])await mkdir(join(root,d));
const save=(p,v)=>writeFile(join(root,p),typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx'});
await save('gold.json',goldText);
const local=createLocalFiles(root);const p=p=>isAbsolute(p)?relative(root,p):p;
const files={...local,read:(q,o)=>local.read(p(q),o),write:(q,c,v)=>local.write(p(q),c,v),stat:q=>local.stat(p(q)),list:q=>local.list(p(q)),mkdir:q=>local.mkdir(p(q))};
const items=[],observations=[];const days=[0,7,30];
for(const[arm,memory]of Object.entries({raw:baseline,consolidated})){
 const memoryRoot=join(root,'data',arm,'memory');for(const d of ['daily','ideas'])await files.mkdir(join(memoryRoot,d));
 for(const[path,text]of Object.entries(memory))await files.write(join(memoryRoot,path),text,null);
 // Dream-only decoy remains physically present but outside every factual collector.
 await files.mkdir(join(memoryRoot,'dreams'));await files.write(join(memoryRoot,'dreams/26-11-04.md'),'> Dream content; not factual evidence.\n阿澄坐过停在杯子里的末班车，红杯子花了9999元。\n',null);
 const config=validateConfig({sessionId:'synthetic-eval',memoryRoot,stateRoot:join(root,'data',arm,'state'),personaPath:join(memoryRoot,'AGENTS.md'),timeZone:'Asia/Tokyo',reinforcementBoost:0,recallHistoryDays:90});
 const scope={scopeId:'synthetic-eval',sessionId:'synthetic-eval',agentId:'synthetic-eval',memoryRootId:memoryRoot};
 for(const day of days){
  const now=new Date(Date.parse('2026-11-04T12:00:00+09:00')+day*86400000);
  const base=await collectSnapshot(files,config,scope,{now,snapshotId:`${arm}-day${day}-current`});
  const historic=await collectRecallSnapshot(files,config,scope,{now,snapshotId:`${arm}-day${day}-history`});
  for(const[mode,snapshot,materials,basis]of [['current',base,undefined,base],['history',historic.snapshot,historic.coverage,historic.currentSnapshot]]){
   const key=`${arm}-${mode}-day${day}`;
   await save(`retrieval/${key}-snapshot.json`,snapshot);
   for(const item of gold.cases){
    const request={query:item.query,topic:'合成历史回忆',conditions:'仅根据已保存原文回答，不扩大到其他经历',limit:4};
    const started=performance.now();const recall=recallMemory(snapshot,[],[],request,{now,boost:0,...(materials?{materials}:{}),reinforcementBasis:basis});const latencyMs=performance.now()-started;
    for(const h of recall.hits){const source=snapshot.sources.find(s=>s.sourceId===h.sourceId);assert.equal(source.content.slice(h.proof.start,h.proof.end),h.text);assert.equal(createHash('sha256').update(source.content).digest('hex'),h.proof.contentHash);assert.equal(h.path.includes('dreams/'),false);}
    const id=`${key}-${item.id}`;await save(`retrieval/${id}.json`,recall);
    const prompt=buildRecallAnswerPrompt(item.question,recall);await save(`prompts/${id}.txt`,prompt);
    const observation={id,arm,mode,day,caseId:item.id,sourceIds:snapshot.sources.map(s=>s.sourceId),hits:recall.hits.length,evidenceFound:item.retrievalAnchors.length>0&&item.retrievalAnchors.every(anchor=>recall.hits.some(h=>(!anchor.sourceId||h.sourceId===anchor.sourceId)&&anchor.anyOf.some(q=>h.text.includes(q)))),answerableAnchors:item.retrievalAnchors.length,outputBytes:Buffer.byteLength(JSON.stringify(recall)),latencyMs};observations.push(observation);
    if(day===7)items.push({id,arm,mode,day,caseId:item.id,promptPath:`prompts/${id}.txt`,retrievalPath:`retrieval/${id}.json`,promptHash:createHash('sha256').update(prompt).digest('hex')});
   }
  }
 }
}
// Counterbalance order without selecting based on gold or observed answers.
const order=['raw-current','consolidated-current','raw-history','consolidated-history'];
const schedule=gold.cases.flatMap((item,i)=>order.map((_,j)=>{const armMode=order[(i+j)%order.length];return items.find(x=>`${x.arm}-${x.mode}`===armMode&&x.caseId===item.id);}));
assert.equal(schedule.length,32);assert.ok(schedule.every(Boolean));
await save('manifest.json',{schemaVersion:1,synthetic:true,createdAt:new Date().toISOString(),prior,goldSha256:createHash('sha256').update(goldText).digest('hex'),items:schedule,days,callCount:32,topK:4,boost:0,historyAndControls:[],comparison:'2x2 files(raw/consolidated) × collector(current/history), fixed original question queries, independent fresh answer requests, no gold/digest/proposal or dreams in prompt',modelEvaluationScope:'retrieval only reused true-model consolidation artifact; not re-generating memory; simulated dates do not alter wall clock'});
await save('retrieval-summary.json',observations);
console.log(JSON.stringify({root,calls:32,offlineRetrievals:observations.length,arms:order,day7:order.map(label=>{const list=observations.filter(o=>`${o.arm}-${o.mode}`===label&&o.day===7&&o.answerableAnchors>0);return{label,fullEvidence:list.filter(o=>o.evidenceFound).length,total:list.length};})},null,2));
