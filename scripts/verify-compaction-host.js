import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const root=resolve(process.argv[2]??'');assert.ok(root.includes('/tests/.tmp/compaction-host-'));
const json=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
const manifest=await json('manifest.json'),summary=await json('summary.json'),checks=[],details=[];
assert.equal((await json('complete.json')).state,'completed');assert.equal(summary.rootBackendUnchanged,true);
for(const spec of manifest.cases){
  const prefix=spec.id+'/',job=await json(prefix+'final.json'),run=await json(prefix+'summary.json'),events=await json(prefix+'owner-events.json'),scope=await json(prefix+'scope.json'),baseline=await json(prefix+'baseline.json');
  assert.equal(scope.rootBackendBefore,scope.rootBackendAfter);assert.equal(scope.isolatedBackend,'BasicCompactionEngine');assert.equal(scope.originalAgentContextSharesBackend,false);
  const starts=events.filter(e=>e.type==='compaction/start'),ends=events.filter(e=>e.type==='compaction/end'),compactions=[];
  for(const start of starts){const end=ends.find(e=>e.data.compactionId===start.data.compactionId);assert.ok(end,'Native compaction marker must close');compactions.push({id:start.data.compactionId,startSeq:start.seq,endSeq:end.seq,turn:start.data.turn,sourceCommandId:start.data.sourceCommandId??null,error:end.data.error??null});}
  assert.equal(starts.length,ends.length);
  const tools=events.filter(e=>e.type==='tool/call'),results=events.filter(e=>e.type==='tool/result'),toolCounts={};for(const e of tools)toolCounts[e.data.name]=(toolCounts[e.data.name]??0)+1;
  const readCall=tools.find(e=>e.data.name==='dream_reload_read'),ackCall=tools.find(e=>e.data.name==='dream_ack_reload');assert.ok(readCall&&ackCall);
  const readResult=results.find(e=>e.data.message.toolCallId===readCall.data.callId);assert.ok(readResult&&!readResult.data.message.isError);
  const read=JSON.parse(readResult.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
  assert.ok(ackCall.data.step>readCall.data.step&&JSON.parse(ackCall.data.arguments).readReceiptIds.includes(read.readReceiptId));
  const validHistory=job.transactionHistory?.at(-1);assert.ok(validHistory?.writtenSources?.length&&validHistory.reload.acknowledgedAt);
  for(const written of validHistory.writtenSources)assert.ok(validHistory.reload.sources.some(s=>isDeepStrictEqual(s,written)));
  for(const[p,text]of Object.entries(baseline))if(!['long-term.md','decisions.md'].includes(p))assert.equal(await readFile(join(root,prefix,'memory',p),'utf8'),text);
  const longTerm=await readFile(join(root,prefix,'memory/long-term.md'),'utf8');
  checks.push({name:spec.id+'-applied-and-acknowledged',pass:job.appliedProposalIds.length>0&&!!job.reload?.acknowledgedAt},{name:spec.id+'-no-repeated-material-generation',pass:run.repeat.reused===true},{name:spec.id+'-raw-inputs-unchanged',pass:run.rawUnchanged===true},{name:spec.id+'-native-summary-ran',pass:compactions.some(c=>!c.error)},{name:spec.id+'-thermos-correct',pass:longTerm.includes('表哥')&&longTerm.includes('旧货店')});
  if(spec.id==='auto-skip'){
    const pressure=await json(prefix+'pressure-before.json');assert.ok(pressure.actual.totalTokens>=pressure.threshold);
    const auto=compactions.filter(c=>c.turn!==null&&!c.error),choice=tools.find(e=>e.data.name==='dream_decide_compaction');assert.ok(choice);
    checks.push({name:'auto-pressure-before-review',pass:auto.some(c=>c.endSeq<tools.find(e=>e.data.name==='dream_review_batch').seq)},{name:'dream-skip-does-not-disable-host-auto',pass:job.compaction?.status==='skipped'&&job.compactionChoice?.decision==='skip'&&run.compactionAttempts.length===0&&auto.length>=1});
  }else{
    checks.push({name:'dream-native-manual-compaction-completed',pass:job.compaction?.status==='completed'&&run.compactionAttempts.some(a=>a.ok&&a.result?.compactionId===job.compaction.compactionId)},{name:'concurrent-slash-compact-busy',pass:run.manualResults.some(r=>r.phase==='while-dream-summary-held'&&r.execution?.result.kind==='error'&&/active compaction|not idle/i.test(r.execution.result.text))});
    const probe=events.find(e=>e.type==='user/message'&&e.data.source?.kind==='synthetic-compaction-probe'),native=compactions.find(c=>c.id===job.compaction.compactionId);assert.ok(probe&&native);
    checks.push({name:'queued-message-admitted-only-after-native-compact-end',pass:probe.seq>native.endSeq},{name:'reload-and-ack-after-native-compact-end',pass:readCall.seq>native.endSeq&&ackCall.seq>readCall.seq});
  }
  details.push({id:spec.id,state:job.state,proposals:job.proposals.map(p=>({id:p.proposalId,action:p.consolidation?.action,decision:job.reviews.findLast(r=>r.proposalId===p.proposalId)?.decision,applied:job.appliedProposalIds.includes(p.proposalId)})),compaction:job.compaction,compactions,manual:run.manualResults,toolCounts,readSourceIds:read.sources.map(s=>s.sourceId),steps:events.filter(e=>e.type==='step/start').length,retries:events.filter(e=>e.type==='llm/retry-started').length,publicTexts:run.publicTexts,repeat:run.repeat,scope});
}
const audits=(await readdir(join(root,'audit'))).filter(n=>n.endsWith('.json'));
const result={meaning:'Real shipped native BasicCompactionEngine and /compact command in private per-agent service scopes, production Dream engine/review/write/reload/control with fixed clock. Not full preset/scheduler or user profile; auto-skip branch explicitly instructed skip.',artifact:manifest.artifactSha1,checks,pass:checks.filter(c=>c.pass).length,total:checks.length,allPass:checks.every(c=>c.pass),details,calls:{isolated:summary.isolatedCalls,nativeSummaries:summary.compactionCalls,ownerAttempts:summary.ownerRequests,auditFiles:audits.length},rootBackendUnchanged:summary.rootBackendUnchanged,limits:['Model-backed backend does not promise semantic losslessness of conversation summaries. Raw memory and durable original event evidence separately checked.','Automatic pressure threshold lowered only in synthetic private backend; no change to user strategy or declared model capacity.','Automatic and manual compaction can run consecutively; same-session locks prevent concurrent surface replacement, not redundant later requests.','Queued synthetic user probe may share a turn with reload; ordinary turn response is preserved, not filtered.']};
await writeFile(join(root,'verification.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result,null,2));
