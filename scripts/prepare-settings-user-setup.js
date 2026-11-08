import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = await mkdtemp(join(resolve(import.meta.dirname, '../tests/.tmp'), 'settings-user-setup-'));
const bundle = join(root, 'bundle'), name = `dsh-dream-user-setup-${randomUUID().slice(0,8)}`;
await mkdir(bundle);
const expected = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : null;
const paths = { memoryRoot: '/Users/zhaoluchen/.dsh/memory', stateRoot: '/Users/zhaoluchen/.dsh/dream-state', personaPath: '/Users/zhaoluchen/.dsh/AGENTS.md' };
const source = `import{writeFile}from'node:fs/promises';import{join}from'node:path';import{createHash}from'node:crypto';
export const inject=['connection','configEditor','fs','agents'];
export function apply(ctx){return ctx.effect(()=>{
 const root=${JSON.stringify(root)},expected=${JSON.stringify(expected)},paths=${JSON.stringify(paths)},hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const fields=['sessionId','memoryRoot','stateRoot','personaPath','start','end','timeZone','compactionMode','dreamMode'];
 const save=(file,value)=>writeFile(join(root,file),JSON.stringify(value,null,2),{flag:'wx'});
 const summarize=view=>({revision:view.revision,writable:view.writable,enabled:view.enabled,configured:view.configured,hostTimeZone:view.hostTimeZone,status:view.status.state,issues:view.issues,values:Object.fromEntries(fields.map(k=>[k,view.config[k]??null])),otherConfigHash:hash(Object.fromEntries(Object.entries(view.config).filter(([k])=>!Object.keys(paths).includes(k)))),sourceSessionCount:view.config.sourceSessionIds?.length??0,originalBindingCount:view.config.originalSources?.length??0});
 let started=false,pending=Promise.resolve();
 async function work(){
  const handler=ctx.connection.createSharedFetchHandler('/api');
  async function post(method,input){const response=await handler.fetch(new Request('http://localhost/api/dsh-dream/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),ctx.connection.browserPeer);const result=await response.json();if(response.status!==200||!result.ok)throw Error(method+': '+result.error?.code+' '+result.error?.message);return result.value;}
  const before=await post('read',{});await save('before.json',summarize(before));
  if(before.enabled)throw Error('Business is enabled; refusing configuration without separate confirmation');
  const details={};
  for(const [key,path]of Object.entries(paths)){const target=await ctx.fs.resolve(path),info=await ctx.fs.stat(target);details[key]={path,type:info?.type??'absent'};}
  const memory=await ctx.fs.resolve(paths.memoryRoot),state=await ctx.fs.resolve(paths.stateRoot);
  if(ctx.fs.contains(memory,state)||ctx.fs.contains(state,memory))throw Error('Memory and working data paths overlap');
  for(const item of ['long-term.md','decisions.md','journal.md','daily','ideas']){const info=await ctx.fs.stat(await ctx.fs.resolve(join(paths.memoryRoot,item)));details[item]={type:info?.type??'absent'};}
  await save('paths.json',details);
  if(details.memoryRoot.type!=='directory'||details.personaPath.type!=='file'||!['absent','directory'].includes(details.stateRoot.type)||['long-term.md','decisions.md','journal.md'].some(k=>details[k].type!=='file')||['daily','ideas'].some(k=>details[k].type!=='directory'))throw Error('Configured paths do not have the expected layout');
  if(!expected)return;
  if(before.revision!==expected.revision)throw Error('Settings changed since inspection; no save attempted');
  const candidate={...before.config,...paths};
  const after=await post('save',{revision:before.revision,enabled:false,config:candidate,confirmScope:true});
  const verified=await post('read',{}),a=summarize(verified),b=summarize(before);
  const changes=Object.keys(paths).filter(k=>before.config[k]!==verified.config[k]).map(field=>({field,before:before.config[field]??null,after:verified.config[field]}));
  if(a.enabled||a.otherConfigHash!==b.otherConfigHash||Object.entries(paths).some(([k,v])=>verified.config[k]!==v))throw Error('Post-save verification did not preserve the authorized configuration');
  let readiness=null;if(verified.config.sessionId)readiness=await post('preflight',{config:verified.config});
  await save('after.json',a);
  await save('verification.json',{state:'completed',changes,enabled:false,configured:verified.configured,missingTarget:!verified.config.sessionId,otherConfigPreserved:true,preflight:readiness,noMemoryContentReads:true,noMemoryWrites:true,noModelCalls:true,noDirectoryCreated:true});
 }
 const off=ctx.on('tools/execute',async(exec,next)=>{if(!started&&exec.name!=='plugin_manager'){started=true;pending=work().catch(error=>save('failure.json',{error:String(error.stack??error)}));}return next();});
 return async()=>{off();await pending;};
});}
`;
await writeFile(join(bundle, 'index.js'), source);
await writeFile(join(bundle, 'package.json'), JSON.stringify({name,version:'0.1.0',private:true,type:'module',exports:{'.':'./index.js'},dsh:{bundle:{patch:'./cordis.patch.yml'}}},null,2));
await writeFile(join(bundle, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`);
await writeFile(join(root,'manifest.json'), JSON.stringify({root,bundle,name,purpose:expected?'Apply explicitly user-authorized paths only, preserve other values and keep business disabled':'Read existing Dream config and stat exact authorized paths without content',metadataException:'One-off internal setup helper; removed after completion'},null,2));
console.log(JSON.stringify({root,bundle,name},null,2));
