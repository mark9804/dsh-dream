// Explicit fixed-input narrative A/B only: no Engine, scheduler, review or memory writes.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const repo = resolve(import.meta.dirname, '..');
const artifact = join(repo, 'tests/.tmp/package-g83CtH/package');
const archive = join(artifact, '../dsh-dream-0.1.0.tgz');
const shasum = '5f8e5a82c043cfeb258e2f5bb5e5b3f5861fb3c9';
assert.equal(createHash('sha1').update(await readFile(archive)).digest('hex'), shasum);
const sessionId = process.argv[2];
assert.ok(sessionId && /^session-[a-z0-9-]+$/.test(sessionId));
const oldRoot = join(repo, 'tests/.tmp/original-recall-live-2026-10-30T16-08-17-057Z');
const oldAudit = join(oldRoot, 'audit/be868b78-be34-467f-adb6-10e69eacb1fe.json');
const oldRequest = JSON.parse(await readFile(oldAudit, 'utf8'));
const oldPrompt = oldRequest.messages[0].content[0].text;
const marker = '\n已核对原文引用的观察：';
const start = oldPrompt.indexOf(marker), end = oldPrompt.indexOf('\n原始素材：', start);
assert.ok(start >= 0 && end > start);
const observations = JSON.parse(oldPrompt.slice(start + marker.length, end));
const sources = JSON.parse(oldPrompt.slice(end + '\n原始素材：'.length));
for (const item of observations.observations) assert.ok(sources.find(s => s.sourceId === item.sourceId)?.content.includes(item.quote));
const { dreamNarrativePrompt, selectDreamFragments } = await import(pathToFileURL(join(artifact, 'dist/dream/narrative.js')));
const fragments = selectDreamFragments(observations.observations, 6);
const newPrompt = dreamNarrativePrompt(fragments, 6);
const run = join(repo, 'tests/.tmp', `narrative-style-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`);
const save = (p, value) => writeFile(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { flag: 'wx' });
async function copy(a, b) {
  const s = await lstat(a); assert.equal(s.isSymbolicLink(), false);
  if (s.isDirectory()) { await mkdir(b); for (const name of await readdir(a)) await copy(join(a, name), join(b, name)); }
  else { assert.ok(s.isFile()); await copyFile(a, b, constants.COPYFILE_EXCL); }
}
await mkdir(run); for (const d of ['bundle', 'calls', 'results']) await mkdir(join(run, d));
await save(join(run, 'old-prompt.txt'), oldPrompt);
await save(join(run, 'new-prompt.txt'), newPrompt);
await save(join(run, 'input.json'), { synthetic: true, oldAudit, sources, observations, fragments });
const previousMemory = {};
for (const name of ['AGENTS.md', 'long-term.md', 'decisions.md', 'journal.md', 'daily/2026-10-31.md', 'ideas/release.md']) previousMemory[name] = createHash('sha256').update(await readFile(join(oldRoot, 'memory', name))).digest('hex');
await save(join(run, 'previous-memory-hashes.json'), { root: join(oldRoot, 'memory'), files: previousMemory });
await save(join(run, 'provenance.json'), { sessionId, artifact, archive, shasum, oldAudit, synthetic: true, memoryApplication: false, totalCalls: 3,
  comparison: 'Old REM prompt+full context versus new quote-only creative prompt; not wording-only. Archived past dream is historical, fresh control uses current route.' });
