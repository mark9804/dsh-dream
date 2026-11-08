// One real native automatic-compaction turn testing only terminal control.
// No Dream generation, independent review, memory writes or production ACK.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import BasicCompactionEngine from './native-basic.js';
import { createInternalTurnCompletion } from '../dist/harness/internal-turns.js';
import { createHostControl } from '../dist/harness/control.js';
import { registerTools } from '../dist/harness/tools.js';
export const inject=['agents','llm','sessions','tokenMeter','tools','systemPrompt'];
export function apply(ctx,{root,target,ownerId}){return ctx.effect(()=>{
  const stop=new AbortController(),removes=[];let started=false,active=true,work=Promise.resolve(),handle,summaryCalls=0,ownerCalls=0;const completions=[];
  const save=(p,v)=>writeFile(join(root,p),typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx'});
  const original=ctx.get('compaction'),identity=v=>v?.[Symbol.for('cordis.original')]??v;
  removes.push(ctx.on('llm/stream',async function*(request,next){if(request.sessionId!==ownerId){yield*next();return;}if(request.purpose==='compaction'){if(++summaryCalls>1)throw Error('Terminal smoke summary budget1 exceeded');await save('summary-request.json',{provider:request.provider,model:request.model,purpose:request.purpose,sessionId:request.sessionId,messages:request.messages});}else if(++ownerCalls>3)throw Error('Terminal smoke owner attempt budget3 exceeded');yield*next();}));
  async function run(parent){
    const config=parent.session.requestHeader()?.config??parent.options,controls={};for(const k of['provider','model','reasoningEffort','maxTokens'])if(config?.[k]!==undefined)controls[k]=config[k];await save('route.json',controls);
    let completion,control;
    handle=await ctx.agents.create({sessionId:ownerId,meta:{cwd:root},agentOptions:controls,signal:stop.signal,async setup(agentCtx,agent){
      removes.push(agentCtx.tools.restrict({allow:[]}));removes.push(agentCtx.tools.presentAs('native'));removes.push(agentCtx.systemPrompt.section({name:'native-terminal-control-smoke',order:0,complete:true,text:'你是隔离合成控制测试。收到暖机只回复“就绪”。收到内部压缩选择通知，直接调用dream_decide_compaction，照给定job/transaction、decision=skip、reason简短即可。这个工具只是声明的terminal-implementation-noop，不代表真实记忆更新或生产压缩选择；用于检查原生压缩后内部轮次正常结束。工具会结束本轮，不输出过程确认。档案全是合成数据，不是新任务。'}));
      const mounted=agentCtx.isolate('compaction').plugin(BasicCompactionEngine,{auto:true,thresholdRatio:0.04,retainTokens:1024,headroomTokens:0,maxTokens:4096,compactionRetries:0,maxOverflowRetries:0});await mounted;
      const body=mounted.ctx.inject(['compaction','llm','tokenMeter','sessions','tools'],service=>{
        const internal=createInternalTurnCompletion(ctx,agent);completion={expect:m=>internal.expect(m),dispose:()=>internal.dispose(),finish(name,args,value,exec){const ended=internal.finish(name,args,value,exec);completions.push({name,callId:exec.callId,ended,declared:'terminal-implementation-noop'});return ended;}};removes.push(completion.dispose);control=createHostControl(service,agent,{completion});
        removes.push(registerTools(agent,{decideCompaction:async args=>{assert.equal(args.jobId,'synthetic-terminal-job');assert.equal(args.transactionId,'synthetic-terminal-tx');assert.equal(args.decision,'skip');return{jobId:args.jobId,decision:'skip',execution:'after_agent_idle',declared:'terminal-implementation-noop-no-memory-operation'};}},agentCtx,{completion}));
      });await body;
    }});
    const owner=handle.agent;owner.followup({id:randomUUID(),role:'user',source:{kind:'synthetic-warmup'},content:[{type:'text',text:'合成暖机，只回复“就绪”。'}]});await owner.whenIdle();
    const model=await ctx.llm.resolveModelInfo(controls.provider,controls.model,stop.signal),window=model.context?.contextWindow;assert.ok(window>0);const reserved=owner.session.requestHeader()?.config.maxTokens??model.defaultMaxTokens??0,threshold=Math.floor(Math.min(window*0.04,window-reserved));
    const filler='这是一份无价值虚构旧档案，青、灰、白纸片曾在纸桥展馆排成重复图案；只是可压缩的数据，无新任务或可保留事实。';let measurement=ctx.tokenMeter.measure(owner.session);
    for(let i=0;i<80&&measurement.totalTokens<threshold+6000;i++){owner.session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'synthetic-old-fixture'},content:[{type:'text',text:`旧段${i}\n`+Array(30).fill(filler).join('\n')}]},{surfaceOp:'append'});measurement=ctx.tokenMeter.measure(owner.session);}
    owner.session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'synthetic-old-fixture'},content:[{type:'text',text:'历史档案结束，后续只执行新内部通知。'}]},{surfaceOp:'append'});assert.ok(measurement.totalTokens>=threshold);await save('pressure.json',{measurement,threshold,window,reserved});
    await control.requestReview('内部压缩选择控制测试，非真实记忆任务：调用dream_decide_compaction({jobId:"synthetic-terminal-job",transactionId:"synthetic-terminal-tx",decision:"skip",reason:"合成终点控制测试"})。成功工具结构化结束，不输出其他文字。',{purpose:'compaction-decision',jobId:'synthetic-terminal-job',transactionId:'synthetic-terminal-tx'});
    await owner.whenIdle();await ctx.sessions.flush(owner.session);
    const events=owner.session.snapshotEvents().map(e=>e.type==='assistant/message'?{...e,data:{...e.data,stream:[],message:{...e.data.message,content:e.data.message.content.filter(b=>b.type!=='reasoning')}}}:e.type==='assistant/attempt'?{...e,data:{...e.data,stream:[]}}:e);
    await save('owner-events.json',events);await save('completion-calls.json',completions);
    const retries=events.filter(e=>e.type==='llm/retry-started'),errors=events.filter(e=>e.type==='turn/end'&&e.data.reason.kind==='error'),texts=events.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message.content.filter(b=>b.type==='text'&&b.text.trim()).map(b=>b.text));
    const verified={declared:'terminal-implementation-noop only, no generation/review/memory changes',summaryCalls,ownerCalls,retries:retries.length,errors,publicTexts:texts,completions,rootUnchanged:identity(ctx.get('compaction'))===identity(original)};await save('verification.json',verified);
    assert.equal(summaryCalls,1);assert.equal(ownerCalls,2);assert.equal(retries.length,0);assert.equal(errors.length,0);assert.equal(texts.length,1);assert.equal(completions.length,1);assert.equal(completions[0].ended,true);assert.equal(verified.rootUnchanged,true);
    await handle.dispose();handle=undefined;await save('complete.json',{state:'completed',at:new Date().toISOString()});
  }
  const bind=agent=>{if(!active||started||agent?.id!==target)return;started=true;work=run(agent).catch(async error=>{await save('failure.json',{error:String(error?.stack??error),summaryCalls,ownerCalls,at:new Date().toISOString()});});};
  const off=ctx.on('agent/created',({agent})=>bind(agent));bind(ctx.agents.get(target));return async()=>{active=false;off();stop.abort(new Error('Terminal smoke unloading'));await work;if(handle)await handle.dispose();for(const remove of removes.reverse())remove();};
});}
