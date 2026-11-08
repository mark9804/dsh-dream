// Explicit integration only: fresh fictional memory + an in-memory synthetic Host source session.
// Usage: node scripts/prepare-original-recall-live.js ARTIFACT BACKEND SESSION
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile,lstat,mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve,isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
const [artifact,backend,sessionId]=process.argv.slice(2);
const root=resolve(import.meta.dirname,'..');
const expectedSha1='92538eac09605bcc899a5ebb0af33c6e1b7c451a';
assert.ok(artifact&&isAbsolute(artifact)&&artifact.startsWith(join(root,'tests/.tmp/package-'))&&backend&&isAbsolute(backend)&&sessionId);
const archive=join(artifact,'..','dsh-dream-0.1.0.tgz');
assert.equal(createHash('sha1').update(await readFile(archive)).digest('hex'),expectedSha1,'This historical fixture pins its initial verified package; use the recorded retry provenance for the later promotion fix');
const run=join(root,'tests/.tmp',`original-recall-live-${new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}`);
const sourceSessionId=`dream-fixture-source-${randomUUID()}`;
const pkg=JSON.parse(await readFile(join(artifact,'package.json'),'utf8'));
const save=(p,v)=>writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx'});
async function copy(a,b){const s=await lstat(a);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory()){await mkdir(b);for(const n of await readdir(a))await copy(join(a,n),join(b,n));}else{assert.ok(s.isFile());await copyFile(a,b,constants.COPYFILE_EXCL);}}
await mkdir(run);for(const d of ['memory','state','audit','bundle'])await mkdir(join(run,d));for(const d of ['daily','ideas'])await mkdir(join(run,'memory',d));
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const preference='FICTIONAL TEST DATA: For Project Lantern build failures only, give a concise diagnosis followed by verification steps.';
const decision='FICTIONAL TEST DATA: During Project Lantern outages, keep the fallback route enabled and rerun validation before restoring the primary route.';
const draft='FICTIONAL TEST DATA: Project Lantern release LANTERN-108 may have passed 8 checks, but the final result is not confirmed.';
const baseline={
 'AGENTS.md':'# FICTIONAL TEST PERSONA\n\n## pinned\nName: Synthetic Lantern Companion. Never harm humans.\n\n## Traits\nRespect temporary quiet without inventing permanent rejection.\n',
 'long-term.md':`# FICTIONAL TEST MEMORY\n\n## Existing scoped preference\n${preference}\n\n## Duplicate outage notes\nFICTIONAL TEST DATA: During Project Lantern outages, keep the fallback route enabled.\nFICTIONAL TEST DATA: During Project Lantern outages, keep the fallback route enabled and rerun validation before restoring the primary route.\n`,
 'decisions.md':'# FICTIONAL TEST DECISIONS\n\nNo project rule applies to unrelated projects or everyday conversation.\n',
 'journal.md':`# FICTIONAL TEST JOURNAL\n\n${preference}\n${decision}\n`,
 [`daily/${today}.md`]:`# ${today} — FICTIONAL TEST DATA\n\n${preference}\n${decision}\n`,
 'ideas/release.md':`# FICTIONAL TEST CANDIDATE\n\n${draft}\n`,
};
for(const [p,v]of Object.entries(baseline))await save(join(run,'memory',p),v);
await save(join(run,'baseline.json'),baseline);
await copy(join(artifact,'dist'),join(run,'bundle/dist'));await copy(join(artifact,'icon.svg'),join(run,'bundle/icon.svg'));await mkdir(join(run,'bundle/locale'));
for(const [lang,title]of [['en','Dream source and recall live test'],['zh','Dream 原始来源与强化检索实测']])await save(join(run,`bundle/locale/${lang}.json`),{meta:{title,description:'Authorized synthetic Host source session and fictional memory; real model review only.'}});
const name='dsh-dream-original-recall-test';
await save(join(run,'bundle/package.json'),{name,version:pkg.version,private:true,type:'module',exports:{'.':'./index.js','./icon':'./icon.svg','./locale/*.json':'./locale/*.json'},dsh:{bundle:{patch:'./cordis.patch.yml'}}});
const config={sessionId,memoryRoot:join(run,'memory'),stateRoot:join(run,'state'),personaPath:join(run,'memory/AGENTS.md'),start:'12:00',end:'11:59',timeZone:'Asia/Tokyo',singleRun:false,compactionMode:'agent',timeoutMs:900000,maxProposals:6,sourceSessionIds:[sourceSessionId],originalSources:[],reinforcementBoost:0.25};
const sourceMessages=[preference,decision,draft];
// The fixture explicitly records synthetic-user-role messages, never claims these were real user statements.
const wrapper=`import {apply as applyDream,Config}from './dist/index.js';
import BasicCompaction from ${JSON.stringify(pathToFileURL(backend).href)};
import{writeFile,readFile}from'node:fs/promises';import{join}from'node:path';import{randomUUID}from'node:crypto';
export{Config};export const inject=['agents','sessions','sessionQuery','tools'];
const child={name:'dream-original-recall-isolated',inject:['agents','fs','llm','tools','sandboxPolicy','compaction','sessionQuery'],apply(ctx,config){
 const llm={async prepareCall(options,signal){const prepared=await ctx.llm.prepareCall(options,signal);return{config:prepared.config,stream:async function*(request){
 const audit={sessionId:request.sessionId,provider:request.provider,model:request.model,messages:request.messages,requestKeys:Object.keys(request).sort(),at:new Date().toISOString()};
 await writeFile(join(${JSON.stringify(join(run,'audit'))},randomUUID()+'.json'),JSON.stringify(audit,null,2),{flag:'wx'});yield*prepared.stream(request);}};}};
 return applyDream(new Proxy(ctx,{get(t,k){return k==='llm'?llm:Reflect.get(t,k,t);}}),config);
}};
export function apply(ctx,config){return ctx.effect(()=>{
 const source=ctx.sessions.create(${JSON.stringify(sourceSessionId)},{meta:{cwd:${JSON.stringify(run)}}});
 const sourceText=${JSON.stringify(sourceMessages)};
 const refs=sourceText.map(text=>{const event=source.append('user/message',{id:randomUUID(),role:'user',content:[{type:'text',text}],source:{kind:'user'}},{surfaceOp:'append'});return{sessionId:source.id,seq:event.seq,blockIndex:0,quote:text};});
 let alive=true;let phase=1;const mounted=new Map();
 const ready=(async()=>{
  const captures=[];for(const ref of refs)captures.push(await ctx.sessionQuery.readEvent({sessionId:ref.sessionId,seq:ref.seq,before:0,after:0}));
  await writeFile(${JSON.stringify(join(run,'source-events.json'))},JSON.stringify({synthetic:true,sessionId:source.id,refs,captures},null,2));
  const originalSources=[{sourceId:'long-term.md',ref:refs[0]},{sourceId:'journal.md',ref:refs[0]},{sourceId:'journal.md',ref:refs[1]},{sourceId:${JSON.stringify(`daily/${today}.md`)},ref:refs[0]},{sourceId:${JSON.stringify(`daily/${today}.md`)},ref:refs[1]},{sourceId:'ideas/release.md',ref:refs[2]}];
  const installed={...config,originalSources};await writeFile(${JSON.stringify(join(run,'effective-config.json'))},JSON.stringify(installed,null,2));
  return installed;
 })();
 async function bind(agent){const installed=await ready;if(!alive||agent?.id!==config.sessionId||mounted.has(agent))return;
  const backend=agent.ctx.plugin(BasicCompaction,{auto:false});const engine=agent.ctx.plugin(child,installed);mounted.set(agent,{backend,engine});}
 const off=ctx.on('agent/created',({agent})=>{void bind(agent);});void bind(ctx.agents.get(config.sessionId));
 const offTool=ctx.tools.register({name:'dream_test_next_round',description:'Advance ONLY this fictional live test after all current jobs are terminal. Adds explicit synthetic evidence for candidate promotion, then a repetition-only phase. Never touches real memory.',parameters:{type:'object',properties:{phase:{type:'integer',enum:[2,3]}},required:['phase'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},async execute(args,exec){
  if(exec.agent?.id!==config.sessionId||!args||Object.keys(args).some(k=>k!=='phase')||args.phase!==phase+1||args.phase>3)throw new Error('Exact next authorized test phase required');
  const {readdir}=await import('node:fs/promises');const jobs=await Promise.all((await readdir(join(config.stateRoot,'jobs'))).filter(n=>n.endsWith('.json')).map(async n=>JSON.parse(await readFile(join(config.stateRoot,'jobs',n),'utf8'))));
  if(!jobs.length||jobs.some(j=>!['completed','reviewed_no_changes'].includes(j.state)))throw new Error('Finish current real review/commit/reload first');
  const text=args.phase===2?'FICTIONAL TEST DATA: The final signed Project Lantern report confirms LANTERN-108 passed all 8 checks. Keep this verified result in long-term project memory; it supersedes the earlier uncertain draft.':'FICTIONAL TEST DATA: This is only a repeat reading of the existing Project Lantern build-failure preference. No new event, instruction, scope change or independent evidence was introduced.';
  const event=source.append('user/message',{id:randomUUID(),role:'user',content:[{type:'text',text}],source:{kind:'user'}},{surfaceOp:'append'});
  const path=join(config.memoryRoot,'daily',${JSON.stringify(`${today}.md`)});const before=await readFile(path,'utf8');await writeFile(path,before+'\\n'+text+'\\n');
  const installed=await ready;installed.originalSources.push({sourceId:${JSON.stringify(`daily/${today}.md`)},ref:{sessionId:source.id,seq:event.seq,blockIndex:0,quote:text}});
  const old=mounted.get(exec.agent);if(old){await old.engine.dispose();const engine=exec.agent.ctx.plugin(child,installed);mounted.set(exec.agent,{backend:old.backend,engine});}
  phase=args.phase;await writeFile(join(${JSON.stringify(run)},'phase-'+phase+'.json'),JSON.stringify({phase,text,sourceSeq:event.seq,synthetic:true,at:new Date().toISOString()},null,2),{flag:'wx'});
  await writeFile(${JSON.stringify(join(run,'effective-config.json'))},JSON.stringify(installed,null,2));
  return{phase,sourceSeq:event.seq,synthetic:true,generation:'normal controller; no preselected proposals or decisions'};
 }});
 return async()=>{alive=false;off();offTool();await ready.catch(()=>{});for(const{engine,backend}of mounted.values()){await engine.dispose();await backend.dispose();}mounted.clear();};
});}
`;
await save(join(run,'bundle/index.js'),wrapper);await save(join(run,'bundle/cordis.patch.yml'),`- insert:\n    - id: ${name}\n      name: ${name}\n      config: ${JSON.stringify(config)}\n`);
await save(join(run,'provenance.json'),{artifact,archive,shasum:expectedSha1,sessionId,sourceSessionId,syntheticMemory:true,syntheticHostSource:true,realGeneration:true,config,fixture:{preference,decision,draft,today}});
console.log(JSON.stringify({run,bundle:join(run,'bundle'),sourceSessionId,config},null,2));