await copy(join(artifact, 'dist'), join(run, 'bundle/dist')); await copy(join(artifact, 'icon.svg'), join(run, 'bundle/icon.svg'));
await mkdir(join(run, 'bundle/locale'));
for (const [lang, title] of [['en', 'Dream narrative style comparison'], ['zh', 'Dream 梦境风格对照']]) await save(join(run, `bundle/locale/${lang}.json`), { meta: { title, description: 'Three real narrative-only calls on fixed synthetic inputs. No memory changes, no recurring schedule.' } });
const name = 'dsh-dream-narrative-style-test';
await save(join(run, 'bundle/package.json'), { name, version: '0.1.0', private: true, type: 'module', exports: { '.': './index.js', './icon': './icon.svg', './locale/*.json': './locale/*.json' }, dsh: { bundle: { patch: './cordis.patch.yml' } } });
await save(join(run, 'bundle/cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`);
const wrapper = `import {createHostModel} from './dist/harness/model.js';
import {runDreamNarrative} from './dist/dream/narrative.js';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const inject=['agents','llm'];
const root=${JSON.stringify(run)};const sessionId=${JSON.stringify(sessionId)};
const sha=text=>createHash('sha256').update(text).digest('hex');
export function apply(ctx){return ctx.effect(()=>{
 let started=false;const abort=new AbortController();let work=Promise.resolve();
 async function execute(agent){
  const config=agent.session.requestHeader?.()?.config??agent.options;const selected={};
  for(const k of ['provider','model','maxTokens','reasoningEffort','temperature','stop'])if(config?.[k]!==undefined)selected[k]=structuredClone(config[k]);
  if(!selected.provider||!selected.model)throw new Error('Actual target model route unavailable');
  const frozenAgent={session:{id:agent.session.id,requestHeader:()=>({config:structuredClone(selected)})},options:structuredClone(selected)};
  const input=JSON.parse(await readFile(join(root,'input.json'),'utf8'));const oldPrompt=await readFile(join(root,'old-prompt.txt'),'utf8');const newPrompt=await readFile(join(root,'new-prompt.txt'),'utf8');
  await writeFile(join(root,'route.json'),JSON.stringify({selected,sessionId,note:'Only route and public call controls; no parent history/system/tools'},null,2),{flag:'wx'});
  const completed=[];
  for(const label of ['old-control','new-1','new-2']){
   abort.signal.throwIfAborted();const prompt=label==='old-control'?oldPrompt:newPrompt;
   const observed=new Proxy(ctx,{get(target,key){if(key!=='llm')return Reflect.get(target,key,target);return {async prepareCall(options,signal){
    const p=await ctx.llm.prepareCall(options,signal);return {config:p.config,stream:async function*(request){
     const audit={label,at:new Date().toISOString(),sessionId:request.sessionId,requestKeys:Object.keys(request).sort(),provider:request.provider,model:request.model,controls:{},messages:request.messages,promptHash:sha(request.messages[0].content[0].text)};
     for(const k of ['maxTokens','reasoningEffort','temperature','stop'])if(request[k]!==undefined)audit.controls[k]=request[k];
     await writeFile(join(root,'calls',label+'.json'),JSON.stringify(audit,null,2),{flag:'wx'});yield* p.stream(request);
    }};
   }};}});
   const rawModel=createHostModel(observed,frozenAgent,{maxOutputBytes:65536});let raw='';
   const model=async text=>{if(text!==prompt)throw new Error('Frozen narrative prompt changed');raw=await rawModel(text,{signal:abort.signal});await writeFile(join(root,'results',label+'.raw.txt'),raw,{flag:'wx'});return raw;};
   const result=label==='old-control'?JSON.parse(await model(prompt)):await runDreamNarrative(input.fragments,model,{maxOutputBytes:65536,maxProposals:6});
   if(typeof result.dream!=='string'||!result.dream.trim()||!Array.isArray(result.themes))throw new Error('Narrative result malformed');
   await writeFile(join(root,'results',label+'.json'),JSON.stringify({label,result,promptHash:sha(prompt),at:new Date().toISOString()},null,2),{flag:'wx'});
   await writeFile(join(root,'results',label+'.md'),'> Dream content; not factual evidence. Synthetic-input style comparison.\\n\\n'+result.dream+'\\n',{flag:'wx'});
   completed.push(label);await writeFile(join(root,'status.json'),JSON.stringify({state:'running',completed},null,2));
  }
  await writeFile(join(root,'status.json'),JSON.stringify({state:'completed',completed,memoryApplication:false},null,2));
 }
 function bind(agent){if(started||abort.signal.aborted||agent?.id!==sessionId)return;started=true;
  work=execute(agent).catch(async error=>{await writeFile(join(root,'status.json'),JSON.stringify({state:'failed',error:String(error?.message??error)},null,2));ctx.logger?.error(error);});
 }
 const off=ctx.on('agent/created',({agent})=>bind(agent));bind(ctx.agents.get(sessionId));
 return async()=>{off();abort.abort(new Error('Narrative comparison stopped'));await work;};
});}
`;
await save(join(run, 'bundle/index.js'), wrapper);
console.log(JSON.stringify({ run, bundle: join(run, 'bundle'), fragments, oldPromptBytes: Buffer.byteLength(oldPrompt), newPromptBytes: Buffer.byteLength(newPrompt) }, null, 2));
