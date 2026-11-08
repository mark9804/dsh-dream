import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = await mkdtemp(join(resolve(import.meta.dirname, '../tests/.tmp'), 'settings-blank-host-'));
const bundle = join(root, 'bundle'), name = `dsh-dream-blank-smoke-${randomUUID().slice(0,8)}`; await mkdir(bundle);
const expected = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : null;
const code = `import{createHash}from'node:crypto';import{writeFile}from'node:fs/promises';import{join}from'node:path';
export const inject=['configEditor','connection'];
export function apply(ctx){return ctx.effect(()=>{
 const root=${JSON.stringify(root)},expected=${JSON.stringify(expected)},hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 let done=false,pending=Promise.resolve();
 async function run(){
  const entry=ctx.configEditor.entries().find(e=>e.options.id==='dsh-dream-configuration'),layer=ctx.configEditor.configuration().find(r=>r.entry===entry);
  if(!entry||!layer)throw Error('Configuration owner unavailable');
  const identity={rawHash:hash(entry.options.config),inheritedHash:hash(layer.inherited),enabled:entry.options.config?.enabled===true};
  await writeFile(join(root,'identity.json'),JSON.stringify(identity,null,2),{flag:'wx'});
  if(!expected)return;
  const handler=ctx.connection.createSharedFetchHandler('/api'),results=[];
  for(const sessionId of ['session-df94172d-356e-4487-8461-c9334fbb09f8','session-a8d88aaf-8375-4976-8c77-c703ea03672e']){
   const response=await handler.fetch(new Request('http://localhost/api/dsh-dream/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:sessionId})}),ctx.connection.browserPeer);
   const body=await response.json(); if(response.status!==200||!body.ok)throw Error('Directory unavailable');
   results.push({sessionId,returned:body.value.items.some(item=>item.id===sessionId)});
  }
  const preserved=identity.rawHash===expected.rawHash&&identity.inheritedHash===expected.inheritedHash;
  await writeFile(join(root,'verification.json'),JSON.stringify({state:preserved&&results.every(r=>!r.returned)?'completed':'requires-restart',configPreserved:preserved,enabled:identity.enabled,results,noSettingsWrites:true,noSessionBodyReads:true,noModelCalls:true},null,2),{flag:'wx'});
 }
 const off=ctx.on('tools/execute',async(exec,next)=>{if(!done&&exec.name!=='plugin_manager'){done=true;pending=run().catch(error=>writeFile(join(root,'failure.json'),JSON.stringify({error:String(error.stack??error)}),{flag:'wx'}));}return next();});
 return async()=>{off();await pending;};
});}
`;
await writeFile(join(bundle,'index.js'),code);
await writeFile(join(bundle,'package.json'),JSON.stringify({name,version:'0.1.0',private:true,type:'module',exports:{'.':'./index.js'},dsh:{bundle:{patch:'./cordis.patch.yml'}}},null,2));
await writeFile(join(bundle,'cordis.patch.yml'),`- insert:\n    - id: ${name}\n      name: ${name}\n`);
await writeFile(join(root,'manifest.json'),JSON.stringify({root,bundle,name,metadataException:'Disposable bounded verification fixture',purpose:'Hash own settings and query two previously verified blank session IDs; no content or configuration changes'},null,2));
console.log(JSON.stringify({root,bundle,name},null,2));
