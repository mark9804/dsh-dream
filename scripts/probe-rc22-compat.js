// Offline adapter regression probe only. No Host, model, network or user files.
// A callable fixture supplies rc.1's documented model.current() surface alongside
// the previous durable header to show whether Dream observes a pending selection.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHostModel } from '../dist/harness/model.js';
import { createCleanReviewer } from '../dist/harness/clean-review.js';
const root=resolve(import.meta.dirname,'../tests/.tmp/rc22-compat');await mkdir(root,{recursive:true});
const old={provider:'synthetic-old-provider',model:'synthetic-old-model',reasoningEffort:'high',maxTokens:1024};
const pending={provider:'synthetic-new-provider',model:'synthetic-new-model'};
const calls=[];const agent={id:'synthetic-only',session:{id:'synthetic-only',requestHeader:()=>({config:structuredClone(old)})},options:{...old},model:{current:()=>structuredClone(pending)}};
function context(text){return{llm:{async prepareCall(config){calls.push(structuredClone(config));return{config,async*stream(){yield{type:'text-delta',index:0,text};yield{type:'finish',reason:{kind:'stop'}};}};}}};}
assert.equal(await createHostModel(context('synthetic-text'),agent)('No factual input; adapter route probe.'),'synthetic-text');
const snapshot={schemaVersion:1,snapshotId:'synthetic',capturedAt:'2026-11-06T00:00:00Z',scope:{scopeId:agent.id,agentId:agent.id,sessionId:agent.id,memoryRootId:'synthetic-memory'},sources:[{sourceId:'memory',path:'long-term.md',role:'longTerm',content:'Synthetic existing fact.\n',version:1,writable:true,sensitivity:'private',protectedText:[]}]};
const proposal={schemaVersion:1,proposalId:'synthetic-p',jobId:'synthetic-j',kind:'fact',text:'Keep synthetic fact',reason:'Route probe only',targetId:'memory',operation:'retain',before:'Synthetic existing fact.\n',after:'Synthetic existing fact.\n',evidence:[{sourceId:'memory',quote:'Synthetic existing fact.'}]};
const review=await createCleanReviewer(context(JSON.stringify({decision:'defer',reason:'Synthetic route probe, not real approval.'})),agent)(snapshot,proposal);assert.equal(review.decision,'defer');
const expected={...pending,maxTokens:1024};assert.deepEqual(calls,[expected,expected]);
const report={kind:'offline-contract-fixture-not-runtime-or-paid-inference',selectionDocumentedByRc1:pending,latestDurableHeader:old,actualGenerationControls:calls[0],actualReviewControls:calls[1],finding:'Fixed adapters follow agent.model.current() pending selection; omitted effort remains Auto. Explicit live AgentOptions output cap is retained. Offline contract proof, not a live paid inference certification.',noHostInstallation:true,noPersonalMemory:true};
await writeFile(join(root,'route-probe-fixed.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
