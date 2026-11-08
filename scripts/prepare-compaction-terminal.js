import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
const args=process.argv.slice(2),result=spawnSync(process.execPath,['scripts/prepare-compaction-host.js',...args],{cwd:import.meta.dirname+'/..',encoding:'utf8'});assert.equal(result.status,0,result.stderr);
const prepared=JSON.parse(result.stdout),driver=await readFile(join(import.meta.dirname,'lib/compaction-terminal-driver.js'),'utf8'),entry=join(prepared.bundle,'index.js'),manifestFile=join(prepared.root,'manifest.json');
await readFile(entry,'utf8');const manifest=JSON.parse(await readFile(manifestFile,'utf8')),ownerId='dream-native-terminal-'+randomUUID();
await writeFile(join(prepared.bundle,'lib/compaction-terminal-driver.js'),driver,{flag:'wx'});
await writeFile(entry,`import{apply as run,inject}from'./lib/compaction-terminal-driver.js';export{inject};export const apply=ctx=>run(ctx,${JSON.stringify({root:prepared.root,target:args[1],ownerId})});\n`);
await writeFile(manifestFile,JSON.stringify({...manifest,purpose:'Final checkpoint terminal-control smoke only; declared terminal-implementation-noop, no Dream generation/review or memory transactions.',ownerId,driverSha256:createHash('sha256').update(driver).digest('hex'),paidBudget:'One actual native summary plus two owner model calls(warmup+terminal), hardcap3owner attempts. No generation/review calls.',unusedFixtureDirectories:'auto-skip/dream-compact remain unused preparation data; not evaluated lifecycle cases.'},null,2));
for(const lang of['en','zh']){const file=join(prepared.bundle,'locale',lang+'.json');await readFile(file,'utf8');await writeFile(file,JSON.stringify({meta:{title:lang==='zh'?'Dream 原生压缩检查点终点验收':'Dream native checkpoint terminal-control smoke',description:'One isolated native automatic summary and declared no-memory terminal handler. Tests graceful internal conclusion after a historical checkpoint, not a repeated Dream lifecycle.'}},null,2));}
console.log(JSON.stringify({...prepared,ownerId},null,2));
