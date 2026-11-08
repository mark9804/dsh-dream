import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
const repo=resolve(import.meta.dirname,'..'),[rootArg,outArg]=process.argv.slice(2),root=resolve(rootArg??'');assert.ok(root.startsWith(join(repo,'tests/.tmp/autonomous-recall-')));
const json=async p=>JSON.parse(await readFile(join(root,p),'utf8')),v=await json(process.argv[4]??'verified-summary.json'),corpus=await json('corpus-gold.json');
let review,map;try{review=await json('blind-review-result.json');map=await json('blind-review-map.json');}catch(e){if(e.code!=='ENOENT')throw e;}
const reviewMap=new Map((review??[]).map(r=>[map[r.id],r]));
const target=resolve(repo,outArg??'docs/autonomous-recall-content-2026-11-04.md');assert.ok(target.startsWith(join(repo,'docs/')));
const link=(label,p)=>`[${label}](<${relative(join(repo,'docs'),join(root,p))}>)`,code=(value,lang='json')=>['```'+lang,typeof value==='string'?value:JSON.stringify(value,null,2),'```',''];
const out=['# 自主回忆提示对照：全部问题、查询、证据与回答','',
'这是合成独立native-tool评估，不是当前用户生活。模型只看中立系统提示、题面与同一工具schema，guided臂另外加通用回忆策略；没有gold或预先指定query。下方所有tool参数与答案由真实模型原样生成，不重抽。原文摘要仅用于导航，完整请求/工具输出另链。','',
'## 两臂成本/行为','',...code(v.summary),'若有盲语义复核，完整性只要求回答题目实际所问；不把缺可选范围提醒计漏答。质性safe是对给出的事实准则判定，不是统计安全保证。','',
link('manifest','manifest.json')+' · '+link('核验与完整逐场指标','verified-summary.json')+' · '+link('模型不可见gold','corpus-gold.json'),'',
'## 基础系统提示','',...code(await readFile(join(root,'base-system.txt'),'utf8'),'text'),'## 唯一策略差异','',...code(await readFile(join(root,'guidance.txt'),'utf8'),'text'),'## 冻结工具定义','',...code(await json('tool-schema.json'))];
for(const c of corpus.cases){out.push('## '+c.id,'',c.question,'','评估准则（没有发给模型）：','',...code(c.gold));for(const arm of['tool-only','guided']){const e=v.episodes.find(e=>e.caseId===c.id&&e.arm===arm);out.push('### '+arm,'',e.answer??'(没有最终回答)', '',...code({state:e.state,modelCalls:e.modelCalls,toolCount:e.toolCount,emptyTools:e.emptyTools,toolErrors:e.toolErrors,firstPromptTokens:e.firstPromptTokens,inputTokens:e.inputTokens,outputTokens:e.outputTokens,latencyMs:e.latencyMs,...(reviewMap.has(e.id)?{blindQualitativeReview:reviewMap.get(e.id)}:{})}));
 const dir='audit/'+e.id,names=await readdir(join(root,dir)),tools=names.filter(n=>n.startsWith('tool-')).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
 for(const n of tools){const t=await json(dir+'/'+n);out.push('#### 工具调用 '+n.replace('.json',''),'',...code({callId:t.call.id,step:t.step,arguments:JSON.parse(t.call.arguments),isError:t.result.isError}));if(t.result.isError)out.push(...code(t.result));else out.push('返回原文与proof：','',...code(t.result.value.hits.map(h=>({sourceId:h.sourceId,sourceRole:h.sourceRole,temporalStatus:h.temporalStatus,text:h.text,proof:h.proof}))), '覆盖/省略：','',...code(t.result.value.coverage));out.push(link('完整工具结果',dir+'/'+n),'');}
 const requests=names.filter(n=>n.startsWith('request-')).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));out.push(requests.map(n=>link('实际请求 '+n,dir+'/'+n)).join(' · '),'',link('逐场原始结果','results/'+e.id+'.json'),'');
 }}
out.push('## 语料全文（合成）','');for(const[path,text]of Object.entries(corpus.memory))out.push('### '+path,'',...code(text,'markdown'));out.push('[方法与结论报告](<autonomous-recall-2026-11-04.md>)','');await writeFile(target,out.join('\n')+'\n',{flag:'wx'});console.log(JSON.stringify({target,episodes:v.episodes.length,answers:v.episodes.filter(e=>e.answer).length,reviewed:reviewMap.size},null,2));
