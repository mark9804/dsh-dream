// Export every preserved answer, exact returned context and automatic/manual scores.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
const repo=resolve(import.meta.dirname,'..'),root=resolve(process.argv[2]??'');assert.ok(root.startsWith(join(repo,'tests/.tmp/long-recall-eval-')));
const json=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
const gold=await json('gold.json'),manifest=await json('manifest.json'),auto=await json('automatic-summary.json'),verification=await json('verification.json');
const review=await json('blind-review-result.json'),map=await json('blind-review-map.json');
assert.ok(Array.isArray(review)&&review.length===32);const checked=new Map(review.map(r=>[map[r.id],r]));assert.equal(checked.size,32);
const labels=['raw-current','consolidated-current','raw-history','consolidated-history'];
const records=await Promise.all(manifest.items.map(i=>json('answers/'+i.id+'.json')));
const semantic=labels.map(label=>{const rows=records.filter(r=>`${r.arm}-${r.mode}`===label),rev=rows.map(r=>checked.get(r.id));return{label,total:rows.length,factComplete:rev.filter(r=>r.factComplete).length,safeAnswer:rev.filter(r=>r.safeAnswer).length,certaintyCorrect:rev.filter(r=>r.certaintyCorrect).length,automaticStrictPass:auto.find(a=>a.label===label).strictAnswerPass};});
await writeFile(join(root,'semantic-summary.json'),JSON.stringify({method:'Arm-blinded model-assisted qualitative review by a separate agent; not human rating, no statistical significance; frozen automatic scores unchanged',summary:semantic},null,2),{flag:'wx'});
const link=(label,p)=>`[${label}](<${relative(join(repo,'docs'),join(root,p))}>)`;const fence=(text,lang='json')=>['```'+lang,text,'```',''];
const out=['# 长期回忆冷测试：完整题目、证据与32份答案','',
'所有人物与材料均为合成；日期模拟而不是等过一周。本页保留全部32个真实独立模型回答，未重抽/改写。两个文件版本来自上轮真实巩固前后资料，两个采集路径为旧三日窗口与新有界历史日记。答案模型只看问题和返回证据；下方gold、评分、语义复核是事后评估，不进入请求。','',
'## 指标分开看','',
'- Evidence=6个有证据问题的全部预注册锚点是否在top4，不含2个unknown。','- 自动pass=预冻结有限短语/否定规则，存在明显正确改写误报，不能当语义正确率。','- 语义完整=另一个agent看随机不透明ID、gold和answer/hits，对原文事实完整性作质性复核；不知道arm/自动分。不是人工标注，也不证明统计显著。','- Safe=没有编造，允许据不足明确拒答；安全拒答不等完整回忆。','',
'| 文件/采集 | 证据齐全 | 自动严格pass | 语义完整 | 安全回答 | certainty标签一致 |','|---|---:|---:|---:|---:|---:|'];
for(const row of semantic){const a=auto.find(a=>a.label===row.label);out.push(`| ${row.label} | ${a.evidenceFound}/${a.evidenceQuestions} | ${row.automaticStrictPass}/8 | ${row.factComplete}/8 | ${row.safeAnswer}/8 | ${row.certaintyCorrect}/8 |`);}
out.push('', '复核局限：来源是合成对话，一道核票题用了“我们”而不是“记录里的阿澄”；历史组正确恢复了当时周五傍晚/具体几点未定，却为避免声称用户现实约定用了unknown。这是题面与certainty接口歧义，不抹成错误事实。梦题也有用supported标签去表达“不能证实事件”的情况，内容安全但标签不一致。','',
link('冻结gold','gold.json')+' · '+link('原自动指标','automatic-summary.json')+' · '+link('盲复核输入','blind-review-input.json')+' · '+link('盲复核结果','blind-review-result.json')+' · '+link('完整核验','verification.json'),'',
'## 试验参数','',...fence(JSON.stringify({realCalls:verification.realCalls,model:verification.model,controls:verification.controls,independentRequests:verification.independentRequestIds,simulatedAsOf:'2026-11-11T12:00:00+09:00',topK:4,boost:0,originalSourceVerification:'file-only in this isolated comparison; prior original receipts not inherited as fresh authority',fixtureScope:'fixed synthetic files; no parent history, dreams, proposals or gold supplied'},null,2)));
for(const item of gold.cases){out.push('## '+item.id,'',item.question,'','评估专用事实（未发送给模型）：','',...fence(JSON.stringify({expected:item.expected,requiredFacts:item.requiredFacts,forbiddenFacts:item.forbiddenFacts,retrievalAnchors:item.retrievalAnchors},null,2)));
 for(const label of labels){const r=records.find(r=>`${r.arm}-${r.mode}`===label&&r.caseId===item.id),rev=checked.get(r.id),recall=await json(r.retrievalPath);out.push('### '+label,'',r.answer?.answer??r.executionError??r.parseError,'',`certainty：${r.answer?.certainty??'未返回'}；引用结构有效：${r.score?.citationValid??false}。`,'','返回原文：','',...fence(JSON.stringify(recall.hits.map(h=>({sourceId:h.sourceId,sourceRole:h.sourceRole,temporalStatus:h.temporalStatus,text:h.text,proof:h.proof})),null,2)),'引用原文：','',...fence(JSON.stringify(r.answer?.citations??[],null,2)),'自动评分（原样）：','',...fence(JSON.stringify(r.score??{executionError:r.executionError,parseError:r.parseError},null,2)),'盲语义复核：','',...fence(JSON.stringify(rev,null,2)),link('真实请求','audit/'+r.id+'.json')+' · '+link('原始模型输出','raw/'+r.id+'.txt')+' · '+link('完整检索结果',r.retrievalPath),'');
 }
}
out.push('## 实现与边界','', '[评估与实现报告](<long-recall-evaluation-2026-11-04.md>)','');
const target=join(repo,'docs/long-recall-content-2026-11-04.md');await writeFile(target,out.join('\n')+'\n',{flag:'wx'});console.log(JSON.stringify({target,semantic},null,2));
