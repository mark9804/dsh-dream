import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
const repo=resolve(import.meta.dirname,'..'),root=resolve(process.argv[2]??''),replay=process.argv[3];assert.ok(root.includes('/tests/.tmp/continuity-host-'));
const json=async p=>JSON.parse(await readFile(join(root,p),'utf8')),fixture=await json('fixture-gold.json'),baseline=await json('baseline.json'),verification=await json('verification.json');
const f=(v,lang='json')=>['```'+lang,typeof v==='string'?v:JSON.stringify(v,null,2),'```',''],link=(label,p)=>`[${label}](<${relative(join(repo,'docs'),join(root,p))}>)`;
const lines=['# 连续三晚整理与自主回忆：合成完整实录','',
'全部人物/经历虚构，不是用户本人。真实临时AgentLoop、独立模型审核、实际合成文件事务/重读。三晚与day7是模拟时钟，12次问答各自冷启动，flat/linked两臂同最终文件，不把检索排序当真伪。','',
link('试验配置','manifest.json')+' · '+link('机械核验','verification.json')+' · '+link('真实临时AgentLoop公开事件（剔除reasoning流）','owner-events-final.json'),'',
'## 机械核验概况','',...f({artifact:verification.artifact,checks:verification.checks,proofs:verification.proofs,rawInputsUnchanged:verification.rawInputsUnchanged,calls:verification.calls,sizes:verification.sizes}),'## 初始文件全文',''];
for(const[p,text]of Object.entries(baseline))lines.push('### '+p,'',...f(text,'markdown'));
for(const night of fixture.nights){const generated=await json('generated/'+night.id+'.json'),job=await json('final/'+night.id+'.json');lines.push('## '+night.id+' / '+night.day,'','### 本晚新增用户原话','',...f(night.messages.join('\n\n'),'text'),'### ORGANIZE索引','',...f(generated.result.digest));
 for(const proposal of job.proposals)lines.push('### 提案 '+proposal.proposalId,'',...f(proposal),'独立审核（完整理由与authority，不含重复全文basis）：','',...f(job.reviews.filter(r=>r.proposalId===proposal.proposalId).map(r=>({reviewId:r.reviewId,decision:r.decision,reason:r.reason,authority:r.authority,reviewedAt:r.reviewedAt}))),`实际写入：${job.appliedProposalIds.includes(proposal.proposalId)}`,'');
 lines.push('### 实际事务与历史回执','',...f(job.transactionHistory),'### 同素材再运行','',...f(await json('repeat/'+night.id+'.json')),'### 本晚最终长期文件','',...f(await readFile(join(root,'memory-'+night.id+'.md'),'utf8'),'markdown'));
}
lines.push('## 自主冷问答完整输出','',
'模型自行决定是否调用和查询词。gold只在fixture-gold.json与本报告核对使用，不提供给答案调用。flat关闭聚合/关系，linked为该实测冻结包的新查询路径；未为理想答案重抽。','');
for(const q of fixture.questions){lines.push('### '+q.id,'',q.question,'');for(const mode of['flat','linked']){const folder='answer-'+mode+'-'+q.id,r=await json('answers/'+folder+'/result.json');lines.push('#### '+mode,'',...f(r.answer??{state:r.state,reason:r.reason},'text'),'实际工具调用与查询参数：','',...f(r.trace.flatMap(step=>step.response.calls).map(c=>({name:c.name,arguments:JSON.parse(c.arguments)}))),link('完整回答与trace','answers/'+folder+'/result.json'),'');}}
lines.push('## 生产followup驱动的公开文字','',...f(verification.owner.publicMessages.join('\n\n'),'text'),'## 检索逐项对照','',replay?'下列为最终代码冻结原文/事务回放；原始live结果仍位于recall目录，不覆盖。':'下列为原始live结果。','');
for(const label of['before',...fixture.nights.map(n=>n.id),'day7'])for(const q of fixture.queries){lines.push('### '+label+' / '+q.id,'');for(const mode of['flat','grouped','linked']){const path=(replay??'recall')+'/'+label+'-'+q.id+'-'+mode+'.json',r=await json(path);lines.push('#### '+mode,'',...f({hits:r.hits,relations:r.relations,coverage:r.coverage}),link('完整检索证据',path),'');}}
lines.push('[实现、失败与限制报告](<continuity-nights-2026-11-05.md>)','');const target=join(repo,'docs/continuity-nights-content-2026-11-05.md');await writeFile(target,lines.join('\n')+'\n',{flag:'wx'});console.log(JSON.stringify({target,questions:fixture.questions.length,nights:fixture.nights.length},null,2));
