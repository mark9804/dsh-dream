// Register an explicit bounded cold-answer evaluation, no memory writes or schedules.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const repo=resolve(import.meta.dirname,'..');
const[rootArg,artifactArg,sessionId]=process.argv.slice(2);const root=resolve(rootArg??''),artifact=resolve(artifactArg??'');
assert.ok(root.startsWith(join(repo,'tests/.tmp/long-recall-eval-'))&&artifact.startsWith(join(repo,'tests/.tmp/package-'))&&sessionId?.startsWith('session-'));
const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));assert.equal(manifest.callCount,32);
const archive=join(artifact,'../dsh-dream-0.1.0.tgz'),shasum=createHash('sha1').update(await readFile(archive)).digest('hex');
const bundle=join(root,'bundle');await mkdir(bundle);await mkdir(join(bundle,'lib'));await mkdir(join(bundle,'locale'));
const save=(p,v)=>writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx'});
async function copy(a,b){const st=await lstat(a);assert.equal(st.isSymbolicLink(),false);if(st.isDirectory()){await mkdir(b);for(const n of await readdir(a))await copy(join(a,n),join(b,n));}else{assert.ok(st.isFile());await copyFile(a,b,constants.COPYFILE_EXCL);}}
await copy(join(artifact,'dist'),join(bundle,'dist'));await copyFile(join(artifact,'icon.svg'),join(bundle,'icon.svg'),constants.COPYFILE_EXCL);await copyFile(join(repo,'scripts/lib/recall-evaluation.js'),join(bundle,'lib/recall-evaluation.js'),constants.COPYFILE_EXCL);
for(const[lang,title]of[['en','Dream cold long-term recall evaluation'],['zh','Dream 冷上下文长期回忆评估']])await save(join(bundle,`locale/${lang}.json`),{meta:{title,description:'32 pre-registered synthetic cold answer calls, 2x2 retrieval comparison; no real memory or state changes.'}});
const name=`dsh-dream-long-recall-eval-${randomUUID().slice(0,8)}`;
await save(join(bundle,'package.json'),{name,version:'0.1.0',private:true,type:'module',exports:{'.':'./index.js','./icon':'./icon.svg','./locale/*.json':'./locale/*.json'},dsh:{bundle:{patch:'./cordis.patch.yml'}}});
await save(join(bundle,'cordis.patch.yml'),`- insert:\n    - id: ${name}\n      name: ${name}\n`);
const wrapper=`import{createHostModel}from'./dist/harness/model.js';import{parseRecallAnswer,scoreRecallCase}from'./lib/recall-evaluation.js';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{createHash}from'node:crypto';
export const inject=['agents','llm'];const root=${JSON.stringify(root)},target=${JSON.stringify(sessionId)};const save=(p,v)=>writeFile(join(root,p),typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx'});const sha=t=>createHash('sha256').update(t).digest('hex');
export function apply(ctx){return ctx.effect(()=>{let active=true,started=false,work=Promise.resolve();const stop=new AbortController();
 async function run(agent){
  const config=agent.session.requestHeader?.()?.config??agent.options,controls={};for(const k of['provider','model','reasoningEffort','maxTokens','temperature','stop'])if(config?.[k]!==undefined)controls[k]=structuredClone(config[k]);if(!controls.provider||!controls.model)throw new Error('Actual route unavailable');
  const fixedAgent={session:{id:target,requestHeader:()=>({config:structuredClone(controls)})},options:controls};await save('route.json',{selected:controls,sessionId:target,at:new Date().toISOString()});
  const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')),gold=JSON.parse(await readFile(join(root,'gold.json'),'utf8'));let next=0,finished=0;const results=[];
  async function worker(){while(next<manifest.items.length){const index=next++,item=manifest.items[index];stop.signal.throwIfAborted();const prompt=await readFile(join(root,item.promptPath),'utf8'),recall=JSON.parse(await readFile(join(root,item.retrievalPath),'utf8'));if(sha(prompt)!==item.promptHash)throw new Error('Frozen prompt changed');
    const observed=new Proxy(ctx,{get(t,k){if(k!=='llm')return Reflect.get(t,k,t);return{async prepareCall(c,signal){const p=await ctx.llm.prepareCall(c,signal);return{config:p.config,stream:async function*(request){const audit={itemId:item.id,index,sessionId:request.sessionId,requestKeys:Object.keys(request).sort(),provider:request.provider,model:request.model,controls:{},messages:request.messages,promptHash:sha(request.messages[0].content[0].text),at:new Date().toISOString()};for(const key of['reasoningEffort','maxTokens','temperature','stop'])if(request[key]!==undefined)audit.controls[key]=request[key];await save('audit/'+item.id+'.json',audit);yield* p.stream(request);}};}};}});
    const model=createHostModel(observed,fixedAgent,{maxOutputBytes:65536}),controller=new AbortController(),signal=AbortSignal.any([stop.signal,controller.signal]);const timer=setTimeout(()=>controller.abort(new Error('Cold answer timeout')),300000);const begin=performance.now();let record;
    try{const text=await model(prompt,{signal});await save('raw/'+item.id+'.txt',text);let answer,score,parseError;try{answer=parseRecallAnswer(text,recall);score=scoreRecallCase(gold.cases.find(c=>c.id===item.caseId),recall,answer);}catch(e){parseError=String(e?.message??e);}record={...item,latencyMs:performance.now()-begin,...(answer?{answer,score}:{parseError}),at:new Date().toISOString()};}
    catch(e){record={...item,latencyMs:performance.now()-begin,executionError:String(e?.message??e),at:new Date().toISOString()};}
    finally{clearTimeout(timer);}await save('answers/'+item.id+'.json',record);results.push(record);finished++;
  }}
  await Promise.all([worker(),worker()]);await save('results.json',{completed:finished,callBudget:32,results});await save('complete.json',{state:'completed',completed:finished,at:new Date().toISOString()});
 }
 const bind=agent=>{if(!active||started||agent?.id!==target)return;started=true;work=run(agent).catch(async error=>{await save('failure.json',{error:String(error?.stack??error),at:new Date().toISOString()});ctx.logger?.error(error);});};const off=ctx.on('agent/created',({agent})=>bind(agent));bind(ctx.agents.get(target));return async()=>{active=false;off();stop.abort(new Error('Cold recall evaluation stopped'));await work;};});}
`;
await save(join(bundle,'index.js'),wrapper);await save(join(root,'live-provenance.json'),{artifact,archive,shasum,sessionId,bundle,name,callBudget:32,concurrency:2,perCallTimeoutMs:300000,synthetic:true,realCalls:true,hasGoldInPrompt:false,modelHistory:false,schedule:'Counterbalanced fixed case+arm order, no retries, no style/evidence cherry-picking',evaluatedDate:'2026-11-11T12:00:00+09:00',memoryChanges:false});
console.log(JSON.stringify({root,bundle,name,shasum,calls:32,concurrency:2},null,2));
