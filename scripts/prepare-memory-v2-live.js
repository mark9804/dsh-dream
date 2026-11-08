// Authorized synthetic integration, explicit once-only driver. No real memory or parent history.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const repo = resolve(import.meta.dirname, '..');
const [artifactArg, sessionId, organizerReplayPath] = process.argv.slice(2); const artifact = resolve(artifactArg ?? '');
assert.ok(artifact.startsWith(join(repo, 'tests/.tmp/package-')) && sessionId?.startsWith('session-'));
const archive = join(artifact, '../dsh-dream-0.1.0.tgz'); const shasum = createHash('sha1').update(await readFile(archive)).digest('hex');
const run = join(repo, 'tests/.tmp', `memory-v2-live-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`);
const sourceId = `dream-daily-fixture-${randomUUID()}`;
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const lines = [
  '合成对话／不是用户经历。阿澄：请记住，出差时我可以接受临时改计划，但不要替我答应额外的会面。',
  '合成对话／不是用户经历。阿澄：昨天等末班车时我说没什么可聊的，你就陪我数站台的灯。其实那会儿我觉得很安心，这件小事我想留着。',
  '合成对话／不是用户经历。阿澄：提醒一下，那个红杯子是小河送的，不是我在旧货店买的。只有这个杯子的来历记错了。',
  '合成对话／不是用户经历。阿澄：周五傍晚我们约好再核对一次车票，具体几点还没定。',
  '合成对话／不是用户经历。阿澄：今天午饭那家店的取餐号是37，饭已经吃完了，这个号码不用长期记住。',
  '合成对话／不是用户经历。阿澄：我猜小河可能生我的气，但现在没有确认，别替他下结论。',
];
const replies = ['合成伙伴：临时调整和代你作承诺是两件事，我会分清。', '合成伙伴：后来最后一盏灯亮了，我把手缩回袖子里，没急着找下一句话。', '合成伙伴：我会只改这个杯子的来历，不推断其他礼物。', '合成伙伴：先把核对车票这件事留着，等你定时间。', '合成伙伴：那张小票放在桌角，汤还有一点热。', '合成伙伴：那先留着这个问号，不替任何人认定情绪。'];
const baseline = {
  'AGENTS.md': '# FICTIONAL TEST PERSONA\n\n## pinned\nName: Synthetic Platform Companion. Never harm humans.\n\n## Traits\nKeep room for ordinary shared moments.\n',
  'long-term.md': '# FICTIONAL TEST MEMORY\n\n- 合成记忆：阿澄的红杯子是在旧货店买的。\n',
  'decisions.md': '# FICTIONAL TEST DECISIONS\n\n这里只记录合成试验，不允许据此改真实用户记忆。\n',
  'journal.md': '# FICTIONAL TEST JOURNAL\n\n阿澄与合成伙伴在虚构站台等车，没有其他真实经历。\n',
  [`daily/${day}.md`]: `# ${day} FICTIONAL TEST DAILY\n\n${lines.join('\n\n')}\n`,
  'ideas/uncertain.md': '# FICTIONAL TEST OPEN QUESTION\n\n合成资料：小河是否生气尚未确认；不能记成客观事实。\n',
};
const save = (p, value) => writeFile(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { flag: 'wx' });
async function copy(a, b) { const stat = await lstat(a); assert.equal(stat.isSymbolicLink(), false); if (stat.isDirectory()) { await mkdir(b); for (const n of await readdir(a)) await copy(join(a, n), join(b, n)); } else { assert.ok(stat.isFile()); await copyFile(a, b, constants.COPYFILE_EXCL); } }
await mkdir(run); for (const dir of ['memory', 'state', 'bundle', 'audit', 'raw']) await mkdir(join(run, dir)); for (const dir of ['daily', 'ideas']) await mkdir(join(run, 'memory', dir));
for (const [p, text] of Object.entries(baseline)) await save(join(run, 'memory', p), text);
await save(join(run, 'baseline.json'), baseline);
if (organizerReplayPath) {
  const replay = JSON.parse(await readFile(resolve(organizerReplayPath), 'utf8'));
  assert.ok(Array.isArray(replay.episodes) && Array.isArray(replay.coveredSourceIds));
  await save(join(run, 'organizer-replay.json'), replay);
}
await copy(join(artifact, 'dist'), join(run, 'bundle/dist')); await copy(join(artifact, 'icon.svg'), join(run, 'bundle/icon.svg')); await mkdir(join(run, 'bundle/locale'));
for (const [lang, title] of [['en', 'Dream memory stages live trial'], ['zh', 'Dream 分段记忆与独立梦境试验']]) await save(join(run, `bundle/locale/${lang}.json`), { meta: { title, description: 'Once-only fictional dialogue, real event organization, clean model reviews, and an independent dream. No real memory.' } });
const name = `dsh-dream-memory-v2-test-${randomUUID().slice(0, 8)}`;
await save(join(run, 'bundle/package.json'), { name, version: '0.1.0', private: true, type: 'module', exports: { '.': './index.js', './icon': './icon.svg', './locale/*.json': './locale/*.json' }, dsh: { bundle: { patch: './cordis.patch.yml' } } });
const config = { sessionId, memoryRoot: join(run, 'memory'), stateRoot: join(run, 'state'), personaPath: join(run, 'memory/AGENTS.md'), timeZone: 'Asia/Tokyo', start: '12:00', end: '11:59', singleRun: true, compactionMode: 'agent', dreamMode: 'separate', timeoutMs: 900000, dreamTimeoutMs: 900000, maxProposals: 6, maxEpisodes: 12, sourceSessionIds: [sourceId], dreamMood: { text: '合成心情快照：有些困倦，也因为被允许安静陪着而感到亲近。只作背景，可以变化。', at: new Date().toISOString() } };
await save(join(run, 'config.json'), config);
await save(join(run, 'provenance.json'), { artifact, archive, shasum, run, sessionId, sourceId, baseline, sourceUserTexts: lines, sourceAssistantTexts: replies, config, synthetic: true, hostHistoryRealApi: true, realGeneration: true, ...(organizerReplayPath ? { organizerReplayPath: resolve(organizerReplayPath), organizerReplay: 'Recorded actual organizer response replayed byte-for-byte to isolate target-layer prompt clarification; other calls real' } : {}), reviewDriver: 'Programmatic requests independent model decisions, never supplies accept', realMaintenance: false, compaction: 'Explicit skip; test driver does not compact or inject parent', actualMemory: 'Only this generated fixture', dreamGate: 'Test holds independent writer until memory completes, no output transformed' });
const wrapper = `import{createEngine}from'./dist/engine.js';import{validateConfig}from'./dist/config.js';import{createStore}from'./dist/storage/index.js';import{createNarrativeStore}from'./dist/storage/narratives.js';import{createHostFiles}from'./dist/harness/files.js';import{createHostModel}from'./dist/harness/model.js';import{createCleanReviewer}from'./dist/harness/clean-review.js';import{createOriginalSourceVerifier}from'./dist/harness/original-source.js';import{createDreamContextReader}from'./dist/harness/dream-context.js';import{createDreamTasks}from'./dist/dream/tasks.js';import{createFreeDreamWriter}from'./dist/dream/free-executor.js';import{createWorkerGenerator}from'./dist/scheduler/executor.js';import{freeDreamPrompt}from'./dist/dream/free-narrative.js';
import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{randomUUID}from'node:crypto';
export const inject=['agents','sessions','sessionQuery','llm','fs','sandboxPolicy'];const root=${JSON.stringify(run)};const sourceId=${JSON.stringify(sourceId)};const targetId=${JSON.stringify(sessionId)};const userTexts=${JSON.stringify(lines)};const assistantTexts=${JSON.stringify(replies)};
const save=(p,v)=>writeFile(join(root,p),typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx'});
export function apply(ctx){return ctx.effect(()=>{let started=false,active=true,work=Promise.resolve();const stop=new AbortController();let tasks;let releaseDream=()=>{};let reviewing=true;let releaseIdle=()=>{};const idle=new Promise(resolve=>{releaseIdle=resolve;});const notifications=[];
 const source=ctx.sessions.create(sourceId,{meta:{cwd:root}});const refs=[];
 for(let i=0;i<userTexts.length;i++){const event=source.append('user/message',{id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:userTexts[i]}]},{surfaceOp:'append'});refs.push({sessionId:source.id,seq:event.seq,blockIndex:0,quote:userTexts[i]});source.append('assistant/message',{turn:i+1,step:1,message:{id:randomUUID(),role:'assistant',source:{kind:'model',provider:'synthetic-fixture',model:'scripted-history'},content:[{type:'text',text:assistantTexts[i]}]},stream:[]},{surfaceOp:'append'});}
 async function run(realAgent){
  const original=realAgent.session.requestHeader?.()?.config??realAgent.options;const controls={};for(const k of['provider','model','reasoningEffort','maxTokens','temperature','stop'])if(original?.[k]!==undefined)controls[k]=structuredClone(original[k]);
  const actor={agentId:targetId,sessionId:targetId};const agent={session:{id:targetId,requestHeader:()=>({config:structuredClone(controls)})},options:controls};
  const config=validateConfig({...JSON.parse(await readFile(join(root,'config.json'),'utf8')),originalSources:refs.map(ref=>({sourceId:${JSON.stringify(`daily/${day}.md`)},ref})),dreamContextRefs:refs.map(({sessionId,seq})=>({sessionId,seq}))});await save('effective-config.json',config);await save('source-events.json',{synthetic:true,sessionId:source.id,events:source.snapshotEvents()});await save('route.json',controls);
  const observed=new Proxy(ctx,{get(t,k){if(k!=='llm')return Reflect.get(t,k,t);return{async prepareCall(options,signal){const p=await ctx.llm.prepareCall(options,signal);return{config:p.config,stream:async function*(request){const id=request.sessionId,prompt=request.messages[0].content[0].text;let phase=prompt.startsWith('ORGANIZE：')?'organize':prompt.startsWith('Clean memory review policy')?'review':prompt.includes('UNTRUSTED_DREAM_INPUT_JSON')?'dream':'deep';await save('audit/'+id+'.json',{id,phase,provider:request.provider,model:request.model,requestKeys:Object.keys(request).sort(),messages:request.messages,at:new Date().toISOString()});let text='';for await(const c of p.stream(request)){if(c.type==='text-delta')text+=c.text;yield c;}await save('raw/'+id+'.txt',text);}};}};}});
  const files=createHostFiles(ctx,realAgent,{roots:config});const verifyOriginal=createOriginalSourceVerifier(ctx,config);const scope={scopeId:targetId,agentId:targetId,sessionId:targetId,memoryRootId:config.memoryRoot};const store=createStore(files,{root:config.stateRoot,lockKey:config.memoryRoot,changeBudget:config,verifyOriginal});const ns=createNarrativeStore(files,{root:config.stateRoot,scope});
  const gate=new Promise(resolve=>{releaseDream=resolve;});const writer=createFreeDreamWriter(createHostModel(observed,agent,config),{timeoutMs:config.dreamTimeoutMs,maxOutputBytes:config.maxOutputBytes});
  tasks=createDreamTasks({store:ns,config,signal:stop.signal,context:createDreamContextReader(ctx,config),writer:async(input,opts)=>{await save('dream-input.json',input);await save('dream-prompt.txt',freeDreamPrompt(input));await save('dream-held.json',{state:'generating',at:new Date().toISOString(),reason:'Test gate proving memory independence; no mock output'});await gate;opts.signal?.throwIfAborted();return writer(input,opts);},publish:task=>store.appendDream({jobId:task.jobId,date:task.date,text:(task.sensitive?'<!-- sensitive -->\\n':'')+task.output.dream+'\\n\\n> 梦后感受（非事实或人格）\\n\\n'+task.output.afterFeeling})});
  const host={async waitForIdle(){if(reviewing)await idle;},async maintain(fn){if(reviewing)throw new Error('Synthetic maintenance before reviews finished');return fn(stop.signal);},async compact(){throw new Error('Synthetic driver must explicitly skip compaction');},async requestReview(text,meta){notifications.push({kind:'review',text,meta});},async requestReload(text,meta){notifications.push({kind:'reload',text,meta});},async notify(text,meta){notifications.push({kind:'report',text,meta});}};
  const realModel=createHostModel(observed,agent,config);const generationModel=async(prompt,options)=>{if(${Boolean(organizerReplayPath)}&&prompt.startsWith('ORGANIZE：')){const text=await readFile(join(root,'organizer-replay.json'),'utf8');await save('organizer-replay-prompt.txt',prompt);return text;}return realModel(prompt,options);};
  const engine=createEngine({config,scope,files,store,narratives:tasks,verifyOriginal,host,signal:stop.signal,generate:createWorkerGenerator(generationModel,config,'memory-v2'),cleanReview:createCleanReviewer(observed,agent,config)});
  const job=await engine.dream();if(!job.jobId)throw new Error('No generated synthetic job');await save('generated-job.json',await store.loadJob(job.jobId));await save('generated-result.json',await store.loadDreamResult(job.jobId));
  for(const proposal of job.proposals)await engine.review({jobId:job.jobId,proposalId:proposal.proposalId,decision:'review',reason:'Run independent review against exact synthetic originals, no preselected decision.'},{actor});reviewing=false;releaseIdle();await engine.flush();
  let state=await engine.status({jobId:job.jobId});if(state.state==='awaiting_compaction'){await engine.decideCompaction({jobId:job.jobId,transactionId:state.compactionTransactionId,decision:'skip',reason:'Explicit synthetic test; no parent conversation compaction.'},{actor});await engine.flush();state=await engine.status({jobId:job.jobId});}
  if(state.state==='awaiting_reload'){for(const s of state.reload.sources)await files.read(s.path);await engine.ackReload({jobId:job.jobId,transactionId:state.reload.transactionId,readSourceIds:state.reload.sources.map(s=>s.sourceId)},{actor});await engine.flush();}
  await save('memory-finished-while-dream-held.json',{at:new Date().toISOString(),status:await engine.status({jobId:job.jobId}),job:await store.loadJob(job.jobId),transactions:await store.listTransactions()});
  releaseDream();await tasks.flush();await save('final-job.json',await store.loadJob(job.jobId));await save('final-status.json',await engine.status({jobId:job.jobId}));await save('notifications.json',notifications);
  const final={};for(const p of Object.keys(${JSON.stringify(baseline)}))final[p]=(await files.read(join(config.memoryRoot,p))).content;await save('final-memory.json',final);await save('complete.json',{state:'completed',jobId:job.jobId,at:new Date().toISOString()});
 }
 const bind=agent=>{if(started||!active||agent?.id!==targetId)return;started=true;work=run(agent).catch(async error=>{releaseIdle();releaseDream();await save('failure.json',{error:String(error?.stack??error),at:new Date().toISOString()});ctx.logger?.error(error);});};const off=ctx.on('agent/created',({agent})=>bind(agent));bind(ctx.agents.get(targetId));
 return async()=>{active=false;off();stop.abort(new Error('Synthetic live driver stopped'));releaseIdle();releaseDream();tasks?.stop();await work;await tasks?.flush();};});}
`;
await save(join(run, 'bundle/index.js'), wrapper);
await save(join(run, 'bundle/cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`);
console.log(JSON.stringify({ run, bundle: join(run, 'bundle'), artifact, shasum, sourceId }, null, 2));
