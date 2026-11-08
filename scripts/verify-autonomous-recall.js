import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root=resolve(process.argv[2]??'');assert.ok(root.includes('/tests/.tmp/autonomous-recall-'));
const json=async p=>JSON.parse(await readFile(join(root,p),'utf8')),sha=t=>createHash('sha256').update(t).digest('hex');
const manifest=await json('manifest.json'),corpus=await json('corpus-gold.json'),items=await json('items.json'),schema=await json('tool-schema.json');
const base=await readFile(join(root,'base-system.txt'),'utf8'),guidance=await readFile(join(root,'guidance.txt'),'utf8');
assert.equal(sha(base),manifest.hashes.baseSystem);assert.equal(sha(guidance),manifest.hashes.guidance);assert.equal(sha(JSON.stringify(schema)),manifest.hashes.schema);assert.equal(sha(await readFile(join(root,'corpus-gold.json'),'utf8')),manifest.hashes.corpus);assert.equal((await json('complete.json')).completed,manifest.episodes);
for(const[path,text]of Object.entries(corpus.memory))assert.equal(await readFile(join(root,'memory',path),'utf8'),text);
const episodes=[],sessions=new Set();let proofs=0,allRequests=0;const routes=new Set(),allControls=new Set();
for(const item of items){
 const r=await json('results/'+item.id+'.json'),dir='audit/'+item.id,names=await readdir(join(root,dir));const requestNames=names.filter(n=>n.startsWith('request-')).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
 let toolCount=0,toolErrors=0,emptyTools=0,firstPromptTokens=null,inputTokens=0,outputTokens=0,declaredCalls=0;const calls=[];const seenToolResults=await Promise.all(names.filter(n=>n.startsWith('tool-')).map(n=>json(dir+'/'+n)));let priorRequest,priorResponse;
 for(let step=0;step<requestNames.length;step++){
  const req=await json(dir+'/'+requestNames[step]),resp=await json(dir+'/response-'+step+'.json');allRequests++;
  assert.equal(req.system,base+(item.arm==='guided'?'\n\n'+guidance:''));assert.deepEqual(req.tools,[schema]);assert.equal(req.messages[0].role,'user');assert.equal(req.messages[0].content[0].text,item.question);assert.equal(req.messages.filter(m=>m.role==='user').length,1);
  assert.equal(req.sessionId,r.sessionId);assert.notEqual(req.sessionId,manifest.target);assert.equal('toolHistory'in req||'replayState'in req,false);
  routes.add(JSON.stringify({provider:req.provider,model:req.model}));const controls={};for(const k of['reasoningEffort','maxTokens','temperature','stop'])if(req[k]!==undefined)controls[k]=req[k];allControls.add(JSON.stringify(controls));
  if(step===0){assert.equal(req.messages.length,1);firstPromptTokens=resp.usage?.inputTokens??null;}
  else{assert.deepEqual(req.messages.slice(0,priorRequest.messages.length),priorRequest.messages);const additions=req.messages.slice(priorRequest.messages.length);assert.equal(additions[0].role,'assistant');assert.deepEqual(additions[0].content,priorResponse.content);assert.equal(additions.length,1+priorResponse.calls.length);for(const call of priorResponse.calls){const m=additions.find(m=>m.role==='tool'&&m.toolCallId===call.id);assert.ok(m);const result=seenToolResults.find(t=>t.call.id===call.id);assert.deepEqual(m.content,result.result.content);assert.equal(!!m.isError,result.result.isError);}}
  if(resp.usage){inputTokens+=resp.usage.inputTokens??0;outputTokens+=resp.usage.outputTokens??0;}
  declaredCalls+=resp.calls.length;priorRequest=req;priorResponse=resp;
 }
 const tNames=names.filter(n=>n.startsWith('tool-')).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
 // Materialize before proving followup chains below; histories are independently
 // audited again because a response can declare calls not executed at a budget stop.
 for(const n of tNames){const t=await json(dir+'/'+n);toolCount++;if(t.result.isError){toolErrors++;continue;}assert.equal(t.call.name,'dream_recall');const v=t.result.value;assert.deepEqual(JSON.parse(t.result.content[0].text),v);if(!v.hits.length)emptyTools++;
  const args=JSON.parse(t.call.arguments);calls.push({query:args.query,topic:args.topic,conditions:args.conditions,limit:args.limit??10,hits:v.hits.length,sourceIds:v.hits.map(h=>h.sourceId)});
  for(const h of v.hits){const content=corpus.memory[h.sourceId];assert.equal(typeof content,'string',h.sourceId);assert.equal(content.slice(h.proof.start,h.proof.end),h.text);assert.equal(sha(content),h.proof.contentHash);assert.equal(h.sourceId.includes('dream'),false);assert.equal(h.reinforcementBoost,0);proofs++;}
 }
 // All continuation tool messages must match one actually executed result.
 for(const n of requestNames){const req=await json(dir+'/'+n);for(const m of req.messages.filter(m=>m.role==='tool')){const t=seenToolResults.find(t=>t.call.id===m.toolCallId);assert.ok(t);assert.deepEqual(m.content,t.result.content);assert.equal(!!m.isError,t.result.isError);}}
 if(r.sessionId){assert.equal(sessions.has(r.sessionId),false);sessions.add(r.sessionId);}
 assert.ok(requestNames.length<=manifest.limits.maxSteps);assert.ok(toolCount<=manifest.limits.maxTools);assert.equal(r.toolCount??toolCount,toolCount);
 episodes.push({id:item.id,caseId:item.caseId,arm:item.arm,state:r.state,shouldRecall:corpus.cases.find(c=>c.id===item.caseId).shouldRecall ?? (corpus.cases.find(c=>c.id===item.caseId).gold?.requiredEvidence?.length > 0),modelCalls:requestNames.length,toolCount,toolErrors,emptyTools,firstPromptTokens,inputTokens,outputTokens,latencyMs:r.latencyMs,calls,answer:r.answer??null,...(r.error?{error:r.error}:{}),declaredCalls});
}
assert.equal(routes.size,1);assert.equal(allControls.size,1);const summary=['tool-only','guided'].map(arm=>{const a=episodes.filter(e=>e.arm===arm),recall=a.filter(e=>e.shouldRecall),negative=a.filter(e=>!e.shouldRecall);return{arm,episodes:a.length,completed:a.filter(e=>e.state==='completed').length,failed:a.filter(e=>e.state==='failed').length,budgetExhausted:a.filter(e=>e.state==='budget-exhausted').length,recallQuestions:recall.length,recallQuestionsUsingTool:recall.filter(e=>e.toolCount>0).length,negativeQuestions:negative.length,negativeWithTool:negative.filter(e=>e.toolCount>0).length,modelCalls:a.reduce((n,e)=>n+e.modelCalls,0),toolCalls:a.reduce((n,e)=>n+e.toolCount,0),toolErrors:a.reduce((n,e)=>n+e.toolErrors,0),emptyTools:a.reduce((n,e)=>n+e.emptyTools,0),additionalSearchEpisodes:recall.filter(e=>e.toolCount>1).length,meanFirstPromptTokens:a.every(e=>e.firstPromptTokens!==null)?a.reduce((n,e)=>n+e.firstPromptTokens,0)/a.length:null,inputTokens:a.reduce((n,e)=>n+e.inputTokens,0),outputTokens:a.reduce((n,e)=>n+e.outputTokens,0)};});
const result={root,realCalls:allRequests,independentEpisodes:sessions.size,route:JSON.parse([...routes][0]),controls:JSON.parse([...allControls][0]),exactHitProofs:proofs,noGoldOrFixedQueryInPrompt:true,schemasIdentical:true,onlyStrategyDiffers:true,noDreamSources:true,syntheticMemoryUnchanged:true,summary,episodes};await writeFile(join(root,process.argv[3]??'verified-summary.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({...result,episodes:undefined},null,2));
