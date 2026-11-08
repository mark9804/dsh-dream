// Real shipped BasicCompactionEngine, mounted in a fresh compaction service realm
// tagged to each owned synthetic Agent. Never enable the inactive root backend.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import BasicCompactionEngine from './native-basic.js';
import * as CommandCompact from './native-command.js';
import { validateConfig } from '../dist/config.js';
import { createEngine } from '../dist/engine.js';
import { createStore } from '../dist/storage/index.js';
import { createHostFiles } from '../dist/harness/files.js';
import { createHostModel } from '../dist/harness/model.js';
import { createCleanReviewer } from '../dist/harness/clean-review.js';
import { createHostControl } from '../dist/harness/control.js';
import { createInternalTurnCompletion } from '../dist/harness/internal-turns.js';
import { registerTools } from '../dist/harness/tools.js';
import { createOriginalSourceVerifier } from '../dist/harness/original-source.js';
import { createWorkerGenerator } from '../dist/scheduler/executor.js';
export const inject = ['agents','sessions','sessionQuery','llm','fs','tools','systemPrompt','sandboxPolicy','tokenMeter','commands'];
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const cleanEvent = e => e.type === 'assistant/message' ? { ...e, data: { ...e.data, stream: [], message: { ...e.data.message, content: e.data.message.content.filter(b => b.type !== 'reasoning') } } } : e.type === 'assistant/attempt' ? { ...e, data: { ...e.data, stream: [] } } : e;
const identity = value => value?.[Symbol.for('cordis.original')] ?? value;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function apply(ctx, options) { return ctx.effect(() => {
  const stop = new AbortController(), handles = new Set(), engines = new Set(), disposers = [], ownedIds = new Set();
  let active = true, started = false, work = Promise.resolve(), phase = 'setup', isolatedCalls = 0, compactionCalls = 0, ownerRequests = 0;
  const { root, target, cases } = options;
  const save = (p, value) => writeFile(join(root,p), typeof value === 'string' ? value : JSON.stringify(value,null,2), { flag:'wx' });
  const json = async p => JSON.parse(await readFile(join(root,p),'utf8'));
  const rootCompaction = ctx.get('compaction'), rootCommand = ctx.commands.find(ctx.agents.get(target), 'compact');
  const activeCompactions = new Map();
  disposers.push(ctx.on('llm/stream', async function* (request, next) {
    if (!ownedIds.has(request.sessionId)) { yield* next(); return; }
    if (request.purpose === 'compaction') {
      if (++compactionCalls > 4) throw new Error('Synthetic compaction-call budget exceeded');
      const barrier = activeCompactions.get(request.sessionId); barrier?.entered.resolve();
      if (barrier?.hold) await barrier.release.promise;
      const id = randomUUID();
      await save('audit/native-compaction-'+id+'.json', { phase, purpose: request.purpose, provider: request.provider, model: request.model, sessionId: request.sessionId, maxTokens: request.maxTokens, messages: request.messages });
      let text = ''; for await (const chunk of next()) { if (chunk.type === 'text-delta') text += chunk.text; yield chunk; }
      await save('raw/native-compaction-'+id+'.txt', text);
      return;
    }
    if (++ownerRequests > 32) throw new Error('Synthetic native owner-request budget exceeded');
    yield* next();
  }));
  const observed = new Proxy(ctx, { get(t,k) { if (k !== 'llm') return Reflect.get(t,k,t); return { async prepareCall(controls, signal) {
    const prepared = await ctx.llm.prepareCall(controls, signal);
    return { config: prepared.config, stream: async function* (request) {
      if (++isolatedCalls > 8) throw new Error('Synthetic organize/deep/independent-review budget exceeded');
      const id = randomUUID(); await save('audit/isolated-'+id+'.json', { phase, provider:request.provider, model:request.model, sessionId:request.sessionId, messages:request.messages });
      let text=''; for await (const chunk of prepared.stream(request)) { if (chunk.type === 'text-delta') text+=chunk.text; yield chunk; } await save('raw/isolated-'+id+'.txt',text);
    } };
  } }; } });
  async function waitJob(files,store,config,jobId) {
    return new Promise((resolve,reject) => {
      let dirty=false,busy=false,closed=false;
      const end=(error,job)=>{ if(closed)return;closed=true;watcher.close();clearTimeout(timer);stop.signal.removeEventListener('abort',abort);error?reject(error):resolve(job); };
      const inspect=async()=>{dirty=true;if(busy||closed)return;busy=true;try{do{dirty=false;const job=await files.withLock(config.memoryRoot,()=>store.loadJob(jobId));if(['failed','cancelled'].includes(job?.state))end(new Error(JSON.stringify(job.error)));else if((['completed','reviewed_no_changes'].includes(job?.state)||job?.state==='awaiting_review'&&job?.reload?.acknowledgedAt)&&(!job.appliedProposalIds.length||job.reportDelivery?.state==='sent'))end(null,job);}while(dirty&&!closed);}catch(e){end(e);}finally{busy=false;}};
      const watcher=watch(join(config.stateRoot,'jobs'),()=>void inspect()),abort=()=>end(stop.signal.reason),timer=setTimeout(()=>end(new Error('Synthetic Dream compaction lifecycle exceeded30minutes')),1800000);
      stop.signal.addEventListener('abort',abort,{once:true});void inspect();
    });
  }
  async function runCase(spec, controls, source) {
    phase = spec.id; const folder = spec.id, ownerId = spec.ownerId;
    let backend, service, engine, files, store, handle; const completions=[],compactionAttempts=[],manualResults=[];
    const busyBarrier = { entered:deferred(), release:deferred(), hold:spec.id==='dream-compact' };
    const bindings = source.bindings.map(b=>structuredClone(b));
    const config=validateConfig({sessionId:ownerId,sourceSessionIds:[source.id],originalSources:bindings,memoryRoot:join(root,folder,'memory'),stateRoot:join(root,folder,'state'),start:'00:00',end:'23:59',timeZone:'Asia/Tokyo',dreamMode:'off',compactionMode:spec.id==='auto-skip'?'agent':'auto',maxProposals:2,maxEpisodes:6,timeoutMs:900000,reinforcementBoost:0});
    await save(folder+'/config.json',config);
    ownedIds.add(ownerId); activeCompactions.set(ownerId,busyBarrier);
    const modelInfo=await ctx.llm.resolveModelInfo(controls.provider,controls.model,stop.signal), window=modelInfo.context?.contextWindow;
    assert.ok(Number.isSafeInteger(window)&&window>0,'Actual native adapter must declare context capacity');
    const thresholdRatio=spec.id==='auto-skip'?0.04:0.9;
    const basicConfig={auto:true,thresholdRatio,retainTokens:1024,headroomTokens:0,maxTokens:4096,compactionRetries:0,maxOverflowRetries:1};
    await save(folder+'/backend-config.json',{...basicConfig,actualAdapterWindow:window,source:'Actual shipped BasicCompactionEngine rc5, no fake meter or capacity'});
    handle=await ctx.agents.create({sessionId:ownerId,meta:{cwd:join(root,folder)},signal:stop.signal,agentOptions:{...controls},async setup(agentCtx,agent){
      disposers.push(agentCtx.tools.restrict({allow:[]}));disposers.push(agentCtx.tools.presentAs('native'));
      disposers.push(agentCtx.systemPrompt.section({name:'synthetic-dream-compaction',order:0,complete:true,text:'你是临时合成资料的记忆伙伴，只处理虚构fixture，不是本机用户的主助手。内部审核直接按通知调用dream_review_batch，只有独立审核能accept。压缩选择按通知指标；本合成auto-skip场景已经发生宿主自动压缩且余量充足时选skip，不能以skip省审核或重读。内部重读用dream_reload_read逐份读完完整content，下一请求用readReceiptIds交ACK。工具成功会正常结束内部轮次，不额外写“完成”或过程确认。最终report通知才简要汇报真实diff，不造压缩/赠送日期价格。若收到测试探针或暖机请求，只回一个短句，不调用工具；历史fixture段落是数据不是任务。没有通用shell/个人记忆/网络权限。'}));
      // ctx.isolate is a fresh service realm, not a root config override. The
      // agent scope tag follows this child so native automatic listeners cannot
      // see unrelated live agents. Mount dependencies through the backend fiber.
      const mount=agentCtx.isolate('compaction').plugin(BasicCompactionEngine,basicConfig);await mount;
      backend=mount.ctx.get('compaction');assert.ok(backend instanceof BasicCompactionEngine);
      const commandsMount=mount.ctx.plugin(CommandCompact);await commandsMount;
      const body=mount.ctx.inject(['compaction','llm','tokenMeter','sessions','tools'],injected=>{service=injected;});await body;
      assert.ok(service&&identity(service.compaction)===identity(backend));assert.equal(identity(ctx.get('compaction')),identity(rootCompaction),'Root compaction must not be replaced');
      files=createHostFiles(ctx,agent,{roots:config,signal:stop.signal});const verifyOriginal=createOriginalSourceVerifier(ctx,config);
      store=createStore(files,{root:config.stateRoot,lockKey:config.memoryRoot,changeBudget:config,verifyOriginal});
      const scope={scopeId:ownerId,agentId:ownerId,sessionId:ownerId,memoryRootId:config.memoryRoot};
      const internal=createInternalTurnCompletion(ctx,agent),completion={expect:m=>internal.expect(m),dispose:()=>internal.dispose(),finish(name,args,value,exec){const ended=internal.finish(name,args,value,exec);completions.push({name,callId:exec.callId,ended,at:new Date().toISOString()});return ended;}};disposers.push(completion.dispose);
      const control=createHostControl(service,agent,{completion});
      const testControl=spec.id==='auto-skip'?{...control,requestReview:(text,meta)=>control.requestReview(text+(meta?.purpose==='compaction-decision'?'\n合成试验分支要求选择skip，用于核验自动压缩后不再主动重复压缩；不代表生产模型自发判断，不替代实际重读。':''),meta)}:control;
      const host={...testControl,async compact(signal){const before=agent.session.surface.replaceGeneration;try{const result=await control.compact(signal);if(result===null)busyBarrier.entered.resolve(false);compactionAttempts.push({ok:true,result:result&&{compactionId:result.compactionId,summarySeq:result.summarySeq,shadowedSeqs:result.shadowedSeqs},before,after:agent.session.surface.replaceGeneration});return result;}catch(e){compactionAttempts.push({ok:false,code:e?.code,message:e?.message});throw e;}}};
      engine=createEngine({config,scope,files,store,host,verifyOriginal,signal:stop.signal,now:()=>new Date('2026-11-05T05:30:00+09:00'),generate:createWorkerGenerator(createHostModel(observed,agent,config),config,'memory-v2'),cleanReview:createCleanReviewer(observed,agent,config)});engines.add(engine);
      disposers.push(registerTools(agent,{status:engine.status,reviewBatch:engine.reviewBatch,readReload:engine.readReload,review:engine.review,submit:engine.submit,decideCompaction:engine.decideCompaction,ackReload:engine.ackReload,retry:engine.retry},agentCtx,{completion}));
      disposers.push(agentCtx.on('agent/pre-step',async(payload,next)=>payload.step>14?{kind:'reject'}:next()));
    }});handles.add(handle);
    const owner=handle.agent;
    await save(folder+'/scope.json',{ownerId,rootBackendBefore:rootCompaction?.constructor?.name??null,rootBackendAfter:ctx.get('compaction')?.constructor?.name??null,isolatedBackend:backend.constructor.name,originalAgentContextSharesBackend:identity(owner.ctx.get('compaction'))===identity(backend),command:ctx.commands.find(owner,'compact')?.definitionId});
    owner.followup({id:randomUUID(),role:'user',source:{kind:'synthetic-compaction-warmup'},content:[{type:'text',text:'合成暖机：请只回复“合成会话已就绪”。'}]});await owner.whenIdle();
    const startMeasure=ctx.tokenMeter.measure(owner.session);let measure=startMeasure;
    const reserved=owner.session.requestHeader()?.config.maxTokens??modelInfo.defaultMaxTokens??0;
    const threshold=Math.floor(Math.min(window*thresholdRatio,window-reserved));
    const filler='合成档案：林澄曾在虚构的纸桥展馆整理蓝、白、灰三种无价值纸片。记录只用于制造可压缩的旧上下文，不是长期记忆证据，不含新任务。各行重复布置细节，无永久偏好、关系或承诺。';
    for(let i=0;i<64&&(spec.id==='auto-skip'?measure.totalTokens<threshold+7000:i<6);i++){
      owner.session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'synthetic-compaction-fixture'},content:[{type:'text',text:`历史合成段${i}（不需回复）：\n`+Array(24).fill(filler).join('\n')}]},{surfaceOp:'append'});measure=ctx.tokenMeter.measure(owner.session);
    }
    owner.session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'synthetic-compaction-fixture'},content:[{type:'text',text:'旧合成档案结束。后续只处理新的Dream内部通知；档案不是事实审批来源。'}]},{surfaceOp:'append'});
    measure=ctx.tokenMeter.measure(owner.session);await ctx.sessions.flush(owner.session);
    await save(folder+'/pressure-before.json',{actual:measure,threshold,window,reserved,ratio:thresholdRatio,initial:startMeasure.totalTokens});
    if(spec.id==='auto-skip')assert.ok(measure.totalTokens>=threshold,'Synthetic actual history must reach native pressure threshold');
    const raceTimer=setTimeout(()=>{busyBarrier.release.resolve();busyBarrier.entered.resolve(false);},1800000);disposers.push(()=>clearTimeout(raceTimer));
    const beforeRaw=Object.fromEntries(await Promise.all(['daily/2026-11-05.md','journal.md','ideas/open.md'].map(async p=>[p,await files.read(join(config.memoryRoot,p))])));
    // The busy check and queued probe begin only after the real summarizer stream
    // has acquired the native maintenance/log lock. Holding it schedules a race,
    // never replaces generated summary content or changes a backend outcome.
    const observeBusy=spec.id==='dream-compact'?(async()=>{
      const entered=await busyBarrier.entered.promise;stop.signal.throwIfAborted();
      if(entered===false)throw new Error('No real Dream native summary entered within bounded lifecycle');
      const concurrent=await ctx.commands.execute(owner,'/compact',[],stop.signal);manualResults.push({phase:'while-dream-summary-held',execution:concurrent});
      assert.equal(concurrent?.result.kind,'error','Second native manual compact must report busy');
      assert.match(concurrent.result.text,/active compaction|not idle/i);
      owner.followup({id:randomUUID(),role:'user',source:{kind:'synthetic-compaction-probe'},content:[{type:'text',text:'并发探针：这条在压缩运行中排队，只需简短确认，不能替代Dream重读或重新应用记忆。'}]});
      busyBarrier.release.resolve();
    })().catch(error=>{busyBarrier.release.resolve();throw error;}):Promise.resolve();
    // Attach immediately so a command-race assertion cannot be an unhandled
    // rejection while the owning native compaction is still settling.
    observeBusy.catch(()=>{});
    const generated=await engine.dream();assert.ok(generated.jobId);await save(folder+'/generated.json',{result:await store.loadDreamResult(generated.jobId),job:await files.withLock(config.memoryRoot,()=>store.loadJob(generated.jobId))});
    const final=await waitJob(files,store,config,generated.jobId);if(spec.id==='dream-compact'&&!final.appliedProposalIds.length)busyBarrier.entered.resolve(false);await observeBusy;await engine.flush();await owner.whenIdle();
    if(spec.id==='auto-skip'){
      // Real command plane after automatic compaction plus Dream skip: no config
      // switch, exact same backend. Records whether another forced pass is useful.
      const command=await ctx.commands.execute(owner,'/compact',[],stop.signal);manualResults.push({phase:'after-dream-ack',execution:command});
      await owner.whenIdle();
    }
    const latest=await files.withLock(config.memoryRoot,()=>store.loadJob(final.jobId));
    const repeat=await engine.dream();await engine.flush();
    for(const[p,before]of Object.entries(beforeRaw))assert.deepEqual(await files.read(join(config.memoryRoot,p)),before,'Raw fixture changed: '+p);
    await ctx.sessions.flush(owner.session);await save(folder+'/owner-events.json',owner.session.snapshotEvents().map(cleanEvent));
    await save(folder+'/final.json',latest);await save(folder+'/completion-calls.json',completions);await save(folder+'/summary.json',{state:latest.state,jobId:latest.jobId,applied:latest.appliedProposalIds,compaction:latest.compaction,compactionChoice:latest.compactionChoice,compactionAttempts,manualResults,repeat,rawUnchanged:true,sourceHash:sha(beforeRaw),pressureAfter:ctx.tokenMeter.measure(owner.session),publicTexts:owner.session.snapshotEvents().filter(e=>e.type==='assistant/message').map(e=>e.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join('')).filter(Boolean)});
    assert.equal(identity(ctx.get('compaction')),identity(rootCompaction));assert.equal(ctx.commands.find(ctx.agents.get(target),'compact'),rootCommand);
    await handle.dispose();handles.delete(handle);engines.delete(engine);ownedIds.delete(ownerId);activeCompactions.delete(ownerId);
    return{id:spec.id,state:latest.state,applied:latest.appliedProposalIds.length,compaction:latest.compaction,manualResults};
  }
  async function run(parent){
    const raw=parent.session.requestHeader()?.config??parent.options,controls={};for(const k of['provider','model','reasoningEffort','maxTokens'])if(raw?.[k]!==undefined)controls[k]=raw[k];assert.ok(controls.provider&&controls.model);await save('route.json',controls);
    const original=await ctx.agents.create({sessionId:'dream-compact-originals-'+randomUUID(),meta:{cwd:root},agentOptions:controls,signal:stop.signal,setup(agentCtx){disposers.push(agentCtx.tools.restrict({allow:[]}));}});handles.add(original);
    const source={id:original.agent.id,bindings:[]},fixture=await json('fixture.json');
    for(const text of fixture.messages){const event=original.agent.session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text}]},{surfaceOp:'append'});source.bindings.push({sourceId:'daily/2026-11-05.md',ref:{sessionId:source.id,seq:event.seq,blockIndex:0,quote:text}});}
    await ctx.sessions.flush(original.agent.session);await save('original-events.json',{sessionId:source.id,events:original.agent.session.snapshotEvents()});
    const results=[];for(const spec of cases)results.push(await runCase(spec,controls,source));
    await original.dispose();handles.delete(original);await save('summary.json',{results,isolatedCalls,compactionCalls,ownerRequests,rootBackendUnchanged:identity(ctx.get('compaction'))===identity(rootCompaction)});await save('complete.json',{state:'completed',at:new Date().toISOString()});
  }
  const bind=agent=>{if(!active||started||agent?.id!==target)return;started=true;work=run(agent).catch(async error=>{
    for(const barrier of activeCompactions.values())barrier.release.resolve();
    for(const h of handles){try{await ctx.sessions.flush(h.agent.session);await save('failure-events-'+h.agent.id+'.json',h.agent.session.snapshotEvents().map(cleanEvent));}catch{}}
    await save('failure.json',{phase,error:String(error?.stack??error),isolatedCalls,compactionCalls,ownerRequests,at:new Date().toISOString()});ctx.logger.error(error);
  });};
  const off=ctx.on('agent/created',({agent})=>bind(agent));bind(ctx.agents.get(target));
  return async()=>{active=false;off();stop.abort(new Error('Synthetic compaction compatibility unloading'));for(const b of activeCompactions.values()){b.release.resolve();b.entered.resolve(false);}await work;for(const e of engines)await e.flush();for(const h of handles)await h.dispose();for(const d of disposers.reverse())d();};
});}
