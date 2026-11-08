// Cold deterministic probe: synthetic prior fixtures only, never real memory/state.
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { collectSnapshot } from '../dist/dream/materials.js';
import { recallMemory } from '../dist/dream/recall.js';
import { validateConfig } from '../dist/config.js';
import { createLocalFiles } from '../dist/storage/local-files.js';
const repo=resolve(import.meta.dirname,'..');
const prior=join(repo,'tests/.tmp/memory-v2-live-2026-11-03T20-24-38-543Z');
const baseline=JSON.parse(await readFile(join(prior,'baseline.json'),'utf8')), consolidated=JSON.parse(await readFile(join(prior,'final-memory.json'),'utf8'));
const dir=await mkdtemp(join(repo,'tests/.tmp/recall-probe-'));const local=createLocalFiles(dir);const p=p=>isAbsolute(p)?relative(dir,p):p;
const files={...local,read:(q,o)=>local.read(p(q),o),write:(q,c,v)=>local.write(p(q),c,v),stat:q=>local.stat(p(q)),list:q=>local.list(p(q)),mkdir:q=>local.mkdir(p(q))};
const cases=[{id:'cup',query:'阿澄 红杯子 小河 来历'},{id:'shared',query:'阿澄 末班车 数灯 安心'},{id:'boundary',query:'阿澄 出差 临时计划 额外会面'},{id:'ticket',query:'阿澄 车票 核对 周五 具体几点'},{id:'uncertain',query:'小河 生气 确认'},{id:'incidental',query:'阿澄 午饭 取餐号'},{id:'no-event',query:'阿澄 杯子 价格多少钱'},{id:'paraphrase',query:'那个盛水的礼物是谁送来的'}];
const results={};
for(const[arm,memory]of Object.entries({baseline,consolidated})){
 const root=join(dir,arm,'memory');for(const d of ['daily','ideas'])await files.mkdir(join(root,d));for(const[path,text]of Object.entries(memory))await files.write(join(root,path),text,null);
 const config=validateConfig({sessionId:'synthetic-cold',memoryRoot:root,stateRoot:join(dir,arm,'state'),personaPath:join(root,'AGENTS.md'),timeZone:'Asia/Tokyo'});
 const scope={scopeId:'synthetic-cold',sessionId:'synthetic-cold',agentId:'synthetic-cold',memoryRootId:root};
 for(const day of [0,7,30]){
  const now=new Date(Date.parse('2026-11-04T12:00:00+09:00')+day*86400000);const snap=await collectSnapshot(files,config,scope,{now,snapshotId:`${arm}-day${day}`});
  results[`${arm}/day${day}`]={sourceIds:snap.sources.map(s=>s.sourceId),cases:cases.map(c=>({id:c.id,query:c.query,hits:recallMemory(snap,[],[],{query:c.query,topic:'合成经历',conditions:'只根据当前已存资料回答',limit:4},{now}).hits.map(h=>({sourceId:h.sourceId,text:h.text,score:h.score}))}))};
 }
}
await writeFile(join(dir,'probe.json'),JSON.stringify({synthetic:true,prior,cases,results},null,2),{flag:'wx'});
console.log(JSON.stringify({directory:dir,results},null,2));
assert.equal(results['consolidated/day7'].sourceIds.some(id=>id.startsWith('daily/')),false);
