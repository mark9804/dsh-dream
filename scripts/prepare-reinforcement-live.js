// Explicit live integration utility. Synthetic files only; never auto-run or publish.
// Usage: node scripts/prepare-reinforcement-live.js ARTIFACT BACKEND SESSION
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const [artifact, backend, sessionId] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');
assert.ok(artifact && isAbsolute(artifact) && resolve(artifact).startsWith(join(root, 'tests/.tmp/package-')));
assert.ok(backend && isAbsolute(backend) && sessionId);
const archive = join(resolve(artifact, '..'), 'dsh-dream-0.1.0.tgz');
const shasum = createHash('sha1').update(await readFile(archive)).digest('hex');
assert.equal(shasum, 'eff868581256aa3543d7313291f6d6c0d2a07ba7', 'Use the verified reinforcement artifact');
const pkg = JSON.parse(await readFile(join(artifact, 'package.json'), 'utf8'));
const run = join(root, 'tests/.tmp', `reinforcement-live-${new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}`);
async function copy(from, to) {
  const stat = await lstat(from); assert.equal(stat.isSymbolicLink(), false);
  if (stat.isDirectory()) { await mkdir(to); for (const name of await readdir(from)) await copy(join(from,name),join(to,name)); }
  else { assert.ok(stat.isFile()); await copyFile(from,to,constants.COPYFILE_EXCL); }
}
const save = (path,data) => writeFile(path,typeof data === 'string' ? data : JSON.stringify(data,null,2),{flag:'wx'});
await mkdir(run);
for (const dir of ['memory','state','audit','bundle']) await mkdir(join(run,dir));
for (const dir of ['daily','ideas']) await mkdir(join(run,'memory',dir));
const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const days = Array.from({length:3},(_,i)=>{const d=new Date(`${today}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-2+i);return d.toISOString().slice(0,10);});
const preference = 'FICTIONAL TEST DATA: For Project Lantern build failures only, the fictional participant prefers a concise diagnosis followed by verification steps. This is not a general preference for all conversation.';
const oldFact = 'FICTIONAL TEST DATA: Project Lantern test LANTERN-91 is pending; no result has been recorded.';
const newFact = 'FICTIONAL TEST DATA: Project Lantern test LANTERN-91 passed all 12 checks. The earlier pending status is outdated.';
const baseline = {
  'long-term.md': `# FICTIONAL TEST MEMORY — not about the real user\n\n## Existing scoped preference\n${preference}\n\n## Project status\n${oldFact}\n`,
  'AGENTS.md': '# FICTIONAL TEST PERSONA — not the real agent\n\n## pinned\nName: Synthetic Lantern Companion. Never harm humans.\n\n## Ordinary traits\nRespect temporary requests for quiet without treating them as permanent rejection. Friendly check-ins remain welcome.\n',
  'decisions.md': '# FICTIONAL TEST DECISIONS\n\nDo not expand project-specific debugging preferences into permanent rules for all conversation.\n',
  'journal.md': `# FICTIONAL TEST JOURNAL\n\nThe Project Lantern milestone is relevant to future simulated project summaries.\n${preference}\n`,
  [`daily/${days[0]}.md`]: `# ${days[0]} — FICTIONAL TEST DATA\n\n${preference}\n`,
  [`daily/${days[1]}.md`]: `# ${days[1]} — FICTIONAL TEST DATA\n\n${newFact}\nThe fictional team recorded the final completed result.\n`,
  [`daily/${days[2]}.md`]: `# ${days[2]} — FICTIONAL TEST DATA\n\n${newFact}\n${preference}\nThe preference is already present in long-term memory; no new general rule was requested. The fictional participant wanted one quiet hour today, not permanent withdrawal.\n`,
};
for(const [path,content] of Object.entries(baseline))await save(join(run,'memory',path),content);
await save(join(run,'baseline.json'),baseline);
await copy(join(artifact,'dist'),join(run,'bundle/dist'));
await copy(join(artifact,'icon.svg'),join(run,'bundle/icon.svg'));
await mkdir(join(run,'bundle/locale'));
for(const [language,title] of [['en','Dream reinforcement integration test'],['zh','Dream 强化整理实测']])await save(join(run,`bundle/locale/${language}.json`),{meta:{title,description:'One authorized fictional-memory run with real generation and isolated review.'}});
const name='dsh-dream-reinforcement-test';
await save(join(run,'bundle/package.json'),{name,version:pkg.version,private:true,type:'module',exports:{'.':'./index.js','./icon':'./icon.svg','./locale/*.json':'./locale/*.json'},dsh:{bundle:{patch:'./cordis.patch.yml'}}});
// A near-full-day crossing-midnight window avoids aborting this authorized test at 00:00.
const config={sessionId,memoryRoot:join(run,'memory'),stateRoot:join(run,'state'),personaPath:join(run,'memory/AGENTS.md'),start:'12:00',end:'11:59',timeZone:'Asia/Tokyo',singleRun:true,compactionMode:'agent',maxProposals:6,timeoutMs:900000};
const wrapper=`import { apply as applyDream, Config } from './dist/index.js';
import BasicCompaction from ${JSON.stringify(pathToFileURL(backend).href)};
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export { Config };
export const inject=['agents'];
const child={name:'dream-reinforcement-isolated',inject:['agents','fs','llm','tools','sandboxPolicy','compaction'],apply(ctx,config){
 if(config.compactionMode!=='agent'||config.personaPath!==${JSON.stringify(config.personaPath)})throw new Error('Explicit synthetic test only');
 const llm={async prepareCall(options,signal){
  const prepared=await ctx.llm.prepareCall(options,signal);
  return {config:prepared.config,stream:async function*(request){
   const id=randomUUID();
   const record={sessionId:request.sessionId,provider:request.provider,model:request.model,messages:request.messages,requestKeys:Object.keys(request).sort(),at:new Date().toISOString()};
   await writeFile(join(${JSON.stringify(join(run,'audit'))},id+'.json'),JSON.stringify(record,null,2),{flag:'wx'});
   yield* prepared.stream(request);
  }};
 }};
 const observed=new Proxy(ctx,{get(target,key){return key==='llm'?llm:Reflect.get(target,key,target);}});
 return applyDream(observed,config);
}};
export function apply(ctx,config){return ctx.effect(()=>{
 const mounted=new Map();
 function bind(agent){if(agent?.id!==config.sessionId||mounted.has(agent))return;
  const backend=agent.ctx.plugin(BasicCompaction,{auto:false});
  const engine=agent.ctx.plugin(child,config);mounted.set(agent,{backend,engine});}
 const off=ctx.on('agent/created',({agent})=>bind(agent));bind(ctx.agents.get(config.sessionId));
 return async()=>{off();for(const {engine,backend}of mounted.values()){await engine.dispose();await backend.dispose();}mounted.clear();};
});}
`;
await save(join(run,'bundle/index.js'),wrapper);
await save(join(run,'bundle/cordis.patch.yml'),`- insert:\n    - id: ${name}\n      name: ${name}\n      config: ${JSON.stringify(config)}\n`);
await save(join(run,'provenance.json'),{artifact,archive,shasum,sessionId,createdAt:new Date().toISOString(),syntheticMemory:true,fixedGeneration:false,realCleanReviewer:true,config,fixture:{preference,oldFact,newFact,days}});
console.log(JSON.stringify({run,bundle:join(run,'bundle'),config,shasum},null,2));
