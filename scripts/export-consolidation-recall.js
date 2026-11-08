import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
const repo=resolve(import.meta.dirname,'..'),root=resolve(process.argv[2]??'');assert.ok(root.startsWith(join(repo,'tests/.tmp/consolidation-recall-live-')));
const json=async p=>JSON.parse(await readFile(join(root,p),'utf8')),fixture=await json('fixture-gold.json'),baseline=await json('baseline.json'),final=await json('final-memory.json'),job=await json('final-job.json'),v=await json('verification.json');
const target=resolve(repo,process.argv[4]??'docs/consolidation-recall-content-2026-11-05.md'),replayDir=process.argv[3]??'final-code-replay',link=(label,p)=>`[${label}](<${relative(join(repo,'docs'),join(root,p))}>)`,fence=(v,lang='json')=>['```'+lang,typeof v==='string'?v:JSON.stringify(v,null,2),'```',''];
const out=['# 整理去重与纠正召回：完整合成实录','',
'本例全部人物/经历是虚构资料。真实Host模型生成、独立审核、真实合成文件事务提交和重读；没有真实用户记忆或心情数据。原始试验请求不重抽。后续final-code-replay是相同冻结snapshot/job的本地纯检索回放，不冒称新模型或当前原文核验。','',
'## 真实闭环概况','',...fence({state:v.state,realCalls:v.realCalls,provider:v.provider,model:v.model,events:v.organizedEvents,proposals:v.proposals,rawInputsUnchanged:v.rawInputsUnchanged,independentEventsRetained:v.independentEventsRetained,longTermBytesBefore:v.originalLongTermBytes,longTermBytesAfter:v.finalLongTermBytes}),link('provenance','provenance.json')+' · '+link('核验','verification.json')+' · '+link('真实请求目录中的首个请求','audit/'+(await readdir(join(root,'audit'))).filter(n=>n.endsWith('.json'))[0]),'',
'## 输入文件全文',''];for(const[p,text]of Object.entries(baseline))out.push('### '+p,'',...fence(text,'markdown'));
out.push('## 组织/全部提案/独立审核','',...fence((await json('generated-result.json')).digest));for(const p of job.proposals)out.push('### '+p.proposalId,'',...fence(p),'独立审核（包括理由与authority，非生成者摘要）：','',...fence(job.reviews.filter(r=>r.proposalId===p.proposalId).map(r=>({decision:r.decision,reason:r.reason,reviewedAt:r.reviewedAt,authority:r.authority}))),`实际应用：${job.appliedProposalIds.includes(p.proposalId)}`,'');
out.push('## 已提交事务与重读回执','',...fence(job.transaction),...fence(job.reload));
let replay;try{replay=await json(replayDir+'/summary.json');}catch(e){if(e.code!=='ENOENT')throw e;}
out.push('## 同查询整理前/整理后/一周后，三臂对照','',
'flat=原来的逐段topK；grouped=只做完整等价正文展示分组；linked=聚合并利用实际已审核提交关系。以下引用final-code-replay(如存在)，初始live原始结果仍单独保留。','');
for(const label of['before','after','day7'])for(const q of fixture.queries){out.push('### '+label+' / '+q.id,'',...fence(q.request));for(const mode of['flat','grouped','linked']){const name=`${label}-${q.id}-${mode}.json`,dir=replay?replayDir:'recall',r=await json(dir+'/'+name);out.push('#### '+mode,'',...fence({hits:r.hits.map(h=>({sourceId:h.sourceId,text:h.text,score:h.score,proof:h.proof,group:h.group,consolidation:h.consolidation})),relations:r.relations,coverage:r.coverage}),link('完整结果',dir+'/'+name),'');}}
out.push('## 最终文件全文','');for(const[p,text]of Object.entries(final))out.push('### '+p,'',...fence(text,'markdown'));out.push('[实现与边界报告](<consolidation-recall-2026-11-05.md>)','');await writeFile(target,out.join('\n')+'\n',{flag:'wx'});console.log(JSON.stringify({target,proposals:job.proposals.length,applied:job.appliedProposalIds.length},null,2));
