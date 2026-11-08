// Keep frozen automatic scores intact; aggregate only and expose all model answers.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root=resolve(process.argv[2]??'');assert.ok(root.includes('/tests/.tmp/long-recall-eval-'));
const json=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
const manifest=await json('manifest.json'),gold=await json('gold.json');const records=await Promise.all(manifest.items.map(i=>json('answers/'+i.id+'.json')));
const labels=['raw-current','consolidated-current','raw-history','consolidated-history'];
const summary=labels.map(label=>{const rows=records.filter(r=>`${r.arm}-${r.mode}`===label),scored=rows.filter(r=>r.score);return{label,total:rows.length,executionErrors:rows.filter(r=>r.executionError).length,parseErrors:rows.filter(r=>r.parseError).length,evidenceFound:scored.filter(r=>r.score.anchorsTotal>0&&r.score.evidenceFound).length,evidenceQuestions:gold.cases.filter(c=>c.retrievalAnchors.length>0).length,answerFactsPass:scored.filter(r=>r.score.answerFactsPass).length,strictAnswerPass:scored.filter(r=>r.score.answerPass).length,citationValid:scored.filter(r=>r.score.citationValid).length,certaintyCorrect:scored.filter(r=>r.score.certaintyCorrect).length,meanLatencyMs:rows.reduce((n,r)=>n+r.latencyMs,0)/rows.length};});
await writeFile(join(root,'automatic-summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});
const out=[];for(const item of gold.cases){out.push(`## ${item.id}: ${item.question}`);for(const label of labels){const r=records.find(r=>r.caseId===item.id&&`${r.arm}-${r.mode}`===label);out.push(`\n### ${label}\n${r.answer?.answer??r.parseError??r.executionError}\ncertainty=${r.answer?.certainty}; auto=${JSON.stringify({facts:r.score?.answerFactsPass,strict:r.score?.answerPass,missing:r.score?.missingFacts,forbidden:r.score?.forbiddenFactsHit,numbers:r.score?.unsupportedNumbers})}`);}}await writeFile(join(root,'all-answers-for-review.md'),out.join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify(summary,null,2));
