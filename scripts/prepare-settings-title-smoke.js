import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = await mkdtemp(join(resolve(import.meta.dirname, '../tests/.tmp'), 'settings-title-host-'));
const bundle = join(root, 'bundle'), name = `dsh-dream-title-smoke-${randomUUID().slice(0,8)}`; await mkdir(bundle);
const expected = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : null;
const code = `import{createHash}from'node:crypto';import{writeFile}from'node:fs/promises';import{join}from'node:path';
export const inject=['configEditor','connection','clientModules'];
export function apply(ctx){return ctx.effect(()=>{
 const root=${JSON.stringify(root)},expected=${JSON.stringify(expected)},hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 let done=false,pending=Promise.resolve();
 async function run(){
  const entry=ctx.configEditor.entries().find(e=>e.options.id==='dsh-dream-configuration'),layer=ctx.configEditor.configuration().find(r=>r.entry===entry);
  if(!entry||!layer)throw Error('Dream configuration owner unavailable');
  const identity={rawHash:hash(entry.options.config),inheritedHash:hash(layer.inherited),enabled:entry.options.config?.enabled===true};
  await writeFile(join(root,'identity.json'),JSON.stringify(identity,null,2),{flag:'wx'});
  if(!expected)return;
  const handler=ctx.connection.createSharedFetchHandler('/api'),start=performance.now();
  const response=await handler.fetch(new Request('http://localhost/api/dsh-dream/read',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),ctx.connection.browserPeer);
  const body=await response.json(),elapsedMs=performance.now()-start,readable=response.status===200&&body.ok===true;
  const view=body.value,selected=view?.sessionOptions?.find(item=>item.id===view.config.sessionId);
  const initialTitleResolved=typeof selected?.title==='string'&&selected.title.trim()!==''&&selected.title!==selected.id;
  const allowed=new Set([view?.config.sessionId,...(view?.config.sourceSessionIds??[])]),onlySavedOptions=Array.isArray(view?.sessionOptions)&&view.sessionOptions.every(item=>allowed.has(item.id));
  const row=ctx.clientModules.graph().entries.find(e=>e.id==='dsh-dream');if(!row)throw Error('Client entry unavailable');
  const served=await ctx.clientModules.fetchBundle(new Request(new URL(row.url,'http://localhost'))),client=await served.text();
  const clientConsumesInitialOptions=client.includes('sessionOptions'),preserved=identity.rawHash===expected.rawHash&&identity.inheritedHash===expected.inheritedHash;
  await writeFile(join(root,'verification.json'),JSON.stringify({state:preserved&&readable&&served.status===200&&initialTitleResolved&&onlySavedOptions&&clientConsumesInitialOptions?'completed':'requires-attention',configPreserved:preserved,enabled:identity.enabled,settingsReadable:readable,initialTitleResolved,onlySavedOptions,initialOptionCount:view?.sessionOptions?.length??0,elapsedMs,servedClientStatus:served.status,clientConsumesInitialOptions,servedSha256:createHash('sha256').update(client).digest('hex'),noSearchEndpointCalled:true,noSettingsWrites:true,noMemoryReads:true,noTranscriptReads:true,noModelCalls:true,noActualTitlesRecorded:true,visualVerified:false},null,2),{flag:'wx'});
 }
 const off=ctx.on('tools/execute',async(exec,next)=>{if(!done&&exec.name!=='plugin_manager'){done=true;pending=run().catch(error=>writeFile(join(root,'failure.json'),JSON.stringify({error:String(error.stack??error)}),{flag:'wx'}));}return next();});
 return async()=>{off();await pending;};
});}
`;
await writeFile(join(bundle, 'index.js'), code);
await writeFile(join(bundle, 'package.json'), JSON.stringify({name,version:'0.1.0',private:true,type:'module',exports:{'.':'./index.js'},dsh:{bundle:{patch:'./cordis.patch.yml'}}},null,2));
await writeFile(join(bundle, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`);
await writeFile(join(root,'manifest.json'), JSON.stringify({root,bundle,name,metadataException:'Disposable internal verification, not a final visible feature',purpose:'Verify settings initial read has the saved target label without dropdown search, title recording or configuration writes'},null,2));
console.log(JSON.stringify({root,bundle,name},null,2));
