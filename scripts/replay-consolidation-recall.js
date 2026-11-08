// Re-evaluate frozen real trial snapshots/jobs with current retrieval code only;
// no model calls, file collection, old approvals reused for new writes or reroll.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { recallMemory } from '../dist/dream/recall.js';
const root=resolve(process.argv[2]??'');assert.ok(root.includes('/tests/.tmp/consolidation-recall-live-'));
const json=async p=>JSON.parse(await readFile(join(root,p),'utf8')),fixture=await json('fixture-gold.json'),job=await json('final-job.json');
const out=join(root,process.argv[3]??'final-code-replay');await mkdir(out);const rows=[];
for(const label of['before','after','day7']){const snapshot=await json('recall/'+label+'-snapshot.json');for(const q of fixture.queries){for(const mode of['flat','grouped','linked']){const opts={now:new Date(label==='day7'?'2026-11-12T05:30:00+09:00':'2026-11-05T05:30:00+09:00'),boost:0,...(mode==='flat'?{aggregate:false,useRelations:false}:mode==='grouped'?{useRelations:false}:{})};
 const r=recallMemory(snapshot,label==='before'?[]:[job],[],q.request,opts);await writeFile(join(out,`${label}-${q.id}-${mode}.json`),JSON.stringify(r,null,2),{flag:'wx'});
 rows.push({label,query:q.id,mode,hits:r.hits.length,groups:r.coverage.grouping?.groups??null,collapsed:r.coverage.grouping?.collapsedHits??0,relations:r.relations?.length??0,bytes:Buffer.byteLength(JSON.stringify(r)),hitsSummary:r.hits.map(h=>({sourceId:h.sourceId,text:h.text,members:h.group?.memberCount??1,role:h.consolidation?.role??null,applicabilityMatch:h.consolidation?.applicabilityMatch??null})),disabled:r.coverage.relations?.diagnostics??[]});
}}}await writeFile(join(out,'summary.json'),JSON.stringify({meaning:'Deterministic current-code replay of immutable actually observed Host snapshots/reviews/commit/reload; not a fresh live query and not current original-source verification',rows},null,2),{flag:'wx'});console.log(JSON.stringify(rows.filter(r=>r.query==='pot-correction').map(({disabled,...r})=>r),null,2));
